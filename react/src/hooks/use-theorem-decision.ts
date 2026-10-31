import type { DecisionAsset, DecisionJson } from '@theoremjs/agents';
import type {
  ClientFailure,
  DecisionInterface,
  DecisionReplyResult,
  DecisionTransport,
} from '@theoremjs/web/client';
import { useDescribed } from './use-described.ts';
import { type OneCallState, useOneCall } from './use-one-call.ts';

export type TheoremDecisionState = {
  /** The profile as the page sees it; null until the host describes it. */
  iface: DecisionInterface | null;
  /** Why the host could not describe the profile. */
  describeFailure: ClientFailure | null;
} & OneCallState<'deciding', DecisionReplyResult>;

const decideWith = (
  transport: DecisionTransport,
  signal: AbortSignal,
  state: Exclude<DecisionJson, null>,
  assets?: Record<string, DecisionAsset>,
  input?: unknown,
) => transport.decide(state, signal, assets, input);

/**
 * One decision profile: describe it once, then `decide(state)` as often as
 * needed. A new decision aborts the one still running. When the host builds its
 * questions for each decision, `input` is what its builder takes (`iface.build.input`).
 */
export function useTheoremDecision(transport: DecisionTransport): TheoremDecisionState & {
  decide: (
    state: Exclude<DecisionJson, null>,
    assets?: Record<string, DecisionAsset>,
    input?: unknown,
  ) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const { call, ...run } = useOneCall(transport, 'deciding', decideWith);
  return { iface, describeFailure, ...run, decide: call };
}
