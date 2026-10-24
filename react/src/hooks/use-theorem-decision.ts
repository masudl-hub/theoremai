import type { DecisionAsset, DecisionJson, DecisionResult } from '@theoremjs/agents';
import type { ClientFailure, DecisionInterface, DecisionTransport } from '@theoremjs/web/client';
import { useDescribed } from './use-described.ts';
import { type OneCallState, useOneCall } from './use-one-call.ts';

export type TheoremDecisionState = {
  /** The profile as the page sees it; null until the host describes it. */
  iface: DecisionInterface | null;
  /** Why the host could not describe the profile. */
  describeFailure: ClientFailure | null;
} & OneCallState<'deciding', DecisionResult>;

const decideWith = (
  transport: DecisionTransport,
  signal: AbortSignal,
  state: Exclude<DecisionJson, null>,
  assets?: Record<string, DecisionAsset>,
) => transport.decide(state, signal, assets);

/**
 * One decision profile: describe it once, then `decide(state)` as often as
 * needed. A new decision aborts the one still running.
 */
export function useTheoremDecision(transport: DecisionTransport): TheoremDecisionState & {
  decide: (
    state: Exclude<DecisionJson, null>,
    assets?: Record<string, DecisionAsset>,
  ) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const { call, ...run } = useOneCall(transport, 'deciding', decideWith);
  return { iface, describeFailure, ...run, decide: call };
}
