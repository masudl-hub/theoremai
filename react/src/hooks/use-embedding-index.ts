import type { EmbeddingInput, EmbeddingUsage } from '@theoremjs/agents';
import { useState } from 'react';
import { addUsage, embeddingBatches } from '../client/embedding-input.ts';
import type { EmbeddingInterface, EmbeddingTransport } from '../client/embedding-transport.ts';
import { type OneCallState, useOneCall } from './use-one-call.ts';

/** Documents embedded for search: each one's vector, in the order given. */
export type EmbeddingIndex = {
  inputs: readonly EmbeddingInput[];
  vectors: readonly (readonly number[])[];
  model: string;
  usage?: EmbeddingUsage;
  /** How many requests it took. */
  requests: number;
};

/** How far an indexing has come, in requests. */
export type IndexProgress = { done: number; total: number };

async function indexWith(
  transport: EmbeddingTransport,
  signal: AbortSignal,
  inputs: readonly EmbeddingInput[],
  rules: EmbeddingInterface['inputs'],
  onProgress: (progress: IndexProgress) => void,
): Promise<{ result: EmbeddingIndex }> {
  const batches = embeddingBatches(inputs, rules);
  const vectors: (readonly number[])[] = [];
  let model = '';
  let usage: EmbeddingUsage | undefined;
  onProgress({ done: 0, total: batches.length });
  for (const [at, batch] of batches.entries()) {
    const reply = await transport.embed(batch, { task: 'document' }, signal);
    // why: Each request's records go to the trace as it lands, so a long index shows its calls one by one.
    for (const record of reply.traces ?? []) transport.traces?.push(record);
    vectors.push(...reply.result.embeddings.map((vector) => vector.values));
    model = reply.result.model;
    usage = addUsage(usage, reply.result.usage);
    onProgress({ done: at + 1, total: batches.length });
  }
  return {
    result: {
      inputs,
      vectors,
      model,
      ...(usage ? { usage } : {}),
      requests: batches.length,
    },
  };
}

/**
 * Documents embedded for search with `task: 'document'`, as many requests as
 * the profile's limits need, one after another. A new index aborts the one
 * still running; a request that fails stops it.
 */
export function useEmbeddingIndex(transport: EmbeddingTransport): OneCallState<
  'indexing',
  EmbeddingIndex
> & {
  progress: IndexProgress | null;
  index: (inputs: readonly EmbeddingInput[], rules: EmbeddingInterface['inputs']) => Promise<void>;
  cancel: () => void;
} {
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const { call, ...run } = useOneCall(transport, 'indexing', indexWith);
  return {
    ...run,
    progress: run.status === 'indexing' ? progress : null,
    index: (inputs, rules) => call(inputs, rules, setProgress),
  };
}
