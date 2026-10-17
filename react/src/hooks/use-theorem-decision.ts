import type { DecisionJson, DecisionResult } from '@theoremjs/agents';
import type { DecisionInterface, DecisionTransport } from '../client/decision-transport.ts';
import type { ClientFailure } from '../client/failure.ts';
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
) => transport.decide(state, signal);

/**
 * One decision profile: describe it once, then `decide(state)` as often as
 * needed. A new decision aborts the one still running.
 */
export function useTheoremDecision(transport: DecisionTransport): TheoremDecisionState & {
  decide: (state: Exclude<DecisionJson, null>) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const { call, ...run } = useOneCall(transport, 'deciding', decideWith);
  return { iface, describeFailure, ...run, decide: call };
}
