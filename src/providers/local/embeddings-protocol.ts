import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { defineProtocol, type EmbeddingCall, type Protocol } from '../../kernel/protocols/mod.ts';
import type { EmbeddingInput, EmbeddingResult } from '../../kernel/types.ts';

/** What an `ollamaEmbeddings` binding sets in `options`. */
export interface OllamaEmbeddingsOptions {
  truncate?: boolean;
  dimensions?: number;
}

const options: z.ZodType<OllamaEmbeddingsOptions> = z.strictObject({
  truncate: z
    .boolean()
    .optional()
    .describe(
      'What happens to an input longer than the model reads. On, it is cut to fit; off, the call fails. Absent: Ollama cuts it.',
    ),
  dimensions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'How many numbers each vector holds, for models that can shorten theirs. Absent: the length the model returns.',
    ),
});

function strings(input: EmbeddingCall['input']): string[] {
  const values = Array.isArray(input) ? input : [input];
  return values.map((item: EmbeddingInput) => {
    if (typeof item === 'string') return item;
    if (item.parts.length !== 1 || item.parts[0]?.type !== 'text')
      throw new TheoremError('unsupported', 'The Ollama embedding protocol accepts text only');
    return item.parts[0].text;
  });
}

export const ollamaEmbeddings: Protocol<OllamaEmbeddingsOptions> = defineProtocol({
  id: 'ollamaEmbeddings',
  name: 'Ollama Embeddings',
  description: 'Ollama’s local embedding endpoint.',
  endpoints: { embedding: '/api/embed' },
  operationNames: { embedding: 'embeddings' },
  options,
  embeddingLimits: () => ({ media: [] }),
  create(context) {
    return {
      async embed(request) {
        const parsed = options.parse(request.options ?? {});
        const rows = context.send(
          {
            model: context.apiId,
            input: strings(request.input),
            ...(parsed.truncate === undefined ? {} : { truncate: parsed.truncate }),
            ...(parsed.dimensions === undefined ? {} : { dimensions: parsed.dimensions }),
          },
          { stream: false },
        );
        let row: Record<string, unknown> | undefined;
        for await (const current of rows) row = current;
        const embeddings = Array.isArray(row?.embeddings) ? row.embeddings : [];
        return {
          model: typeof row?.model === 'string' ? row.model : context.apiId,
          embeddings: embeddings.map((values, index) => ({
            index,
            values: Array.isArray(values)
              ? values.filter((value): value is number => typeof value === 'number')
              : [],
            dimensions: Array.isArray(values) ? values.length : 0,
          })),
        } satisfies EmbeddingResult;
      },
    };
  },
});
