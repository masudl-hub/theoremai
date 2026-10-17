import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import type { JsonObject } from '../../kernel/json.ts';
import { defineProtocol } from '../../kernel/protocols/mod.ts';
import type { EmbeddingCall, Protocol } from '../../kernel/protocols/protocol.ts';
import type { EmbeddingInput, EmbeddingResult, EmbeddingTask } from '../../kernel/types.ts';

/** What a `geminiEmbedding` binding sets in `options`. */
export interface GeminiEmbeddingOptions {
  /** For `gemini-embedding-001`; Gemini Embedding 2 refuses it and reads the request's `task` from the text. */
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

/** Models that take the task as `taskType`. Later ones (Gemini Embedding 2 on) refuse the field and read the task from the text. */
const TASK_FIELD_MODELS = /^(gemini-embedding-001|text-embedding-|embedding-)/;

const TASK_TYPES = {
  query: 'RETRIEVAL_QUERY',
  document: 'RETRIEVAL_DOCUMENT',
} as const satisfies Record<EmbeddingTask, GeminiEmbeddingOptions['taskType']>;

// why: The formats Google gives for Gemini Embedding 2 search (ai.google.dev/gemini-api/docs/embeddings); it advises leaving input with media unprefixed.
function withTask(text: string, task: EmbeddingTask): string {
  return task === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
}

function parts(input: EmbeddingInput, task: EmbeddingTask | undefined): JsonObject[] {
  const list = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input.parts;
  const textOnly = list.every((part) => part.type === 'text');
  return list.map((part, at): JsonObject => {
    if (part.type === 'text')
      return { text: task && textOnly && at === 0 ? withTask(part.text, task) : part.text };
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

type Shape = { taskField: boolean; task?: EmbeddingTask };

function requestBody(
  input: EmbeddingInput,
  parsed: z.infer<typeof options>,
  shape: Shape,
): JsonObject {
  const body: JsonObject = {
    content: { parts: parts(input, shape.taskField ? undefined : shape.task) },
  };
  const taskType = shape.taskField && shape.task ? TASK_TYPES[shape.task] : parsed.taskType;
  if (taskType) body.taskType = taskType;
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
        const taskField = TASK_FIELD_MODELS.test(context.apiId);
        if (!taskField && parsed.taskType)
          throw new TheoremError(
            'config',
            `${context.apiId} takes no taskType; send the request's task instead`, // labels-exempt: builder config error
          );
        const shape: Shape = { taskField, ...(request.task ? { task: request.task } : {}) };
        const inputs = Array.isArray(request.input) ? request.input : [request.input];
        const body: JsonObject =
          inputs.length === 1
            ? requestBody(inputs[0], parsed, shape)
            : {
                requests: inputs.map((input) => ({
                  model: `models/${context.apiId}`,
                  ...requestBody(input, parsed, shape),
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
