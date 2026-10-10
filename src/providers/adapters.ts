import { z } from 'zod';
import { TheoremError } from '../guardrails/error.ts';
import type {
  JsonObject,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderModelEvent,
  ProviderOperations,
  ProviderTurnRequest,
} from '../kernel/provider-contract.ts';
import { jsonObjectSchema, jsonValueSchema } from '../kernel/provider-contract.ts';
import type { ProviderCompleteRequest, ProviderEvent } from '../kernel/types.ts';
import {
  GOOGLE_NO_EFFORT_API_IDS,
  GOOGLE_NO_THINKING_API_IDS,
  GOOGLE_THINKING_LEVELS,
  GOOGLE_THINKING_REQUIRED_API_IDS,
} from '../presets/google.ts';
import {
  collectReasoning,
  type ReasoningState,
  reasoningStateSchema,
} from './openrouter/openai/reasoning-state.ts';

const endpointSchema: z.ZodString = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) => /key|auth|secret|token|password/i.test(key))
    );
  }, 'Endpoints must use HTTP and exclude credentials');
const googleConnection: z.ZodType<Record<string, never>> = z.strictObject({});
const typesafeConnection: z.ZodType<{ baseURL?: string }> = z.strictObject({
  baseURL: endpointSchema.optional(),
});
const connectionSchema: z.ZodType<{
  baseURL?: string;
  decisionURL?: string;
  siteUrl?: string;
  siteName?: string;
}> = z.strictObject({
  decisionURL: endpointSchema.optional(),
  baseURL: endpointSchema.optional(),
  siteUrl: z.string().optional(),
  siteName: z.string().optional(),
});
const cacheSchema: z.ZodType<{ mode: 'automatic' | 'system'; ttl?: '5m' | '1h' }> = z.strictObject({
  mode: z.enum(['automatic', 'system']),
  ttl: z.enum(['5m', '1h']).optional(),
});
const routerOptions: z.ZodType<{ cache?: { mode: 'automatic' | 'system'; ttl?: '5m' | '1h' } }> =
  z.strictObject({ cache: cacheSchema.optional() });
