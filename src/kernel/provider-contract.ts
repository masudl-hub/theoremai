import { z } from 'zod';
import { TheoremError } from '../guardrails/error.ts';
import { lexiconText } from '../guardrails/lexicon.ts';
import type { ToolCallRequest } from './turn-events.ts';
import type {
  DecisionRequest,
  DecisionResult,
  KeySlot,
  ModelBinding,
  ProviderCompleteRequest,
  TurnContext,
  TurnEvent,
  TurnHistoryMessage,
  TurnResponse,
  TurnStop,
} from './types.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();
export const jsonObjectSchema: z.ZodRecord<z.ZodString, z.ZodType<JsonValue>> = z.record(
  z.string(),
  jsonValueSchema,
);
export const keySlotSchema: z.ZodString = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
export const commonModelSettingsSchema: z.ZodObject<{
  maxOutputTokens: z.ZodOptional<z.ZodNumber>;
  temperature: z.ZodOptional<z.ZodNumber>;
  efforts: z.ZodOptional<
    z.ZodRecord<
      z.ZodString,
      z.ZodEnum<{
        none: 'none';
        minimal: 'minimal';
        low: 'low';
        medium: 'medium';
        high: 'high';
        xhigh: 'xhigh';
        max: 'max';
      }>
    >
  >;
  defaultEffort: z.ZodOptional<z.ZodString>;
  allowEffortSelect: z.ZodOptional<z.ZodBoolean>;
  summaries: z.ZodOptional<z.ZodBoolean>;
  builtInTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
  compaction: z.ZodOptional<z.ZodCustom<import('./types.ts').CompactionSpec>>;
}> = z.strictObject({
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().finite().nonnegative().optional(),
  efforts: z
    .record(z.string().min(1), z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .optional(),
  defaultEffort: z.string().min(1).optional(),
  allowEffortSelect: z.boolean().optional(),
  summaries: z.boolean().optional(),
  builtInTools: z.array(z.string().min(1)).optional(),
  compaction: z
    .custom<import('./types.ts').CompactionSpec>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    .optional(),
});
export const modelBindingSchema: z.ZodType<ModelBinding> = commonModelSettingsSchema
  .extend({
    provider: z.string().min(1),
    apiId: z.string().min(1),
    keySlot: keySlotSchema.optional(),
    fallbackKeySlot: keySlotSchema.optional(),
    providerOptions: jsonObjectSchema.default({}),
  })
  .strict();
export const decisionModelBindingSchema: z.ZodType<import('./types.ts').DecisionModelBinding> =
  z.strictObject({
    provider: z.string().min(1),
    apiId: z.string().min(1),
    keySlot: keySlotSchema.optional(),
    fallbackKeySlot: keySlotSchema.optional(),
    timeoutMs: z.number().positive().optional(),
    providerOptions: jsonObjectSchema.default({}),
  });
export const providerCheckpointSchema: z.ZodType<ProviderCheckpoint> = z.strictObject({
  providerId: z.string().min(1),
  adapterId: z.string().min(1),
  version: z.number().int().positive(),
  apiId: z.string().min(1),
  compatibilityKey: z.string(),
  coveredHistoryLength: z.number().int().nonnegative(),
  coveredHistoryHash: z.string(),
  data: jsonValueSchema,
});
export interface ProviderCheckpoint {
  providerId: string;
  adapterId: string;
  version: number;
  apiId: string;
  compatibilityKey: string;
  coveredHistoryLength: number;
  coveredHistoryHash: string;
  data: JsonValue;
}
export const providerWarningSchema: z.ZodType<ProviderWarning> = z.strictObject({
  code: z.literal('provider_state_rebuilt'),
  reason: z.enum([
    'provider_changed',
    'model_changed',
    'connection_changed',
    'history_changed',
    'version_changed',
  ]),
});
export interface ProviderWarning {
  code: 'provider_state_rebuilt';
  reason:
    | 'provider_changed'
    | 'model_changed'
    | 'connection_changed'
    | 'history_changed'
    | 'version_changed';
}
export const providerContinuationSchema: z.ZodType<
  ProviderContinuationPolicy,
  { onMismatch?: 'rebuild' | 'error' }
> = z.strictObject({
  onMismatch: z.enum(['rebuild', 'error']).default('rebuild'),
});
export interface ProviderContinuationPolicy {
  onMismatch: 'rebuild' | 'error';
}
export type ProviderCredential = string | JsonObject;
export interface CredentialContext {
  providerId: string;
  apiId: string;
  keySlot: KeySlot;
  signal?: AbortSignal;
}
export type CredentialResolver = (
  context: CredentialContext,
) => ProviderCredential | Promise<ProviderCredential>;
export type ProviderVault = Readonly<
  Record<KeySlot, ProviderCredential | CredentialResolver | undefined>
>;
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export interface ProviderCapabilities {
  profileTypes: readonly ('text' | 'image' | 'speech' | 'live' | 'decision')[];
  features: {
    streaming: CapabilitySupport;
    clientTools: CapabilitySupport;
    parallelTools: CapabilitySupport;
    structuredOutput: CapabilitySupport;
    thinking: CapabilitySupport;
    summaries: CapabilitySupport;
    storedContinuation: CapabilitySupport;
  };
  inputKinds: readonly ('text' | 'image' | 'audio' | 'video' | 'document')[];
  outputKinds: readonly ('text' | 'image' | 'audio')[];
  builtins: readonly string[];
}
const capabilitySupportSchema: z.ZodType<CapabilitySupport> = z.enum([
  'supported',
  'unsupported',
  'unknown',
]);
export const providerCapabilitiesSchema: z.ZodType<ProviderCapabilities> = z.strictObject({
  profileTypes: z.array(z.enum(['text', 'image', 'speech', 'live', 'decision'])),
  features: z.strictObject({
    streaming: capabilitySupportSchema,
    clientTools: capabilitySupportSchema,
    parallelTools: capabilitySupportSchema,
    structuredOutput: capabilitySupportSchema,
    thinking: capabilitySupportSchema,
    summaries: capabilitySupportSchema,
    storedContinuation: capabilitySupportSchema,
  }),
  inputKinds: z.array(z.enum(['text', 'image', 'audio', 'video', 'document'])),
  outputKinds: z.array(z.enum(['text', 'image', 'audio'])),
  builtins: z.array(z.string().min(1)),
});
export interface ResolvedProviderModel<C = unknown, O = unknown> {
  apiId: string;
  connection: C;
  providerOptions: O;
}
export type ProviderTurnRequest<S = unknown> = Omit<
  ProviderCompleteRequest,
  | 'previousInteractionId'
  | 'continuation'
  | 'store'
  | 'cache'
  | 'googleMapsLocation'
  | 'sessionResumptionHandle'
  | 'providerState'
  | 'state'
> & {
  state?: S;
  stateHistoryLength?: number;
};
export type ProviderSessionRequest<S = unknown> = ProviderTurnRequest<S>;
export type ProviderDecisionRequest = Pick<DecisionRequest, 'state' | 'questions'> & {
  apiId: string;
  signal?: AbortSignal;
};
export type ProviderRequest = ProviderTurnRequest | ProviderDecisionRequest;
export type ProviderContentEvent = Extract<
  TurnEvent,
  {
    type:
      | 'text'
      | 'thought'
      | 'structured'
      | 'media'
      | 'grounding'
      | 'citation'
      | 'evidence'
      | 'tokens'
      | 'session'
      | 'error';
  }
>;
export type ProviderModelEvent<S = unknown> =
  | ProviderContentEvent
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'tool_cancel'; callId: string }
  | { type: 'response'; response: TurnResponse }
  | { type: 'done'; stop: TurnStop; interrupted?: boolean; state?: S };
