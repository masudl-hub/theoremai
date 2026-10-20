import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import { type JsonObject, jsonObjectSchema } from '../json.ts';
import { KEY_SLOT_NAME, type KeySlot } from '../schema.ts';
import type { Equals } from '../util/exact-type.ts';
import { type ModelProfileType, modelOptions, type Protocol } from './protocol.ts';
import type { RegisteredProvider } from './provider.ts';

/** A vault slot name. */
export const keySlotSchema: z.ZodString = z.string().regex(KEY_SLOT_NAME);
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
  compaction: z.ZodOptional<z.ZodCustom<import('../types.ts').CompactionSpec>>;
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
    .custom<import('../types.ts').CompactionSpec>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    .optional(),
});

const shared = commonModelSettingsSchema.shape;

/** One entry under a profile's `models`: which protocol, which provider, which model, and its settings. */
export interface ModelBinding extends z.infer<typeof commonModelSettingsSchema> {
  protocol: string;
  provider: string;
  apiId: string;
  keySlot?: string;
  fallbackKeySlot?: string;
  options?: JsonObject;
}

/** A decision profile's model: no generation settings, and a time limit. */
export interface DecisionModelBinding
  extends Pick<
    ModelBinding,
    'protocol' | 'provider' | 'apiId' | 'keySlot' | 'fallbackKeySlot' | 'options'
  > {
  timeoutMs?: number;
}

const modelBinding = z.strictObject({
  // labels-exempt: builder field description, read by the studio and docs
  protocol: z.string().min(1).describe('The API shape this model is spoken to in.'),
  provider: z.string().min(1).describe(
    // labels-exempt: builder field description, read by the studio and docs
    'The service that runs the model or routes requests to one, such as Gemini or OpenRouter. Its registration supplies the endpoint and authentication.',
  ),
  // labels-exempt: builder field description, read by the studio and docs
  apiId: z.string().min(1).describe('The id the provider knows the model by.'),
  maxOutputTokens: shared.maxOutputTokens.describe(
    // labels-exempt: builder field description, read by the studio and docs
    'The most tokens the model may write in one step.',
  ),
  // labels-exempt: builder field description, read by the studio and docs
  temperature: shared.temperature.describe("How varied the model's answers are."),
  efforts: shared.efforts.describe(
    // labels-exempt: builder field description, read by the studio and docs
    'Effort names a turn may pick, each mapped to a thinking level.',
  ),
  // labels-exempt: builder field description, read by the studio and docs
  defaultEffort: shared.defaultEffort.describe('The effort used when a turn picks none.'),
  // labels-exempt: builder field description, read by the studio and docs
  allowEffortSelect: shared.allowEffortSelect.describe('Whether a turn may pick an effort.'),
  // labels-exempt: builder field description, read by the studio and docs
  summaries: shared.summaries.describe('Whether the model sends summaries of its thinking.'),
  builtInTools: shared.builtInTools.describe(
    // labels-exempt: builder field description, read by the studio and docs
    'Tools the provider runs itself, by the ids it knows them by.',
  ),
  compaction: shared.compaction.describe(
    // labels-exempt: builder field description, read by the studio and docs
    'How the conversation is shortened when it grows too long.',
  ),
  keySlot: keySlotSchema
    .optional()
    // labels-exempt: builder field description, read by the studio and docs
    .describe("The slot this model's key is read from, in place of the provider's."),
  fallbackKeySlot: keySlotSchema
    .optional()
    // labels-exempt: builder field description, read by the studio and docs
    .describe('The slot tried once when the first key is out of quota.'),
  options: jsonObjectSchema
    .optional()
    // labels-exempt: builder field description, read by the studio and docs
    .describe("What this model's protocol takes beyond the shared settings."),
});
true satisfies Equals<z.infer<typeof modelBinding>, ModelBinding>;
export const modelBindingSchema: z.ZodType<ModelBinding> = modelBinding;

const decisionModelBinding = modelBinding
  .pick({
    protocol: true,
    provider: true,
    apiId: true,
    keySlot: true,
    fallbackKeySlot: true,
    options: true,
  })
  .extend({
    timeoutMs: z
      .number()
      .positive()
      .optional()
      // labels-exempt: builder field description, read by the studio and docs
      .describe('How long a decision may take before it fails.'),
  });
true satisfies Equals<z.infer<typeof decisionModelBinding>, DecisionModelBinding>;
export const decisionModelBindingSchema: z.ZodType<DecisionModelBinding> = decisionModelBinding;

/** What a runtime can do that a sign-in may need. */
export interface RuntimeAbilities {
  /** Whether a WebSocket can be opened with headers (not in a browser). */
  webSocketHeaders: boolean;
}

/** The slots a model reads its key from: the ones it names, else its provider's. */
export function keySlotsOf(
  provider: { keySlot?: KeySlot; fallbackKeySlot?: KeySlot },
  binding: { keySlot?: KeySlot; fallbackKeySlot?: KeySlot },
): { keySlot?: KeySlot; fallbackKeySlot?: KeySlot } {
  const keySlot = binding.keySlot ?? provider.keySlot;
  const fallbackKeySlot = binding.fallbackKeySlot ?? provider.fallbackKeySlot;
  return {
    ...(keySlot === undefined ? {} : { keySlot }),
    ...(fallbackKeySlot === undefined ? {} : { fallbackKeySlot }),
  };
}

/** The provider's serve of the protocol a binding speaks. */
export function bindingServe(
  provider: RegisteredProvider,
  binding: ModelBinding | DecisionModelBinding,
): RegisteredProvider['serves'][number] {
  const serve = provider.serves.find((entry) => entry.protocol.id === binding.protocol);
  if (!serve)
    throw new TheoremError(
      'config',
      labelText('protocol.not_served', { provider: provider.id, protocol: binding.protocol }),
    );
  return serve;
}

/** The protocol a binding speaks on its provider. */
export function protocolOf(
  provider: RegisteredProvider,
  binding: ModelBinding | DecisionModelBinding,
): Protocol {
  return bindingServe(provider, binding).protocol;
}

/**
 * The one place a binding meets its provider, once, at registration, for fit only. Returns the
 * binding with its options parsed; changes nothing in place.
 */
export function checkBinding<B extends ModelBinding | DecisionModelBinding>(
  provider: RegisteredProvider,
  binding: B,
  profileType: ModelProfileType,
  runtime: RuntimeAbilities = { webSocketHeaders: true },
): B {
  const serve = bindingServe(provider, binding);
  const { protocol } = serve;
  if (protocol.endpoints[profileType] === undefined)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.profile_type', { protocol: protocol.id, profileType }),
    );
  const options = jsonObjectSchema.parse(modelOptions(protocol, binding.apiId, binding.options));
  const slots = keySlotsOf(provider, binding);
  if (slots.keySlot !== undefined && slots.keySlot === slots.fallbackKeySlot)
    throw new TheoremError('config', labelText('provider.model_fallback_slot'));
  if ((binding.keySlot || binding.fallbackKeySlot) && !provider.definition.key)
    throw new TheoremError('config', labelText('protocol.no_key', { provider: provider.id }));
  const authorize = serve.authorize ?? provider.definition.authorize;
  if (profileType === 'live' && authorize?.webSocketHeaders && !runtime.webSocketHeaders)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.ws_headers', { provider: provider.id }),
    );
  return { ...binding, options: options as JsonObject };
}
