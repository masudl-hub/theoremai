import {
  type EmbeddingInput,
  type EmbeddingProfile,
  type EmbeddingResult,
  type EmbeddingRules,
  type EmbeddingTask,
  embeddingModelLimits,
  embeddingRules,
  type Protocol,
  resolveObservabilityPolicy,
  type TraceRecord,
  traceRecordSchema,
  z,
} from '@theoremjs/agents';
import { postWithTraces } from './decision-transport.ts';
import type { TraceFeed } from './trace-feed.ts';
import { fetchJson, type HttpOptions } from './transport.ts';
import { checkWire } from './wire-line.ts';

export type EmbeddingInterface = {
  type: 'embedding';
  identity: { handle: string };
  /** The profile's inputs held to what its default model takes. */
  inputs: EmbeddingRules;
  observability?: { record: boolean };
};

/**
 * The interface a client reads: the profile's inputs held to its default model's limits. Pass
 * `protocols` when a model speaks a protocol of your own.
 */
export function embeddingInterface(
  profile: Pick<
    EmbeddingProfile,
    'identity' | 'inputs' | 'observability' | 'models' | 'defaultModel'
  >,
  protocols: readonly Protocol[] = [],
): EmbeddingInterface {
  const binding = profile.models[profile.defaultModel];
  return {
    type: 'embedding',
    identity: { handle: profile.identity.handle },
    inputs: embeddingRules(
      profile.inputs,
      binding ? embeddingModelLimits(binding, protocols) : undefined,
    ),
    ...(profile.observability
      ? { observability: { record: resolveObservabilityPolicy(profile.observability).record } }
      : {}),
  };
}

export type EmbeddingReply = { result: EmbeddingResult; traces?: TraceRecord[] };

/** What an embedding asks beyond its inputs: a named model, and what the inputs are for. */
export type EmbedOptions = { model?: string; task?: EmbeddingTask };

export interface EmbeddingTransport {
  describe(signal?: AbortSignal): Promise<EmbeddingInterface>;
  embed(
    input: EmbeddingInput | readonly EmbeddingInput[],
    options?: EmbedOptions,
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
      limitsByMime: z.record(z.string(), z.number()).optional(),
    }),
    observability: z.object({ record: z.boolean() }).optional(),
  }),
});

export function readEmbeddingReply(raw: unknown): EmbeddingReply {
  return checkWire(embeddingReplySchema, raw, 'the embedding');
}

/** POSTs an embedding and reads its reply; a failure keeps the trace records its body carried. */
export function postEmbedding(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  options: HttpOptions = {},
): Promise<EmbeddingReply> {
  return postWithTraces(url, body, signal, options, readEmbeddingReply);
}

/** Transport for a host mounted with `createTheoremEmbeddingHandler`. Default endpoint `/api/embedding`. */
export function createEmbeddingTransport(
  options: HttpOptions & { endpoint?: string } = {},
): EmbeddingTransport {
  const base = (options.endpoint ?? '/api/embedding').replace(/\/$/, '');
  return {
    async describe(signal) {
      return checkWire(
        describedSchema,
        await fetchJson(base, { signal }, options),
        'the embedding description', // labels-exempt: internal diagnostic; the user reads error.bad_response
      ).interface;
    },
    embed: (input, embed, signal) =>
      postEmbedding(`${base}/embed`, { input, ...embed }, signal, options),
  };
}