export interface ProviderToolResult {
  callId: string;
  name: string;
  text: string;
  parts?: import('./types.ts').InteractionPart[];
}
export interface ProviderLiveConnection<S = unknown> {
  closeInfo?():
    | {
        code: number;
        reason: string;
        error?: Error;
        warning?: { timeLeftMs?: number; closedAfterMs: number };
      }
    | undefined;
  events(): AsyncIterable<ProviderModelEvent<S>>;
  sendText(text: string): Promise<void>;
  sendAudio(media: { data: string; mimeType: string }): Promise<void>;
  sendVideo(media: { data: string; mimeType: string }): Promise<void>;
  sendContext(context: TurnContext): Promise<void>;
  sendToolResult(result: ProviderToolResult): Promise<void>;
  close(reason?: string): Promise<void>;
}
export interface ProviderOperations<S = unknown> {
  complete?(request: ProviderTurnRequest<S>): AsyncIterable<ProviderModelEvent<S>>;
  openSession?(request: ProviderSessionRequest<S>): Promise<ProviderLiveConnection<S>>;
  decide?(request: ProviderDecisionRequest): Promise<DecisionResult>;
}
export type ProviderWait = (ms: number, signal?: AbortSignal | null) => Promise<void>;
export type OpenProviderWebSocket = (url: string) => Promise<WebSocket>;
export interface ProviderHostOptions {
  vault?: ProviderVault;
  fetch?: typeof fetch;
  wait?: ProviderWait;
  openWebSocket?: OpenProviderWebSocket;
}
export interface ProviderContext<C = unknown, O = unknown, K = unknown>
  extends ResolvedProviderModel<C, O> {
  signal?: AbortSignal;
  resolveCredential(which: 'primary' | 'fallback'): Promise<K | undefined>;
  fetch: typeof fetch;
  wait: ProviderWait;
  openWebSocket?: OpenProviderWebSocket;
  tapUpstream(row: JsonObject): void;
}
export interface ProviderAdapter<C = unknown, O = unknown, K = unknown, S = unknown> {
  apiVersion: 1;
  id: string;
  connectionSchema: z.ZodType<C>;
  optionsSchema: z.ZodType<O>;
  credentialSchema: z.ZodType<K>;
  capabilities(model: ResolvedProviderModel<C, O>): ProviderCapabilities;
  validateRequest(request: ProviderRequest, model: ResolvedProviderModel<C, O>): void;
  continuation?: {
    version: number;
    schema: z.ZodType<S>;
    compatibilityKey(model: ResolvedProviderModel<C, O>): string;
  };
  create(context: ProviderContext<C, O, K>): Promise<ProviderOperations<S>>;
}
export interface ProviderDefinition<C = unknown, O = unknown, K = unknown, S = unknown> {
  id: string;
  connection: C;
  keySlot?: KeySlot;
  fallbackKeySlot?: KeySlot;
  adapter: ProviderAdapter<C, O, K, S>;
}
export type ProviderModelSettings<O> = Omit<
  ModelBinding,
  | 'provider'
  | 'apiId'
  | 'protocol'
  | 'providerOptions'
  | 'cache'
  | 'store'
  | 'persistViaInteractionId'
  | 'server'
  | 'key'
  | 'fallbackKey'
