import type { Boundary } from './boundaries.ts';
import {
  canaryOpeningFrom,
  createCanaryScanner,
  promptLeakCarry,
  RELEASED_LOOKBACK,
} from './canary.ts';
import { type Detection, type DetectScope, detectReads } from './detect-at.ts';
import { createDetectStream } from './detect-stream.ts';
import type { DetectAction, ResolvedDetect } from './detectors.ts';
import { promptEchoHits, runEnforcer } from './egress.ts';
import { type EgressStream, type EgressStreamHit, streamPlanOf } from './egress-stream.ts';
import { TheoremError } from './error.ts';
import { CANARY_HIT } from './hits.ts';
import { promptEchoHoldFrom, promptEchoScanFrom } from './prompt-echo.ts';
import { EGRESS_RULES } from './rules.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  ResolvedGuardrailPolicy,
} from './types.ts';

/** Default lookback under a host `egress.enforce` the gate cannot read. */
const DEFAULT_HOLDBACK = 256;
/**
 * Default lookback on Live under a host policy the gate cannot read, where the
 * held transcript holds back audio too: the shortest that shows the host no
 * character of any egress corpus match however the transcript is chunked
 * (88), with a margin.
 */
const LIVE_DEFAULT_HOLDBACK = 96;
const PEM_BEGIN = '-----BEGIN';

/** A reply boundary the gate reads as the reply streams. */
export type ReplyBoundary = Extract<Boundary, 'reply' | 'live_reply'>;

export type ProgressiveYieldOk = {
  blocked: false;
  emit: string;
  /** What `guardrails.detect` reported or replaced in `emit`. */
  found?: Pick<Detection, 'action' | 'hits'>;
};
export type ProgressiveYieldBlocked = {
  blocked: true;
  hits: GuardrailHit[];
  /** Set when a detector stopped the reply: the boundary it was read at. */
  boundary?: ReplyBoundary;
};
/** What one step of the progressive gate returns: the text to emit, or the hits that block the reply. */
export type ProgressiveYieldResult = ProgressiveYieldOk | ProgressiveYieldBlocked;

/** Settings for the progressive gate: the guardrail context, an optional egress policy to enforce on the held window, and the holdback and other lookback it keeps. */
export interface ProgressiveYieldGateOptions {
  /** Also carries the turn canary. */
  context: GuardrailContext;
  /** When set, each step runs this policy on the accumulated window before emit. */
  enforce?: EgressEnforcer;
  /**
   * `guardrails.detect` and the reply boundary this gate stands at. With
   * `rewrite`, a match set to `redact` is replaced as the text is released;
   * without it (Live, where the text is the transcript of audio already held)
   * the gate stops there and the cycle's verdict replaces the reply.
   */
  detect?: { matrix: ResolvedDetect; boundary: ReplyBoundary; rewrite: boolean };
  /**
   * Lookback in characters under an `enforce` the gate cannot read (default
   * `DEFAULT_HOLDBACK`). The bundled policy holds exactly and takes none: it
   * is an error to set one with it. A tail that could start a canary leak is
   * always held on top.
   */
  holdback?: number;
  /**
   * Text an earlier window of the same canary ended on that could still open a
   * leak (`promptLeakCarry`). It is scanned in front of this window, never released
   * again, so a token split across steps or cycles is still one match.
   */
  carry?: string;
}

/**
 * Incremental outbound gate that scans accumulated output and releases only
 * prefixes outside its retained lookback window.
 */
interface ProgressiveYieldGate {
  process: (fragment: string) => Promise<ProgressiveYieldResult>;
  flush: () => Promise<ProgressiveYieldResult>;
  /** Full window inspected so far (for end-of-attempt egress / repair). */
  accumulated: () => string;
  /** Lookback tail not yet released to the host. Peek only. */
  unreleased: () => string;
  /**
   * Take the tail not yet released and mark it released.
   *
   * Used when the runner records withheld text for the egress window: without
   * advancing the cursor a later `flush` re-releases the same range and the
   * attempt buffer ends up holding the text twice.
   */
  drainUnreleased: () => string;
  /** The tail the next window of the same canary must scan in front of its own. */
  carryOut: () => string;
}

/**
 * Fixed lookback for a host policy the gate cannot read: `holdback`, or
 * `DEFAULT_HOLDBACK`. The canary, the prompt echo and the bundled policy need
 * none — each holds exactly the tail that could still start a match.
 */
