import {
  defineProfile,
  type EmbeddingProfile,
  type EmbeddingProfileDefinition,
  type KeyVault,
  labelText,
  type ProviderHostOptions,
  registerProfile,
  runEmbedding,
  type TraceSink,
  z,
} from '@theoremjs/agents';
import {
  type ClientTurnOptions,
  caughtStatus,
  clientError,
  HTTP_METHOD,
} from '@theoremjs/agents/host';
import { embeddingInterface } from '../client/embedding-transport.ts';
import { readBody } from './handler.ts';
import { jsonResponse } from './json-response.ts';

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

const embedBodySchema = z.object({
  input: z.unknown(),
  model: z.string().min(1).optional(),
});

function isEmbed(request: Request): boolean {
  return new URL(request.url).pathname.split('/').filter(Boolean).at(-1) === 'embed';
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
  const iface = embeddingInterface(profile);
  return async (request) => {
    try {
      if (request.method === 'GET' && !isEmbed(request))
        return jsonResponse(200, { interface: iface });
      if (request.method !== 'POST' || !isEmbed(request)) {
        return jsonResponse(HTTP_METHOD, {
          error: labelText('error.request', {}, profile.labels),
          errorKind: 'request',
        });
      }
      const body = await readBody(request, embedBodySchema);
      const provider =
        typeof options.provider === 'function'
          ? await options.provider({ request, model: body.model })
          : options.provider;
      const result = await runEmbedding(
        {
          profile: profile.id,
          input: body.input as never,
          ...(body.model === undefined ? {} : { model: body.model }),
          signal: request.signal,
          metadata: options.metadata?.(request),
        },
        provider
          ? { ...provider, ...(options.sink ? { sink: options.sink } : {}) }
          : { vault: options.vault, fetch: options.fetch, sink: options.sink },
      );
      return jsonResponse(200, { result });
    } catch (err) {
      options.onError?.(err, { request });
      return jsonResponse(
        caughtStatus(err),
        clientError(err, profile.labels, options.clientEvents),
      );
    }
  };
}
