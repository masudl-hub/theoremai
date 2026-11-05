import {
  defineProfile,
  type EmbeddingInput,
  type EmbeddingProfile,
  type EmbeddingProfileDefinition,
  type KeyVault,
  type ProviderHostOptions,
  registerProfile,
  runEmbedding,
  type TraceSink,
  z,
} from '@theoremjs/agents';
import type { ClientTurnOptions } from '@theoremjs/agents/host';
import { embeddingInterface } from '../client/embedding-transport.ts';
import { readBody } from './handler.ts';
import { singleActionHandler } from './single-action.ts';

export type TheoremEmbeddingHandlerOptions = {
  profile: EmbeddingProfile | EmbeddingProfileDefinition;
  vault?: KeyVault;
  fetch?: typeof globalThis.fetch;
  provider?:
    | ProviderHostOptions
    | ((ctx: {
        request: Request;
        model?: string;
      }) => ProviderHostOptions | Promise<ProviderHostOptions>);
  sink?: TraceSink;
  metadata?: (request: Request) => Record<string, unknown> | undefined;
  clientEvents?: ClientTurnOptions;
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

/** The body an embedding request posts: the input, and optionally the model and the task. */
export const embedBodySchema = z.object({
  input: z.unknown(),
  model: z.string().min(1).optional(),
  task: z.enum(['query', 'document']).optional(),
});

/** The body as the embedding request `runEmbedding` takes, less its profile. */
export function embedRequest(body: z.infer<typeof embedBodySchema>) {
  return {
    input: body.input as EmbeddingInput | readonly EmbeddingInput[],
    ...(body.model === undefined ? {} : { model: body.model }),
    ...(body.task === undefined ? {} : { task: body.task }),
  };
}

export function createTheoremEmbeddingHandler(
  options: TheoremEmbeddingHandlerOptions,
): (request: Request) => Promise<Response> {
  const profile = defineProfile(options.profile as EmbeddingProfileDefinition);
  if (profile.type !== 'embedding') {
    throw new Error(
      `createTheoremEmbeddingHandler serves type 'embedding'; got type '${profile.type}'.`, // labels-exempt: builder config error at setup; no user sees it
    );
  }
  registerProfile(profile);
  return singleActionHandler(
    {
      action: 'embed',
      iface: embeddingInterface(profile),
      labels: profile.labels,
      clientEvents: options.clientEvents,
      onError: options.onError,
    },
    async (request) => {
      const body = await readBody(request, embedBodySchema);
      const provider =
        typeof options.provider === 'function'
          ? await options.provider({ request, model: body.model })
          : options.provider;
      return runEmbedding(
        {
          profile: profile.id,
          ...embedRequest(body),
          signal: request.signal,
          metadata: options.metadata?.(request),
        },
        provider
          ? { ...provider, ...(options.sink ? { sink: options.sink } : {}) }
          : { vault: options.vault, fetch: options.fetch, sink: options.sink },
      );
    },
  );
}
