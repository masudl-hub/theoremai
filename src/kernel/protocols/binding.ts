import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { JsonObject } from '../provider-contract.ts';
import {
  commonModelSettingsSchema,
  jsonObjectSchema,
  keySlotSchema,
} from '../provider-contract.ts';
import type { ProfileType } from './protocol.ts';
import type { RegisteredProvider } from './provider.ts';

const shared = commonModelSettingsSchema.shape;

/** One entry under a profile's `models`: which protocol, which provider, which model, and its settings. */
export const modelBindingSchema = z.strictObject({
  // labels-exempt: builder field description, read by the studio and docs
  protocol: z.string().min(1).describe('The API shape this model is spoken to in.'),
  // labels-exempt: builder field description, read by the studio and docs
  provider: z.string().min(1).describe('The registered provider that serves this model.'),
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
export type ModelBinding = z.infer<typeof modelBindingSchema>;

/** A decision profile's model: no generation settings, and a time limit. */
export const decisionModelBindingSchema = modelBindingSchema
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
export type DecisionModelBinding = z.infer<typeof decisionModelBindingSchema>;

/** What a runtime can do that a sign-in may need. */
export interface RuntimeAbilities {
  /** Whether a WebSocket can be opened with headers (not in a browser). */
  webSocketHeaders: boolean;
}

/**
 * The one place a binding meets its provider, once, at registration, for fit only. Returns the
 * binding with its options parsed; changes nothing in place.
 */
export function checkBinding<B extends ModelBinding | DecisionModelBinding>(
  provider: RegisteredProvider,
  binding: B,
  profileType: ProfileType,
  runtime: RuntimeAbilities = { webSocketHeaders: true },
): B {
  const serve = provider.serves.find((entry) => entry.protocol.id === binding.protocol);
  if (!serve)
    throw new TheoremError(
      'config',
      labelText('protocol.not_served', { provider: provider.id, protocol: binding.protocol }),
    );
  const { protocol } = serve;
  if (protocol.endpoints[profileType] === undefined)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.profile_type', { protocol: protocol.id, profileType }),
    );
  const parsed = protocol.options.safeParse(binding.options ?? {});
  if (!parsed.success)
    throw new TheoremError(
      'config',
      labelText('protocol.options', {
        apiId: binding.apiId,
        protocol: protocol.id,
        issues: z.prettifyError(parsed.error),
      }),
    );
  const options = jsonObjectSchema.parse(parsed.data);
  const slots = [
    binding.keySlot ?? provider.keySlot,
    binding.fallbackKeySlot ?? provider.fallbackKeySlot,
  ];
  if (slots[0] !== undefined && slots[0] === slots[1])
    throw new TheoremError('config', labelText('provider.model_fallback_slot'));
  const authorize = serve.authorize ?? provider.definition.authorize;
  if (profileType === 'live' && authorize?.webSocketHeaders && !runtime.webSocketHeaders)
    throw new TheoremError(
      'unsupported',
      labelText('protocol.ws_headers', { provider: provider.id }),
    );
  return { ...binding, options: options as JsonObject };
}