> & { providerOptions?: O; timeoutMs?: number };
export interface DefinedProvider<C = unknown, O = unknown, K = unknown, S = unknown>
  extends ProviderDefinition<C, O, K, S> {
  model(apiId: string, settings?: ProviderModelSettings<O>): ModelBinding & { timeoutMs?: number };
}
export type RegisteredProvider = DefinedProvider;

export function defineProvider<C, O, K, S>(
  definition: ProviderDefinition<C, O, K, S>,
): DefinedProvider<C, O, K, S> {
  z.string().min(1).parse(definition.id);
  if (definition.adapter.apiVersion !== 1)
    throw new TheoremError('config', lexiconText('provider.adapter_version'));
  z.string().min(1).parse(definition.adapter.id);
  for (const method of ['capabilities', 'validateRequest', 'create'] as const)
    if (typeof definition.adapter[method] !== 'function')
      throw new TheoremError('config', lexiconText('provider.adapter_methods'));
  for (const schema of [
    definition.adapter.connectionSchema,
    definition.adapter.optionsSchema,
    definition.adapter.credentialSchema,
  ])
    if (typeof schema?.safeParse !== 'function')
      throw new TheoremError('config', lexiconText('provider.adapter_schemas'));
  if (definition.adapter.continuation)
    z.number().int().positive().parse(definition.adapter.continuation.version);
  const connection = definition.adapter.connectionSchema.parse(definition.connection);
  jsonValueSchema.parse(connection);
  if (definition.keySlot !== undefined) keySlotSchema.parse(definition.keySlot);
  if (definition.fallbackKeySlot !== undefined) keySlotSchema.parse(definition.fallbackKeySlot);
  if (definition.keySlot && definition.keySlot === definition.fallbackKeySlot)
    throw new TheoremError('config', lexiconText('provider.fallback_slot'));
  const frozen = { ...definition, connection: structuredClone(connection) };
  return {
    ...frozen,
    model(apiId, settings = {}) {
      z.string().min(1).parse(apiId);
      const options = definition.adapter.optionsSchema.parse(settings.providerOptions ?? {});
      jsonValueSchema.parse(options);
      const schema =
        settings.timeoutMs === undefined ? modelBindingSchema : decisionModelBindingSchema;
      return schema.parse({
        ...settings,
        provider: frozen.id,
        apiId,
        providerOptions: jsonObjectSchema.parse(options),
      });
    },
  };
}

