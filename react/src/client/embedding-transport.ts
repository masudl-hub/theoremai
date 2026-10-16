import {
  type EmbeddingInput,
  type EmbeddingProfile,
  type EmbeddingResult,
  resolveObservabilityPolicy,
  type TraceRecord,
  traceRecordSchema,
  z,
} from '@theoremjs/agents';
import { failedTraces, withFailedTraces } from './decision-transport.ts';
import { createTraceFeed, type TraceFeed } from './trace-feed.ts';
import { fetchJson, type HttpOptions } from './transport.ts';
import { checkWire } from './wire-line.ts';

export type EmbeddingInterface = {
  type: 'embedding';
  identity: { handle: string };
  inputs: {
    text: boolean;
    attachments?: { accept: string[] };
    maxFiles?: number;
    maxBytes?: number;
    maxTurnBytes?: number;
  };
  observability?: { record: boolean };
};

export function embeddingInterface(
  profile: Pick<EmbeddingProfile, 'identity' | 'inputs' | 'observability'>,
): EmbeddingInterface {
  return {
    type: 'embedding',
    identity: { handle: profile.identity.handle },
    inputs: {
      text: profile.inputs.text !== false,
      ...(profile.inputs.attachments
        ? { attachments: { accept: [...profile.inputs.attachments.accept] } }
        : {}),
      ...(profile.inputs.maxFiles === undefined ? {} : { maxFiles: profile.inputs.maxFiles }),
      ...(profile.inputs.maxBytes === undefined ? {} : { maxBytes: profile.inputs.maxBytes }),
      ...(profile.inputs.maxTurnBytes === undefined
        ? {}
        : { maxTurnBytes: profile.inputs.maxTurnBytes }),
    },
    ...(profile.observability
      ? { observability: { record: resolveObservabilityPolicy(profile.observability).record } }
      : {}),
  };
}

export type EmbeddingReply = { result: EmbeddingResult; traces?: TraceRecord[] };

export interface EmbeddingTransport {
  describe(signal?: AbortSignal): Promise<EmbeddingInterface>;
  embed(
    input: EmbeddingInput | readonly EmbeddingInput[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingReply>;
  traces?: TraceFeed;
}

const embeddingReplySchema = z.object({
  result: z.object({
    model: z.string().min(1),
    embeddings: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          values: z.array(z.number()),
          dimensions: z.number().int().positive(),
        })
        .refine(
          (embedding) => embedding.values.length === embedding.dimensions,
          'vector length must match dimensions', // labels-exempt: internal diagnostic; the user reads error.bad_response
        ),
    ),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
        estimated: z.literal(true).optional(),
      })
      .optional(),
  }),
  traces: z.array(traceRecordSchema).optional(),
});

const describedSchema = z.object({
  interface: z.object({
    type: z.literal('embedding'),
    identity: z.object({ handle: z.string() }),
    inputs: z.object({
      text: z.boolean(),
      attachments: z.object({ accept: z.array(z.string()) }).optional(),
      maxFiles: z.number().optional(),
      maxBytes: z.number().optional(),
      maxTurnBytes: z.number().optional(),
    }),
    observability: z.object({ record: z.boolean() }).optional(),
  }),
});

export function readEmbeddingReply(raw: unknown): EmbeddingReply {
  return checkWire(embeddingReplySchema, raw, 'the embedding');
}

export function createEmbeddingTransport(
  options: HttpOptions & {
    endpoint?: string;
    traces?: TraceFeed;
    requestBody?: (input: EmbeddingInput | readonly EmbeddingInput[], model?: string) => unknown;
  } = {},
): EmbeddingTransport {
  const base = (options.endpoint ?? '/api/embedding').replace(/\/$/, '');
  const traceFeed = options.traces ?? createTraceFeed();
  return {
    async describe(signal) {
      return checkWire(
        describedSchema,
        await fetchJson(base, { signal }, options),
        'the embedding description', // labels-exempt: internal diagnostic; the user reads error.bad_response
      ).interface;
    },
    embed: async (input, model, signal) => {
      let failedTraceRecords: readonly TraceRecord[] = [];
      try {
        const reply = readEmbeddingReply(
          await fetchJson(
            `${base}/embed`,
            {
              body: options.requestBody
                ? options.requestBody(input, model)
                : { input, ...(model === undefined ? {} : { model }) },
              signal,
              failed: (raw) => {
                const read = z.object({ traces: z.array(traceRecordSchema) }).safeParse(raw);
                if (read.success) failedTraceRecords = read.data.traces;
              },
            },
            options,
          ),
        );
        for (const record of reply.traces ?? []) traceFeed.push(record);
        return reply;
      } catch (error) {
        throw withFailedTraces(
          error,
          failedTraceRecords.length ? failedTraceRecords : failedTraces(error),
        );
      }
    },
    traces: traceFeed,
  };
}
