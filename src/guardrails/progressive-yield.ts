/**
 * Progressive-yield outbound gate — stream cleared prefixes while holding a
 * lookback window so canary / sensitive / boundary / injection (and optional
 * host `egress.enforce`) can inspect split-token matches before release.
 *
 * @module
 */

import { collectEgressHits, runEnforcer } from './egress.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  GuardrailHit,
  ResolvedGuardrailPolicy,
} from './types.ts';

/** Default lookback for span detectors that are not canary-sized. */
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
  /** Floor for lookback beyond canary overlap (characters). */
  holdback?: number;
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
}

function resolveHoldback(canary: string | undefined, holdback: number | undefined): number {
  const canaryHold = canary ? Math.max(0, canary.length - 1) : 0;
  return Math.max(canaryHold, holdback ?? DEFAULT_HOLDBACK);
}

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
  const baseHoldback = resolveHoldback(context.canary, options.holdback);
  let accumulated = '';
  let emitted = 0;

  async function scan(window: string): Promise<GuardrailHit[] | null> {
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
    const hits = collectEgressHits(window, context.canary);
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
    const hold = holdbackForWindow(accumulated, baseHoldback);
    const safeEnd = Math.max(emitted, accumulated.length - hold);
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
  };
}

/**
 * Shared constructor for runTurn + Live: gate when canary and/or egress.enforce
 * is active. `context.canary` is set only when the profile enabled canary minting.
 */
function createOutboundProgressiveGate(
  policy: ResolvedGuardrailPolicy,
  context: GuardrailContext,
): ProgressiveYieldGate | null {
  const enforce = policy.egress?.enforce;
  if (!enforce && !context.canary) {
    return null;
  }
  return createProgressiveYieldGate({
    context,
    ...(enforce ? { enforce } : {}),
  });
}

export type { ProgressiveYieldGate };
export { createOutboundProgressiveGate, createProgressiveYieldGate, DEFAULT_HOLDBACK };