export interface ProviderRegistry {
  register<C, O, K, S>(definition: ProviderDefinition<C, O, K, S>): RegisteredProvider;
  registerMany(definitions: ProviderDefinition[]): RegisteredProvider[];
  get(id: string): RegisteredProvider | undefined;
  require(id: string): RegisteredProvider;
  has(id: string): boolean;
  list(): RegisteredProvider[];
  reset(): void;
}
export function createProviderRegistry(): ProviderRegistry {
  const entries = new Map<string, RegisteredProvider>();
  const register = <C, O, K, S>(definition: ProviderDefinition<C, O, K, S>) => {
    // invariant: Erased generics are restored by the adapter's runtime schemas before use.
    const provider = defineProvider(definition) as unknown as RegisteredProvider;
    entries.set(provider.id, provider);
    return provider;
  };
  return {
    register,
    registerMany: (definitions) => definitions.map(register),
    get: (id) => entries.get(id),
    require(id) {
      const provider = entries.get(id);
      if (!provider) throw new TheoremError('config', `Unknown provider '${id}'`);
      return provider;
    },
    has: (id) => entries.has(id),
    list: () => [...entries.values()],
    reset: () => entries.clear(),
  };
}

export function validateProviderModel(
  provider: RegisteredProvider,
  binding: ModelBinding,
  profileType: string,
): ProviderCapabilities {
  const providerOptions = provider.adapter.optionsSchema.parse(binding.providerOptions ?? {});
  jsonObjectSchema.parse(providerOptions);
  const primary = binding.keySlot ?? provider.keySlot;
  const fallback = binding.fallbackKeySlot ?? provider.fallbackKeySlot;
  if (primary && primary === fallback)
    throw new TheoremError('config', lexiconText('provider.model_fallback_slot'));
  const capabilities = providerCapabilitiesSchema.parse(
    provider.adapter.capabilities({
      apiId: binding.apiId,
      connection: provider.connection,
      providerOptions,
    }),
  );
  if (!capabilities.profileTypes.some((type) => type === profileType))
    throw new TheoremError(
      'unsupported',
      lexiconText('provider.profile_type', { provider: provider.id, profileType }),
    );
  binding.providerOptions = providerOptions as JsonObject;
  return capabilities;
}

export async function historyHash(history: readonly TurnHistoryMessage[]): Promise<string> {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort())
        ordered[key] = stable((value as Record<string, unknown>)[key]);
      return ordered;
    }
    return value;
  };
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(
        stable(
          history.map((message) => {
            const canonicalText = (text: string) =>
              message.role === 'user'
                ? (text.match(/^<user_data>\n([\s\S]*)\n<\/user_data>$/)?.[1] ?? text)
                : text;
            const parts = [
              ...(message.content === undefined
                ? []
                : [{ type: 'text', text: canonicalText(message.content) }]),
              ...(message.parts ?? []).map((part) =>
                part.type === 'text' ? { ...part, text: canonicalText(part.text) } : part,
              ),
            ];
            const { content: _content, parts: _parts, ...rest } = message;
            return { ...rest, ...(parts.length ? { parts } : {}) };
          }),
        ),
      ),
    ),
  );
  let hex = '';
  for (const byte of new Uint8Array(hash)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