function resolveHoldback(options: ProgressiveYieldGateOptions, exact: boolean): number {
  if (exact) {
    if (options.holdback !== undefined) {
      throw new TheoremError(
        'config',
        'holdback applies only to a host egress.enforce; the bundled policy holds exactly', // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    return 0;
  }
  return options.holdback ?? (options.enforce ? DEFAULT_HOLDBACK : 0);
}

function holdbackForWindow(window: string, base: number): number {
  // why: Incomplete PEM bodies can be large; do not release past BEGIN until END/flush.
  const begin = window.lastIndexOf(PEM_BEGIN);
  if (begin < 0) return base;
  const fromBegin = window.slice(begin);
  if (/-----END (?:RSA )?PRIVATE KEY-----/.test(fromBegin)) return base;
  return Math.max(base, window.length - begin);
}

/**
 * The verdict for a match the stream settled: the policy's own, run on the
 * window. The stream only ever settles a match the policy finds, so a policy
 * that does not block here is out of step with it: blocked anyway.
 */
async function streamHitVerdict(
  enforce: EgressEnforcer,
  hit: EgressStreamHit,
  window: string,
  context: GuardrailContext,
): Promise<GuardrailHit[]> {
  const verdict = await runEnforcer(enforce, { text: window }, context);
  if ((verdict.action === 'block' || verdict.action === 'redact') && verdict.hits.length > 0) {
    return verdict.hits;
  }
  return [{ rule: hit.rule, severity: hit.severity }];
}

/** Call `flush` when the stream ends to release the held tail. */
function createProgressiveYieldGate(options: ProgressiveYieldGateOptions): ProgressiveYieldGate {
  const { context } = options;
  const stream: EgressStream | undefined = options.enforce
    ? streamPlanOf(options.enforce)?.(context)
    : undefined;
  const reads = options.detect;
  const detecting = reads ? createDetectStream(reads.boundary, reads.matrix) : undefined;
  const baseHoldback = resolveHoldback(options, stream !== undefined);
  /** What a match of one of ours does at this gate's boundary. A gate given no matrix stops on it. */
  const ours = (detector: 'canary_leak' | 'prompt_leak'): DetectAction =>
    reads ? reads.matrix[detector][reads.boundary] : 'block';
  const canaryAction = ours('canary_leak');
  const promptAction = ours('prompt_leak');
  /** The canary a reply must not repeat: none when it was given (`canaryGiven`), or not read here. */
  const token = context.canaryGiven || canaryAction === 'ignore' ? undefined : context.canary;
  /** The private system instruction a reply must not repeat: none when not read here. */
  const privateSystem = promptAction === 'ignore' ? undefined : context.privateSystem;
  const guarded = token !== undefined || privateSystem !== undefined;
  const carry = guarded ? (options.carry ?? '') : '';
  /** The leaks set to `flag` found since the last release, and the rules already reported. */
  let noted: GuardrailHit[] = [];
  const reported = new Set<string>();
  let accumulated = '';
  let emitted = 0;
  /** The window from `emitted` on. Each piece of the reply is kept apart, so no step rereads the whole. */
  let held = '';
  /** The carry and the released window, as far back as the canary hold rereads. */
  let released = carry.slice(-RELEASED_LOOKBACK);
  /** The carry and window from where the next prompt echo scan may reach back to. */
  let echoed = carry;
  /** Where `echoed` starts in the carry and window. */
  let echoedFrom = 0;
  /**
   * The carry and window from `openingBase` on, for the canary hold. No
   * opening of a leak starts before `openingFrom`: a point further back than
   * `RELEASED_LOOKBACK` that does not open one by now never will. So each
   * step reads from there, not the whole held text.
   */
  let opening = carry;
  let openingBase = 0;
  let openingFrom = 0;
  /** Reads the carry, then the window as it grows. */
  const scanner = token ? createCanaryScanner(token) : undefined;
  scanner?.push(carry);

  /**
   * The leaks of what is ours (canary, prompt echo) in the carry and this
   * window that stop the reply. One set to `flag` is noted for the next
   * release instead, once. The canary scan reads each character once
   * (`createCanaryScanner`) and the echo check rereads only its own short
   * lookback (`promptEchoScanFrom`), so a long reply costs time in proportion
   * to its length, not its square.
   */
  function leakStops(fresh: string): GuardrailHit[] {
    const found: [DetectAction, GuardrailHit][] = [];
    if (scanner?.push(fresh)) found.push([canaryAction, CANARY_HIT]);
    if (privateSystem) {
      const scanned = echoed.length;
      echoed += fresh;
      const from = promptEchoScanFrom(echoed, scanned);
      echoed = echoed.slice(from);
      echoedFrom += from;
      const [hit] = promptEchoHits(echoed, privateSystem, context.canary);
      if (hit) found.push([promptAction, hit]);
    }
    for (const [action, hit] of found) {
      if (action !== 'flag' || reported.has(hit.rule)) continue;
      reported.add(hit.rule);
      noted.push(hit);
    }
    return found.filter(([action]) => action !== 'flag').map(([, hit]) => hit);
  }

  /**
   * The host policy's hits on the window. The bundled policy reads only the
   * new fragment (`egress-stream.ts`) and runs whole only when a match
   * settles; a policy the gate cannot read runs whole at every step. At the
   * end (`fragment` unset) every policy runs whole.
   */
  async function policyHits(window: string, fragment?: string): Promise<GuardrailHit[] | null> {
    if (!options.enforce) {
      return null;
    }
    if (stream && fragment !== undefined) {
      const [hit] = stream.push(fragment);
      return hit ? await streamHitVerdict(options.enforce, hit, window, context) : null;
    }
    // why: Mid-stream the gate can only release or stop: emitted prefixes cannot be
    // rewritten, so `redact` stops here and end-of-attempt egress applies the
    // full verdict. `flag` is advisory and keeps the stream flowing.
    const verdict = await runEnforcer(options.enforce, { text: window }, context);
    if (verdict.action === 'block' || verdict.action === 'redact') {
      return verdict.hits.length > 0
        ? verdict.hits
        : [{ rule: EGRESS_RULES.blocked, severity: 'high' }];
    }
    return null;
  }

  /** What stops the reply at this step: a leak of ours, read at the gate's boundary, or the host policy's hits. */
  async function scan(
    window: string,
    fragment?: string,
  ): Promise<Pick<ProgressiveYieldBlocked, 'hits' | 'boundary'> | null> {
    // invariant: The detectors of what is ours run under a host policy too: it adds
    // checks, it never replaces these (the guardrail invariant).
    const leaks = guarded ? leakStops(fragment ?? '') : [];
    if (fragment) detecting?.push(fragment);
    if (leaks.length > 0) {
      return { hits: leaks, ...(reads ? { boundary: reads.boundary } : {}) };
    }
    const hits = await policyHits(window, fragment);
    return hits ? { hits } : null;
  }

  /**
   * Where the leak checks hold from: a canary opening, or words a prompt echo
   * could grow from. A leak set to `flag` holds nothing: it is shown.
   */
  function leakHoldFrom(): number {
    const canary = token && canaryAction !== 'flag' ? canaryFrom(token) : held.length;
    const echo =
      privateSystem && promptAction !== 'flag'
        ? echoHoldFrom(privateSystem, context.canary)
        : held.length;
    return emitted + Math.min(canary, echo);
  }

  /** `result` with the leaks noted since the last release reported in it. */
  function withNoted(result: ProgressiveYieldOk): ProgressiveYieldOk {
    if (noted.length === 0) return result;
    const hits = [...noted, ...(result.found?.hits ?? [])];
    noted = [];
    return { ...result, found: { action: result.found?.action ?? 'flag', hits } };
  }

  /** `canaryHoldFrom` on the held text, read from where an opening could start. */
  function canaryFrom(canary: string): number {
    const shownTo = carry.length + emitted;
    const from = Math.max(shownTo, openingFrom);
    const lead = Math.max(openingBase, from - RELEASED_LOOKBACK);
    let at = lead + canaryOpeningFrom(opening.slice(lead - openingBase), canary);
    if (at < from && from > shownTo) {
      // why: An opening the bound rules out: read the held text whole, and from there on.
      opening = released + held;
      openingBase = shownTo - released.length;
      at = openingBase + canaryOpeningFrom(opening, canary);
    }
    openingFrom = Math.min(at, carry.length + accumulated.length - RELEASED_LOOKBACK);
    const base = Math.max(openingBase, Math.max(shownTo, openingFrom) - RELEASED_LOOKBACK);
    opening = opening.slice(base - openingBase);
    openingBase = base;
    return Math.max(0, at - shownTo);
  }

  /** `promptEchoHoldFrom` on the held text, read from its last few words. */
  function echoHoldFrom(privateSystem: readonly string[], canary?: string): number {
    // why: Until this window releases anything, its opening may continue the carry.
    const lead = emitted === 0 ? carry : '';
    const leadFrom = carry.length + emitted - lead.length;
    const [text, from] = echoedFrom >= leadFrom ? [echoed, echoedFrom] : [lead + held, leadFrom];
    return Math.max(
      0,
      from + promptEchoHoldFrom(text, privateSystem, canary) - carry.length - emitted,
    );
  }

  /** Where the host policy holds from: exactly for the bundled one, a fixed lookback otherwise. */
  function policyHoldFrom(): number {
    if (stream) {
      return stream.holdFrom();
    }
    const hold = options.enforce ? holdbackForWindow(accumulated, baseHoldback) : baseHoldback;
    return accumulated.length - hold;
  }

  async function release(fragment?: string): Promise<ProgressiveYieldResult> {
    const stop = await scan(accumulated, fragment);
    if (stop) {
      return { blocked: true, ...stop };
    }
    const ended = fragment === undefined;
    const end = ended
      ? accumulated.length
      : Math.min(leakHoldFrom(), policyHoldFrom(), detecting?.holdFrom() ?? accumulated.length);
    const length = Math.max(0, end - emitted);
    if (!(reads && detecting)) {
      return withNoted({ blocked: false, emit: take(length) });
    }
    const read = detecting.take(emitted, emitted + length, ended);
    if (read.action === 'block' || (read.action === 'redact' && !reads.rewrite)) {
      return { blocked: true, hits: read.hits, boundary: reads.boundary };
    }
    take(read.taken);
    return withNoted({
      blocked: false,
      emit: read.text ?? '',
      ...(read.action === 'allow' ? {} : { found: { action: read.action, hits: read.hits } }),
    });
  }

  /** Release the first `length` characters held, as written. */
  function take(length: number): string {
    const emit = held.slice(0, length);
    held = held.slice(length);
    emitted += emit.length;
    if (guarded) released = (released + emit).slice(-RELEASED_LOOKBACK);
    return emit;
  }

  return {
    async process(fragment: string) {
      if (!fragment) {
        return { blocked: false, emit: '' };
      }
      accumulated += fragment;
      held += fragment;
      if (guarded) opening += fragment;
      return await release(fragment);
    },
    async flush() {
      return await release();
    },
    accumulated: () => accumulated,
    unreleased: () => held,
    drainUnreleased: () => take(held.length),
    carryOut: () => (guarded ? promptLeakCarry(carry + accumulated, token, privateSystem) : ''),
  };
}

/**
 * Whether a reply read at `boundaries` gets a verdict once it has ended: a
 * host policy runs, or a detector reads one of them. A gate that stops such a
 * reply withholds it for that verdict.
 */
function replyIsJudged(
  policy: ResolvedGuardrailPolicy,
  boundaries: readonly Boundary[],
  scope?: DetectScope,
): boolean {
  return policy.egress?.enforce !== undefined || detectReads(boundaries, policy.detect, scope);
}

/**
 * Shared constructor for runTurn + Live: a gate when `egress.enforce` runs or a
 * detector reads `boundary`. `context.canary` is set only while `canary_leak`
 * is above `ignore` somewhere, and `context.privateSystem` while `prompt_leak` is.
 */
function createOutboundProgressiveGate(
  policy: ResolvedGuardrailPolicy,
  context: GuardrailContext,
  boundary: ReplyBoundary,
  carry?: string,
): ProgressiveYieldGate | null {
  const egress = policy.egress;
  if (!replyIsJudged(policy, [boundary], context)) {
    return null;
  }
  return createProgressiveYieldGate({
    context,
    detect: { matrix: policy.detect, boundary, rewrite: boundary === 'reply' },
    ...(egress?.enforce ? { enforce: egress.enforce } : {}),
    ...(egress?.holdback === undefined ? {} : { holdback: egress.holdback }),
    ...(carry ? { carry } : {}),
  });
}

export type { ProgressiveYieldGate };
export {
  createOutboundProgressiveGate,
  createProgressiveYieldGate,
  DEFAULT_HOLDBACK,
  LIVE_DEFAULT_HOLDBACK,
  replyIsJudged,
};
