import { z } from 'zod';
import type { JsonObject } from '../../kernel/json.ts';
import { defineProtocol } from '../../kernel/protocols/mod.ts';
import type { EmbeddingCall, Protocol } from '../../kernel/protocols/protocol.ts';
import type { EmbeddingInput, EmbeddingResult } from '../../kernel/types.ts';

/** What a `geminiEmbedding` binding sets in `options`. */
export interface GeminiEmbeddingOptions {
  taskType?:
    | 'RETRIEVAL_QUERY'
    | 'RETRIEVAL_DOCUMENT'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION'
    | 'CLUSTERING'
    | 'QUESTION_ANSWERING'
    | 'FACT_VERIFICATION'
    | 'CODE_RETRIEVAL_QUERY';
  outputDimensionality?: 768 | 1536 | 3072;
}

const options: z.ZodType<GeminiEmbeddingOptions> = z.strictObject({
  taskType: z
    .enum([
      'RETRIEVAL_QUERY',
      'RETRIEVAL_DOCUMENT',
      'SEMANTIC_SIMILARITY',
      'CLASSIFICATION',
      'CLUSTERING',
      'QUESTION_ANSWERING',
      'FACT_VERIFICATION',
      'CODE_RETRIEVAL_QUERY',
    ])
    .optional(),
  outputDimensionality: z.union([z.literal(768), z.literal(1536), z.literal(3072)]).optional(),
});

function parts(input: EmbeddingInput): JsonObject[] {
  if (typeof input === 'string') return [{ text: input }];
  return input.parts.map((part): JsonObject => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'media') {
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    }
    return { fileData: { mimeType: part.mimeType, fileUri: part.uri } };
  });
}

function values(row: Record<string, unknown>): number[] {
  const embedding = row.embedding;
  const values =
    embedding && typeof embedding === 'object'
      ? (embedding as Record<string, unknown>).values
      : undefined;
  return Array.isArray(values)
    ? values.filter((value): value is number => typeof value === 'number')
    : [];
}

function requestBody(input: EmbeddingInput, parsed: z.infer<typeof options>): JsonObject {
  const body: JsonObject = {
    content: { parts: parts(input) },
  };
  if (parsed.taskType) body.taskType = parsed.taskType;
  if (parsed.outputDimensionality) body.outputDimensionality = parsed.outputDimensionality;
  return body;
}

export const geminiEmbedding: Protocol<GeminiEmbeddingOptions> = defineProtocol({
  id: 'geminiEmbedding',
  name: 'Gemini Embeddings',
  description: "Google's embedding API for text and supported media.",
  endpoints: { embedding: '/models/{apiId}:embedContent' },
  options,
  create(context) {
    return {
      async embed(request: EmbeddingCall): Promise<EmbeddingResult> {
        const parsed = options.parse(request.options ?? {});
        const inputs = Array.isArray(request.input) ? request.input : [request.input];
        const body: JsonObject =
          inputs.length === 1
            ? requestBody(inputs[0], parsed)
            : {
                requests: inputs.map((input) => ({
                  model: `models/${context.apiId}`,
                  ...requestBody(input, parsed),
                })),
              };
        const path =
          inputs.length === 1
            ? `/models/${encodeURIComponent(context.apiId)}:embedContent`
            : `/models/${encodeURIComponent(context.apiId)}:batchEmbedContents`;
        let row: Record<string, unknown> | undefined;
        for await (const current of context.send(body, { stream: false, path })) row = current;
        const raw = Array.isArray(row?.embeddings)
          ? row.embeddings
          : row?.embedding
            ? [row.embedding]
            : [];
        return {
          model: context.apiId,
          embeddings: raw.map((item, index) => ({
            index,
            values: item && typeof item === 'object' ? values({ embedding: item }) : [],
            dimensions: item && typeof item === 'object' ? values({ embedding: item }).length : 0,
          })),
        };
      },
    };
  },
});
