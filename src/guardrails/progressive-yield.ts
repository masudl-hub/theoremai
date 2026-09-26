/**
 * Progressive-yield outbound gate — stream cleared prefixes while holding a
 * lookback window so the canary scan, or the host `egress.enforce` policy when
 * set, can inspect split-token matches before release.
 *
 * @module
 */

import { canaryCarry, canaryHoldFrom } from './canary.ts';
import { canaryHits, runEnforcer } from './egress.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  ResolvedGuardrailPolicy,
} from './types.ts';

/** Default lookback under `egress.enforce`, whose detectors match spans longer than a canary. */
const DEFAULT_HOLDBACK = 256;
const PEM_BEGIN = '-----BEGIN';

export type ProgressiveYieldOk = { blocked: false; emit: string };
export type ProgressiveYieldBlocked = { blocked: true; hits: GuardrailHit[] };
/** Result from scanning a stream fragment: a blocked verdict or text safe to release. */
export type ProgressiveYieldResult = ProgressiveYieldOk | ProgressiveYieldBlocked;

/** Options for an incremental outbound stream gate, including its context and holdback policy. */
export interface ProgressiveYieldGateOptions {
  /** Stage facts handed to `enforce`; also carries the turn canary. */
  context: GuardrailContext;
  /** When set, each step runs this policy on the accumulated window before emit. */
  enforce?: EgressEnforcer;
  /**
   * Lookback in characters (default: `DEFAULT_HOLDBACK` with `enforce`, none
   * without). A tail that could start a canary leak is always held on top.
   */
  holdback?: number;
  /**
   * Text an earlier window of the same canary ended on that could still open a
   * leak (`canaryCarry`). It is scanned in front of this window, never released
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
 * Fixed lookback for the policy's detectors: `holdback`, or `DEFAULT_HOLDBACK`
 * under `enforce`. The canary needs none — `canaryHoldFrom` holds exactly the
 * tail that could start a leak.
 */
function resolveHoldback(options: ProgressiveYieldGateOptions): number {
  return options.holdback ?? (options.enforce ? DEFAULT_HOLDBACK : 0);
}

/** Under `enforce`, an incomplete PEM body stays held until its END line. */
function holdbackForWindow(window: string, base: number): number {
  // Incomplete PEM bodies can be large; do not release past BEGIN until END/flush.
  const begin = window.lastIndexOf(PEM_BEGIN);
  if (begin < 0) return base;
  const fromBegin = window.slice(begin);
  if (/-----END (?:RSA )?PRIVATE KEY-----/.test(fromBegin)) return base;
  return Math.max(base, window.length - begin);
}

/** Creates a progressive gate for outbound stream fragments; flush it when the stream ends. */
function createProgressiveYieldGate(options: ProgressiveYieldGateOptions): ProgressiveYieldGate {
  const { context } = options;
  const baseHoldback = resolveHoldback(options);
  const carry = context.canary ? (options.carry ?? '') : '';
  let accumulated = '';
  let emitted = 0;

  async function scan(window: string): Promise<GuardrailHit[] | null> {
    if (carry) {
      // The carry is canary-only: the host policy judges this window's own text.
      const carried = canaryHits(carry + window, context.canary);
      if (carried.length > 0) {
        return carried;
      }
    }
    if (options.enforce) {
      // Mid-stream the gate can only release or stop: emitted prefixes cannot be
      // rewritten, so `redact` stops here and end-of-attempt egress applies the
      // full verdict. `flag` is advisory and keeps the stream flowing.
      const verdict = await runEnforcer(options.enforce, { text: window }, context);
      if (verdict.action === 'block' || verdict.action === 'redact') {
        return verdict.hits.length > 0
          ? verdict.hits
          : [{ rule: 'egress.blocked', severity: 'high' }];
      }
      // Host enforce is authoritative when present (matches end-of-attempt egress).
      return null;
    }
    // Without a host policy there is no end-of-attempt verdict to defer to, so
    // the gate blocks on the canary alone; the bundled rules run via egress.enforce.
    const hits = canaryHits(window, context.canary);
    return hits.length > 0 ? hits : null;
  }

  async function release(releaseTail: boolean): Promise<ProgressiveYieldResult> {
    const hits = await scan(accumulated);
    if (hits) {
      return { blocked: true, hits };
    }
    if (releaseTail) {
      const emit = accumulated.slice(emitted);
      emitted = accumulated.length;
      return { blocked: false, emit };
    }
    const hold = options.enforce ? holdbackForWindow(accumulated, baseHoldback) : baseHoldback;
    // Until this window releases anything, its opening may continue the carry.
    const lead = emitted === 0 ? carry : '';
    const canaryFrom = context.canary
      ? emitted +
        Math.max(0, canaryHoldFrom(lead + accumulated.slice(emitted), context.canary) - lead.length)
      : accumulated.length;
    const safeEnd = Math.max(emitted, Math.min(accumulated.length - hold, canaryFrom));
    const emit = accumulated.slice(emitted, safeEnd);
    emitted = safeEnd;
    return { blocked: false, emit };
  }

  return {
    async process(fragment: string) {
      if (!fragment) {
        return { blocked: false, emit: '' };
      }
      accumulated += fragment;
      return await release(false);
    },
    async flush() {
      return await release(true);
    },
    accumulated: () => accumulated,
    unreleased: () => accumulated.slice(emitted),
    drainUnreleased() {
      const tail = accumulated.slice(emitted);
      emitted = accumulated.length;
      return tail;
    },
    carryOut: () => (context.canary ? canaryCarry(carry + accumulated, context.canary) : ''),
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
export { createOutboundProgressiveGate, createProgressiveYieldGate, DEFAULT_HOLDBACK };
