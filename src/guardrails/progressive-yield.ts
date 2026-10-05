import {
  canaryOpeningFrom,
  createCanaryScanner,
  promptLeakCarry,
  RELEASED_LOOKBACK,
} from './canary.ts';
import { CANARY_HIT, promptEchoHits, runEnforcer } from './egress.ts';
import { type EgressStream, type EgressStreamHit, streamPlanOf } from './egress-stream.ts';
import { TheoremError } from './error.ts';
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

export type ProgressiveYieldOk = { blocked: false; emit: string };
export type ProgressiveYieldBlocked = { blocked: true; hits: GuardrailHit[] };
/** What one step of the progressive gate returns: the text to emit, or the hits that block the reply. */
export type ProgressiveYieldResult = ProgressiveYieldOk | ProgressiveYieldBlocked;

/** Settings for the progressive gate: the guardrail context, an optional egress policy to enforce on the held window, and the holdback and other lookback it keeps. */
export interface ProgressiveYieldGateOptions {
  /** Also carries the turn canary. */
  context: GuardrailContext;
  /** When set, each step runs this policy on the accumulated window before emit. */
  enforce?: EgressEnforcer;
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
  // Incomplete PEM bodies can be large; do not release past BEGIN until END/flush.
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
  const baseHoldback = resolveHoldback(options, stream !== undefined);
  const carry = context.canary ? (options.carry ?? '') : '';
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
  /** The canary a reply must not repeat: none when it was given (`canaryGiven`). */
  const token = context.canaryGiven ? undefined : context.canary;
  /** Reads the carry, then the window as it grows. */
  const scanner = token ? createCanaryScanner(token) : undefined;
  scanner?.push(carry);

  /**
   * The system-prompt leak hits (canary, prompt echo) in the carry and this
   * window. The canary scan reads each character once (`createCanaryScanner`)
   * and the echo check rereads only its own short lookback
   * (`promptEchoScanFrom`), so a long reply costs time in proportion to its
   * length, not its square.
   */
  function canaryWindowHits(fresh: string): GuardrailHit[] {
    const scanned = echoed.length;
    echoed += fresh;
    const from = promptEchoScanFrom(echoed, scanned);
    echoed = echoed.slice(from);
    echoedFrom += from;
    return [
      ...(scanner?.push(fresh) ? [CANARY_HIT] : []),
      ...(context.privateSystem
        ? promptEchoHits(echoed, context.privateSystem, context.canary)
        : []),
    ];
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
      const hit = stream.push(fragment);
      return hit ? await streamHitVerdict(options.enforce, hit, window, context) : null;
    }
    // Mid-stream the gate can only release or stop: emitted prefixes cannot be
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

  async function scan(window: string, fragment?: string): Promise<GuardrailHit[] | null> {
    // The system-prompt leak checks always run, under a host policy too: it adds
    // checks, it never replaces these (the guardrail invariant).
    const leaks = context.canary ? canaryWindowHits(fragment ?? '') : [];
    if (leaks.length > 0) {
      return leaks;
    }
    return await policyHits(window, fragment);
  }

  /** Where the leak checks hold from: a canary opening, or words a prompt echo could grow from. */
  function leakHoldFrom(): number {
    if (!context.canary) {
      return accumulated.length;
    }
    const echo = context.privateSystem
      ? echoHoldFrom(context.privateSystem, context.canary)
      : held.length;
    return emitted + Math.min(token ? canaryFrom(token) : held.length, echo);
  }

  /** `canaryHoldFrom` on the held text, read from where an opening could start. */
  function canaryFrom(canary: string): number {
    const shownTo = carry.length + emitted;
    const from = Math.max(shownTo, openingFrom);
    const lead = Math.max(openingBase, from - RELEASED_LOOKBACK);
    let at = lead + canaryOpeningFrom(opening.slice(lead - openingBase), canary);
    if (at < from && from > shownTo) {
      // An opening the bound rules out: read the held text whole, and from there on.
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
    // Until this window releases anything, its opening may continue the carry.
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
    const hits = await scan(accumulated, fragment);
    if (hits) {
      return { blocked: true, hits };
    }
    const end =
      fragment === undefined ? accumulated.length : Math.min(leakHoldFrom(), policyHoldFrom());
    const emit = take(Math.max(0, end - emitted));
    return { blocked: false, emit };
  }

  /** Release the first `length` characters held. */
  function take(length: number): string {
    const emit = held.slice(0, length);
    held = held.slice(length);
    emitted += emit.length;
    if (context.canary) released = (released + emit).slice(-RELEASED_LOOKBACK);
    return emit;
  }

  return {
    async process(fragment: string) {
      if (!fragment) {
        return { blocked: false, emit: '' };
      }
      accumulated += fragment;
      held += fragment;
      if (context.canary) opening += fragment;
      return await release(fragment);
    },
    async flush() {
      return await release();
    },
    accumulated: () => accumulated,
    unreleased: () => held,
    drainUnreleased: () => take(held.length),
    carryOut: () =>
      context.canary
        ? promptLeakCarry(carry + accumulated, context.canary, context.privateSystem)
        : '',
  };
}

/**
 * Shared constructor for runTurn + Live: gate when canary and/or egress.enforce
 * is active. `context.canary` is set only when the profile enabled canary minting.
 */
function createOutboundProgressiveGate(
  policy: ResolvedGuardrailPolicy,
  context: GuardrailContext,
  carry?: string,
): ProgressiveYieldGate | null {
  const egress = policy.egress;
  if (!egress?.enforce && !context.canary) {
    return null;
  }
  return createProgressiveYieldGate({
    context,
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
};