const googleOptions: z.ZodType<{
  store?: boolean;
  persistViaInteractionId?: boolean;
  googleMapsLocation?: { latitude: number; longitude: number };
}> = z
  .strictObject({
    store: z.boolean().optional(),
    persistViaInteractionId: z.boolean().optional(),
    googleMapsLocation: z
      .strictObject({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .optional(),
  })
  .refine(
    (options) => !options.persistViaInteractionId || options.store !== false,
    'Stored continuation requires storage',
  );
const localConnection: z.ZodType<{ baseURL: string }> = z.strictObject({ baseURL: endpointSchema });
const localOptions: z.ZodType<{ server?: string }> = z.strictObject({
  server: z.string().trim().min(1).optional(),
});
const credentialSchema: z.ZodString = z.string().trim().min(1);
const stateSchema: z.ZodType<{
  interactionId?: string;
  liveHandle?: string;
  historyLength?: number;
  reasoning?: import('../kernel/provider-contract.ts').JsonValue[];
}> = z.strictObject({
  interactionId: z.string().optional(),
  liveHandle: z.string().optional(),
  historyLength: z.number().int().nonnegative().optional(),
  reasoning: z.array(jsonValueSchema).optional(),
});
const allFeatures: ProviderCapabilities['features'] = {
  streaming: 'supported',
  clientTools: 'supported',
  parallelTools: 'supported',
  structuredOutput: 'supported',
  thinking: 'supported',
  summaries: 'supported',
  storedContinuation: 'supported',
};
function capability(
  profileTypes: ProviderCapabilities['profileTypes'],
  builtins: readonly string[] = [],
): ProviderCapabilities {
  return {
    profileTypes,
    features: { ...allFeatures },
    inputKinds: ['text', 'image', 'audio', 'video', 'document'],
    outputKinds: ['text', 'image', 'audio'],
    builtins,
  };
}

export function translateProviderEvent(event: ProviderEvent): ProviderModelEvent | undefined {
  if (event.type === 'tool') {
    if (event.tool.phase === undefined) return { type: 'tool_call', call: event.tool };
    if (event.tool.phase === 'cancel') return { type: 'tool_cancel', callId: event.tool.callId };
    if (event.tool.phase === 'error') return { type: 'error', errorKind: 'bad_response' };
    throw new TheoremError('bad_response', 'Adapter attempted to execute a client tool');
  }
  if (
    event.type === 'stage' ||
    event.type === 'guardrail' ||
    event.type === 'compaction' ||
    event.type === 'provider_warning' ||
    event.type === 'provider_checkpoint'
  )
    throw new TheoremError('bad_response', 'Adapter emitted a kernel-owned event');
  if (event.type === 'done')
    return {
      type: 'done',
      stop: event.stop,
      interrupted: event.interrupted,
    };
  return event;
}
async function* translated(
  events: AsyncIterable<ProviderEvent>,
): AsyncGenerator<ProviderModelEvent<never>> {
  for await (const event of events) {
    const converted = translateProviderEvent(event);
    if (converted) yield converted.type === 'done' ? { ...converted, state: undefined } : converted;
  }
}
async function resolvedVault(context: ProviderContext) {
  const primary = await context.resolveCredential('primary');
  return {
    primary: typeof primary === 'string' ? primary : undefined,
    fallback: async () => {
      const value = await context.resolveCredential('fallback');
      return typeof value === 'string' ? value : '';
    },
  };
}
function credentialRequest(req: ProviderTurnRequest): ProviderCompleteRequest {
  return {
    ...req,
    tapUpstream: req.tapUpstream
      ? (row) =>
          req.tapUpstream?.({
            ...row,
            ...(row.keySlot === 'primary'
              ? { keySlot: req.keySlot }
              : row.keySlot === 'fallback'
                ? { keySlot: req.fallbackKeySlot }
                : {}),
            ...(row.from === 'primary' ? { from: req.keySlot } : {}),
          })
      : undefined,
    keySlot: req.keySlot ? 'primary' : undefined,
    fallbackKeySlot: req.fallbackKeySlot ? 'fallback' : undefined,
  };
}

async function* routerChatEvents(
  req: ProviderTurnRequest<ReasoningState>,
  config: import('./types.ts').OpenAiGatewayTransport,
  context: ProviderContext,
  bound: ProviderCompleteRequest,
): AsyncGenerator<ProviderModelEvent<ReasoningState>> {
  const { createOpenRouterProvider } = await import('./openrouter/chat.ts');
  const details = new Map<string, JsonObject>();
  const callIds: string[] = [];
  let content = '';
  const taped = {
    ...bound,
    tapUpstream: (row: Record<string, unknown>) => {
      content += collectReasoning(row, details);
      context.tapUpstream(jsonObjectSchema.parse(JSON.parse(JSON.stringify(row))));
    },
  };
  for await (const event of createOpenRouterProvider(config).complete(taped)) {
    const converted = translateProviderEvent(event);
    if (!converted) continue;
    if (converted.type === 'tool_call') callIds.push(converted.call.callId);
    if (converted.type === 'done') {
      const replay = [...(req.state?.replay ?? [])];
      if (callIds.length && (details.size || content))
        replay.push({
          callIds,
          ...(details.size ? { details: [...details.values()] } : {}),
          ...(content ? { content } : {}),
        });
      yield { ...converted, state: replay.length ? { replay } : undefined };
    } else yield converted;
  }
}

export function openRouterAdapter(): ProviderAdapter<
  z.infer<typeof connectionSchema>,
  z.infer<typeof routerOptions>,
  string,
  ReasoningState
> {
  return {
    apiVersion: 1,
    id: 'openrouter',
    connectionSchema,
    optionsSchema: routerOptions,
    credentialSchema,
    capabilities: () =>
      capability(
        ['text', 'image', 'speech', 'decision'],
        ['googleSearch', 'webSearch', 'fileParser'],
      ),
    continuation: {
      version: 1,
      schema: reasoningStateSchema,
      compatibilityKey: (model) =>
        JSON.stringify([model.connection, model.apiId, model.providerOptions]),
    },
    validateRequest() {},
    create(context) {
      return Promise.resolve().then(() => {
        return {
          async *complete(req) {
            const vault = await resolvedVault(context);
            if (!vault.primary)
              throw new TheoremError('auth', 'OpenRouter requires a credential slot');
            const config = {
              baseUrl: context.connection.baseURL,
              siteUrl: context.connection.siteUrl,
              siteName: context.connection.siteName,
              vault,
              fetch: context.fetch,
              wait: context.wait,
            };
            const bound = { ...credentialRequest(req), cache: context.providerOptions.cache };
            if (req.speech) {
              const { createSpeechProvider } = await import('./openrouter/speech.ts');
              yield* translated(createSpeechProvider(config).complete(bound));
            } else if (req.image) {
              const { createImageProvider } = await import('./openrouter/image.ts');
              yield* translated(createImageProvider(config).complete(bound));
            } else {
              yield* routerChatEvents(req, config, context, bound);
            }
          },
          async decide(req) {
            const { nativeDecision } = await import('./decision/native.ts');
            return await nativeDecision(
              req,
              context,
              context.connection.decisionURL ?? 'https://openrouter.ai/api/alpha/decisions',
              'openrouter',
            );
          },
        };
      });
    },
  };
}

export function openAIChat(
  options: { capabilities?: ProviderCapabilities } = {},
): ProviderAdapter<z.infer<typeof localConnection>, z.infer<typeof localOptions>, string, unknown> {
  const cap = options.capabilities ?? {
    ...capability(['text']),
    inputKinds: ['text'] as const,
    outputKinds: ['text'] as const,
    features: {
      ...allFeatures,
      clientTools: 'unknown' as const,
      parallelTools: 'unknown' as const,
      structuredOutput: 'unknown' as const,
      thinking: 'unknown' as const,
      summaries: 'unknown' as const,
      storedContinuation: 'unsupported' as const,
    },
  };
  if (
    cap.profileTypes.some((type) => type !== 'text') ||
    cap.outputKinds.some((kind) => kind !== 'text') ||
    cap.builtins.length ||
    cap.features.storedContinuation === 'supported'
  )
    throw new TheoremError(
      'config',
      'Compatible chat supports text operations without hosted tools or native continuation',
    );
  return {
    apiVersion: 1,
    id: 'openai-chat',
    connectionSchema: localConnection,
    optionsSchema: localOptions,
    credentialSchema,
    capabilities: () => cap,
    validateRequest() {},
    create(context) {
      const operations: ProviderOperations = {
        async *complete(req) {
          const vault = await resolvedVault(context);
          const { createCompatibleChatProvider } = await import('./local/local.ts');
          const bound = {
            ...req,
            keySlot: vault.primary ? 'primary' : undefined,
            fallbackKeySlot: req.fallbackKeySlot ? 'fallback' : undefined,
          };
          yield* translated(
            createCompatibleChatProvider({
              baseUrl: context.connection.baseURL,
              vault,
              fetch: context.fetch,
            }).complete(bound),
          );
        },
      };
      return Promise.resolve(operations);
    },
  };
}

function* googleLiveBatch(
  events: ProviderEvent[],
  turnPhase: import('./types.ts').LiveTurnPhase,
  liveHandle?: string,
): Generator<ProviderModelEvent<z.infer<typeof stateSchema>>, string | undefined> {
  const ordered = [
    ...events.filter((event) => event.type === 'tokens'),
    ...events.filter((event) => event.type !== 'tokens'),
  ];
  for (const event of ordered) {
    if (event.type === 'evidence' && event.sessionResumptionHandle)
      liveHandle = event.sessionResumptionHandle;
    const converted = translateProviderEvent(event);
    if (!converted) continue;
    yield converted.type === 'done' ? { ...converted, state: undefined } : converted;
  }
  if (turnPhase !== 'abort') {
    if (events.some((event) => event.type === 'tool' && event.tool.phase === undefined))
      yield {
        type: 'done',
        stop: { kind: 'tool' },
        state: liveHandle ? { liveHandle } : undefined,
      };
    if (turnPhase === 'complete')
      yield {
        type: 'done',
        stop: { kind: 'completed' },
        state: liveHandle ? { liveHandle } : undefined,
      };
  }

  return liveHandle;
}

export function googleAdapter(): ProviderAdapter<
  z.infer<typeof googleConnection>,
  z.infer<typeof googleOptions>,
  string,
  z.infer<typeof stateSchema>
> {
  return {
    apiVersion: 1,
    id: 'google',
    connectionSchema: googleConnection,
    optionsSchema: googleOptions,
    credentialSchema,
    capabilities(model) {
      const cap = capability(
        ['text', 'image', 'speech', 'live'],
        ['googleSearch', 'googleMaps', 'urlContext', 'codeExecution'],
      );
      if ((GOOGLE_NO_THINKING_API_IDS as readonly string[]).includes(model.apiId)) {
        cap.features.thinking = 'unsupported';
        cap.features.summaries = 'unsupported';
      }
      if ((GOOGLE_NO_EFFORT_API_IDS as readonly string[]).includes(model.apiId))
        cap.features.thinking = 'unsupported';
      return cap;
    },
    validateRequest(req, model) {
      if (!('input' in req)) return;
      if (
        req.thinking !== undefined &&
        (!(GOOGLE_THINKING_LEVELS as readonly string[]).includes(req.thinking) ||
          (GOOGLE_NO_THINKING_API_IDS as readonly string[]).includes(model.apiId) ||
          (GOOGLE_NO_EFFORT_API_IDS as readonly string[]).includes(model.apiId))
      )
        throw new TheoremError(
          'unsupported',
          'Google model does not support the selected thinking level',
        );
      if (
        (GOOGLE_THINKING_REQUIRED_API_IDS as readonly string[]).includes(model.apiId) &&
        !req.thinking
      )
        throw new TheoremError('request', 'Google model requires a thinking level');
      if (
        (GOOGLE_NO_THINKING_API_IDS as readonly string[]).includes(model.apiId) &&
        req.summaries !== undefined
      )
        throw new TheoremError('unsupported', 'Google model does not support summaries');
      if (model.providerOptions.persistViaInteractionId && model.providerOptions.store === false)
        throw new TheoremError('config', 'Stored continuation requires storage');
    },
    continuation: {
      version: 1,
      schema: stateSchema,
      compatibilityKey: (model) =>
        JSON.stringify([model.connection, model.apiId, model.providerOptions]),
    },
    create(context) {
      return Promise.resolve().then(() => {
        const ops: ProviderOperations<z.infer<typeof stateSchema>> = {
          async *complete(req) {
            const vault = await resolvedVault(context);
            if (!vault.primary) throw new TheoremError('auth', 'Google requires a credential slot');
            const { createInteractionsProvider } = await import('./google/interactions/mod.ts');
            const previous = context.providerOptions.persistViaInteractionId
              ? req.state?.interactionId
              : undefined;
            const bound = {
              ...credentialRequest(req),
              store: context.providerOptions.store,
              googleMapsLocation: context.providerOptions.googleMapsLocation,
              previousInteractionId: previous,
              continuation: previous
                ? [
                    ...(req.history ?? []).slice(req.stateHistoryLength ?? 0),
                    ...req.input.map((part) => ({ role: 'user' as const, parts: [part] })),
                  ]
                : undefined,
            };
            for await (const event of createInteractionsProvider({
              vault,
              fetch: context.fetch,
              wait: context.wait,
            }).complete(bound)) {
              const converted = translateProviderEvent(event);
              if (!converted) continue;
              if (converted.type === 'done')
                yield {
                  ...converted,
                  state:
                    context.providerOptions.persistViaInteractionId &&
                    event.type === 'done' &&
                    event.interactionId
                      ? { interactionId: event.interactionId }
                      : undefined,
                };
              else yield converted;
            }
          },
          async openSession(req) {
            const vault = await resolvedVault(context);
            if (!vault.primary) throw new TheoremError('auth', 'Google requires a credential slot');
            const { openGoogleLiveSession } = await import('./google/live/session.ts');
            const { liveFrameInput } = await import('./google/live/framing.ts');
            let liveHandle = req.state?.liveHandle;
            let closed: Extract<import('./types.ts').LiveQueueItem, { type: 'closed' }> | undefined;
            const connection = await openGoogleLiveSession(
              {
                ...credentialRequest(req),
                sessionResumptionHandle: liveHandle,
                tapUpstream: (row) => {
                  const body = row.body;
                  context.tapUpstream(
                    jsonObjectSchema.parse(
                      JSON.parse(
                        JSON.stringify({
                          ...row,
                          ...(row.keySlot === 'primary'
                            ? { keySlot: req.keySlot }
                            : row.keySlot === 'fallback'
                              ? { keySlot: req.fallbackKeySlot }
                              : {}),
                          ...(row.from === 'primary' ? { from: req.keySlot } : {}),
                          ...(body && typeof body === 'object'
                            ? { input: liveFrameInput(body as Record<string, unknown>) }
                            : {}),
                        }),
                      ),
                    ),
                  );
                },
              },
              { vault, fetch: context.fetch, wait: context.wait },
              context.openWebSocket,
            );
            return {
              closeInfo() {
                return (
                  closed && {
                    code: closed.code,
                    reason: closed.reason,
                    error: closed.error,
                    warning: closed.goAway,
                  }
                );
              },
              async *events() {
                for await (const item of connection.batches()) {
                  if (item.type === 'batch') {
                    context.tapUpstream(
                      jsonObjectSchema.parse({ direction: 'receive', body: item.row }),
                    );
                    liveHandle = yield* googleLiveBatch(item.events, item.turnPhase, liveHandle);
                  } else if (item.type === 'row')
                    context.tapUpstream(
                      jsonObjectSchema.parse({ direction: 'receive', body: item.row }),
                    );
                  else if (item.type === 'error') throw item.error;
                  else {
                    closed = item;
                    return;
                  }
                }
              },
              sendText(text) {
                return Promise.resolve(connection.sendInput({ type: 'text', text }));
              },
              sendAudio(media) {
                return Promise.resolve(connection.sendInput({ type: 'audio', ...media }));
              },
              sendVideo(media) {
                return Promise.resolve(connection.sendInput({ type: 'video', ...media }));
              },
              sendContext(value) {
                return Promise.resolve(
                  connection.sendContext(
                    typeof value.server === 'string' ? value.server : JSON.stringify(value),
                  ),
                );
              },
              sendToolResult(result) {
                return Promise.resolve(
                  connection.sendToolResponse(
                    result.callId,
                    result.name,
                    result.text,
                    result.parts,
                  ),
                );
              },
              close(reason) {
                return Promise.resolve(connection.close(1000, reason));
              },
            };
          },
        };
        return ops;
      });
    },
  };
}

export function typesafeAdapter(): ProviderAdapter<
  z.infer<typeof typesafeConnection>,
  Record<string, never>,
  string,
  unknown
> {
  return {
    apiVersion: 1,
    id: 'typesafe',
    connectionSchema: typesafeConnection,
    optionsSchema: z.strictObject({}),
    credentialSchema,
    capabilities: () => capability(['decision']),
    validateRequest() {},
    create(context) {
      return Promise.resolve().then(() => {
        return {
          async decide(req) {
            const { nativeDecision } = await import('./decision/native.ts');
            return await nativeDecision(
              req,
              context,
              context.connection.baseURL ?? 'https://api.typesafe.ai/v1/systemone',
              'typesafe',
            );
          },
        };
      });
    },
  };
}
