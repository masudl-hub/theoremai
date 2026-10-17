import type { EmbeddingInput, EmbeddingResult } from '@theoremjs/agents';
import type { EmbeddingInterface, EmbeddingTransport } from '../client/embedding-transport.ts';
import type { ClientFailure } from '../client/failure.ts';
import { useDescribed } from './use-described.ts';
import { type OneCallState, useOneCall } from './use-one-call.ts';

export type TheoremEmbeddingState = {
  /** The profile as the page sees it; null until the host describes it. */
  iface: EmbeddingInterface | null;
  /** Why the host could not describe the profile. */
  describeFailure: ClientFailure | null;
} & OneCallState<'embedding', EmbeddingResult>;

const embedWith = (
  transport: EmbeddingTransport,
  signal: AbortSignal,
  inputs: readonly EmbeddingInput[],
  model?: string,
) => transport.embed(inputs, model, signal);

/**
 * One embedding profile: describe it once, then `embed(inputs)` as often as
 * needed. A new embedding aborts the one still running.
 */
export function useTheoremEmbedding(transport: EmbeddingTransport): TheoremEmbeddingState & {
  embed: (inputs: readonly EmbeddingInput[], model?: string) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const { call, ...run } = useOneCall(transport, 'embedding', embedWith);
  return { iface, describeFailure, ...run, embed: call };
}
