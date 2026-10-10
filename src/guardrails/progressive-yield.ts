import type { Boundary } from './boundaries.ts';
import {
  canaryOpeningFrom,
  createCanaryScanner,
  promptLeakCarry,
  RELEASED_LOOKBACK,
} from './canary.ts';
import { type Detection, type DetectScope, detectReads, scopeOf } from './detect-at.ts';
import { createDetectStream } from './detect-stream.ts';
import type { DetectAction, ResolvedDetect } from './detectors.ts';
import { promptEchoHits } from './egress.ts';
import { CANARY_HIT } from './hits.ts';
import { promptEchoHoldFrom, promptEchoScanFrom } from './prompt-echo.ts';
import type { GuardrailContext, GuardrailHit, ResolvedGuardrailPolicy } from './types.ts';

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

/** Settings for the progressive gate: the guardrail context, the detectors it reads with, and the carry from the window before. */
export interface ProgressiveYieldGateOptions {
  /** Also carries the turn canary. */
  context: GuardrailContext;
  /**
   * `guardrails.detect` and the reply boundary this gate stands at. With
   * `rewrite`, a match set to `redact` is replaced as the text is released;
   * without it (Live, where the text is the transcript of audio already held)
   * the gate stops there and the cycle's verdict replaces the reply.
   */
  detect?: {
    matrix: ResolvedDetect;
    boundary: ReplyBoundary;
    rewrite: boolean;
    /** What the detectors read against (`scopeOf`). Left out, the URL and marker detectors read with none. */
    scope?: DetectScope;
  };
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
  process: (fragment: string) => ProgressiveYieldResult;
  flush: () => ProgressiveYieldResult;
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

/** Call `flush` when the stream ends to release the held tail. */
function createProgressiveYieldGate(options: ProgressiveYieldGateOptions): ProgressiveYieldGate {
  const { context } = options;
  const reads = options.detect;
  const detecting = reads
    ? createDetectStream(reads.boundary, reads.matrix, reads.scope)
    : undefined;
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

  /** What stops the reply at this step: a leak of ours, read at the gate's boundary. */
  function scan(fragment?: string): Pick<ProgressiveYieldBlocked, 'hits' | 'boundary'> | null {
    const leaks = guarded ? leakStops(fragment ?? '') : [];
    if (fragment) detecting?.push(fragment);
    if (leaks.length === 0) return null;
    return { hits: leaks, ...(reads ? { boundary: reads.boundary } : {}) };
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

  function release(fragment?: string): ProgressiveYieldResult {
    const stop = scan(fragment);
    if (stop) {
      return { blocked: true, ...stop };
    }
    const ended = fragment === undefined;
    const end = ended
      ? accumulated.length
      : Math.min(leakHoldFrom(), detecting?.holdFrom() ?? accumulated.length);
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
    process(fragment: string) {
      if (!fragment) {
        return { blocked: false, emit: '' };
      }
      accumulated += fragment;
      held += fragment;
      if (guarded) opening += fragment;
      return release(fragment);
    },
    flush: () => release(),
    accumulated: () => accumulated,
    unreleased: () => held,
    drainUnreleased: () => take(held.length),
    carryOut: () => (guarded ? promptLeakCarry(carry + accumulated, token, privateSystem) : ''),
  };
}

/**
 * Whether a reply read at `boundaries` gets a verdict once it has ended: a
 * detector reads one of them. A gate that stops such a reply withholds it for
 * that verdict.
 */
function replyIsJudged(
  policy: ResolvedGuardrailPolicy,
  boundaries: readonly Boundary[],
  scope?: DetectScope,
): boolean {
  return detectReads(boundaries, policy.detect, scope);
}

/**
 * Shared constructor for runTurn + Live: a gate when a detector reads
 * `boundary`. `context.canary` is set only while `canary_leak` is above
 * `ignore` somewhere, and `context.privateSystem` while `prompt_leak` is.
 */
function createOutboundProgressiveGate(
  policy: ResolvedGuardrailPolicy,
  context: GuardrailContext,
  boundary: ReplyBoundary,
  carry?: string,
): ProgressiveYieldGate | null {
  if (!replyIsJudged(policy, [boundary], context)) {
    return null;
  }
  return createProgressiveYieldGate({
    context,
    detect: {
      matrix: policy.detect,
      boundary,
      rewrite: boundary === 'reply',
      scope: scopeOf(policy, context),
    },
    ...(carry ? { carry } : {}),
  });
}

export type { ProgressiveYieldGate };
export { createOutboundProgressiveGate, createProgressiveYieldGate, replyIsJudged };
