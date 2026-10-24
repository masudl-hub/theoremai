import { z } from 'zod';
import type { JsonObject } from '../../kernel/json.ts';
import { defineProtocol, modelOptions } from '../../kernel/protocols/mod.ts';
import type {
  EmbeddingCall,
  EmbeddingModelLimits,
  Protocol,
} from '../../kernel/protocols/protocol.ts';
import type { EmbeddingInput, EmbeddingResult, EmbeddingTask } from '../../kernel/types.ts';

/** What a `geminiEmbeddings` binding sets in `options`. */
export interface GeminiEmbeddingsOptions {
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

function task<T extends string>(value: T, title: string, description: string) {
  return z.literal(value).meta({ title, description });
}

const options: z.ZodType<GeminiEmbeddingsOptions> = z.strictObject({
  // why: Labels and descriptions are Google's own task-type table (ai.google.dev/gemini-api/docs/embeddings), so a studio can show them.
  taskType: z
    .union([
      task(
        'RETRIEVAL_QUERY',
        'Retrieval query',
        'Embeddings optimized for general search queries. Pair with Retrieval document for the documents searched.',
      ),
      task(
        'RETRIEVAL_DOCUMENT',
        'Retrieval document',
        'Embeddings optimized for document search, such as indexing articles, books or web pages.',
      ),
      task(
        'SEMANTIC_SIMILARITY',
        'Semantic similarity',
        'Embeddings optimized to assess text similarity, such as for recommendations or duplicate detection.',
      ),
      task(
        'CLASSIFICATION',
        'Classification',
        'Embeddings optimized to classify texts according to preset labels, such as sentiment or spam.',
      ),
      task(
        'CLUSTERING',
        'Clustering',
        'Embeddings optimized to cluster texts based on their similarities.',
      ),
      task(
        'QUESTION_ANSWERING',
        'Question answering',
        'Embeddings for questions, optimized for finding documents that answer them. Pair with Retrieval document.',
      ),
      task(
        'FACT_VERIFICATION',
        'Fact verification',
        'Embeddings for statements to verify, optimized for retrieving evidence that supports or refutes them. Pair with Retrieval document.',
      ),
      task(
        'CODE_RETRIEVAL_QUERY',
        'Code retrieval query',
        'Embeddings optimized for finding code blocks from natural language queries. Pair with Retrieval document for the code.',
      ),
    ])
    .optional()
    .describe(
      "What the vectors will be used for, so Google tunes them to it. Only gemini-embedding-001 takes it; later models read the request's task from the text. Absent: no tuning.",
    ),
  outputDimensionality: z
    .union([z.literal(768), z.literal(1536), z.literal(3072)])
    .optional()
    .describe(
      'How many numbers each vector holds. A shorter vector is cheaper to store and compare and a little less precise. Absent: the 3072 the model returns.',
    ),
});

/** Models that take the task as `taskType`. Later ones (Gemini Embedding 2 on) refuse the field and read the task from the text. */
const TASK_FIELD_MODELS = /^(gemini-embedding-001|text-embedding-|embedding-)/;

// why: ai.google.dev/gemini-api/docs/embeddings gives 6 images and 1 PDF per input, and duration caps (not counts) for audio and video; a batch of 101 inputs is refused (checked 2026-10-19).
const MULTIMODAL: EmbeddingModelLimits = {
  maxInputs: 100,
  media: [
    { accept: ['image/png', 'image/jpeg'], maxPerInput: 6 },
    { accept: ['application/pdf'], maxPerInput: 1 },
    { accept: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'] },
    { accept: ['video/mp4', 'video/quicktime'] },
  ],
};

const TEXT_ONLY: EmbeddingModelLimits = { maxInputs: 100, media: [] };

const TASK_TYPES = {
  query: 'RETRIEVAL_QUERY',
  document: 'RETRIEVAL_DOCUMENT',
} as const satisfies Record<EmbeddingTask, GeminiEmbeddingsOptions['taskType']>;

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

export const geminiEmbeddings: Protocol<GeminiEmbeddingsOptions> = defineProtocol({
  id: 'geminiEmbeddings',
  name: 'Gemini Embeddings',
  description: "Google's embedding API for text and supported media.",
  endpoints: { embedding: '/models/{apiId}:embedContent' },
  options,
  embeddingLimits: (apiId) => (TASK_FIELD_MODELS.test(apiId) ? TEXT_ONLY : MULTIMODAL),
  // why: Gemini Embedding 2 reads the task from the text and refuses the field; the request's `task` says it.
  refusedOptions: (apiId) => (TASK_FIELD_MODELS.test(apiId) ? [] : ['taskType']),
  create(context) {
    return {
      async embed(request: EmbeddingCall): Promise<EmbeddingResult> {
        const parsed = modelOptions(geminiEmbeddings, context.apiId, request.options);
        const taskField = TASK_FIELD_MODELS.test(context.apiId);
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
