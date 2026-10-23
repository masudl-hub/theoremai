import type { ModelBinding } from '../kernel/protocols/binding.ts';
import type { EmbeddingModelLimits, Protocol } from '../kernel/protocols/protocol.ts';
import { geminiEmbeddings } from './gemini/embeddings-protocol.ts';
import { ollamaEmbeddings } from './local/embeddings-protocol.ts';
import { openRouterEmbeddings } from './openrouter/embeddings-protocol.ts';

const SHIPPED: readonly Protocol[] = [geminiEmbeddings, openRouterEmbeddings, ollamaEmbeddings];

/**
 * What a binding's embedding model takes, read from its protocol: one Theorem ships, or one of
 * `protocols`. Undefined when neither has it, and the kernel then holds requests to the profile alone.
 */
export function embeddingModelLimits(
  binding: Pick<ModelBinding, 'protocol' | 'apiId'>,
  protocols: readonly Protocol[] = [],
): EmbeddingModelLimits | undefined {
  const protocol = [...protocols, ...SHIPPED].find((entry) => entry.id === binding.protocol);
  return protocol?.embeddingLimits?.(binding.apiId);
}
