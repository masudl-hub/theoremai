/**
 * Progressive-yield outbound gate — stream cleared prefixes while holding a
 * lookback window so canary / sensitive / boundary / injection (and optional
 * host `egress.enforce`) can inspect split-token matches before release.
 *
 * @module
 */

import type { EgressContext, EgressEnforcementResult, Profile } from '../kernel/types.ts';
import { collectEgressHits } from './egress.ts';

/** Default lookback for span detectors that are not canary-sized. */
const DEFAULT_HOLDBACK = 256;
const PEM_BEGIN = '-----BEGIN';

type ProgressiveYieldOk = { blocked: false; emit: string };
type ProgressiveYieldBlocked = { blocked: true; hits: string[] };
type ProgressiveYieldResult = ProgressiveYieldOk | ProgressiveYieldBlocked;

type ProgressiveYieldEnforce = (
  context: EgressContext,
) => EgressEnforcementResult | Promise<EgressEnforcementResult>;

interface ProgressiveYieldGateOptions {
  canary?: string;
  profile?: Profile;
  /** When set, each step runs this policy on the accumulated window before emit. */
  enforce?: ProgressiveYieldEnforce;
  /** Floor for lookback beyond canary overlap (characters). */
  holdback?: number;
}

interface ProgressiveYieldGate {
  process: (fragment: string) => Promise<ProgressiveYieldResult>;
  flush: () => Promise<ProgressiveYieldResult>;
  /** Full window inspected so far (for end-of-attempt egress / repair). */
  accumulated: () => string;
  /** Lookback tail not yet released to the host. */
  unreleased: () => string;
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

function createProgressiveYieldGate(
  options: ProgressiveYieldGateOptions = {},
): ProgressiveYieldGate {
  const baseHoldback = resolveHoldback(options.canary, options.holdback);
  let accumulated = '';
  let emitted = 0;

  async function scan(window: string): Promise<string[] | null> {
    if (options.enforce) {
      if (!options.profile) {
        throw new Error('progressive yield enforce requires profile');
      }
      const result = await options.enforce({
        text: window,
        canary: options.canary,
        profile: options.profile,
      });
      if (result.blocked) {
        return result.hits?.length ? result.hits : ['egress'];
      }
      // Host enforce is authoritative when present (matches end-of-attempt egress).
      return null;
    }
    const hits = collectEgressHits(window, options.canary);
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
  };
}

/**
 * Shared constructor for runTurn + Live: gate when canary and/or egress.enforce
 * is active. Pass `canary` only when the profile actually enabled canary minting.
 */
function createOutboundProgressiveGate(
  profile: Profile,
  canary?: string,
): ProgressiveYieldGate | null {
  const enforce = profile.guardrails?.egress?.enforce;
  if (!enforce && !canary) {
    return null;
  }
  return createProgressiveYieldGate({
    canary,
    profile,
    ...(enforce ? { enforce } : {}),
  });
}

export type { ProgressiveYieldGate, ProgressiveYieldGateOptions, ProgressiveYieldResult };
export { createOutboundProgressiveGate, createProgressiveYieldGate, DEFAULT_HOLDBACK };
