import type { ModelBinding, ModelId } from '../../src/kernel/types.ts';
import {
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_RESOLUTIONS,
  GOOGLE_VOICE_INPUT_MIMES,
} from '../../src/presets/google.ts';

const KIB = 1024;
const MIB = KIB * KIB;

const CHAT_MEDIA_LIMITS = {
  maxFiles: 10,
  maxBytes: 8 * MIB,
  maxTurnBytes: 32 * MIB,
} as const;

const IMAGE_INPUT_MIMES = [...GOOGLE_IMAGE_INPUT_MIMES];
const VOICE_INPUT_MIMES = [...GOOGLE_VOICE_INPUT_MIMES];
const IMAGE_ASPECT_RATIOS = [...GOOGLE_IMAGE_ASPECT_RATIOS];
const IMAGE_RESOLUTIONS = [...GOOGLE_IMAGE_RESOLUTIONS];

const GEMINI_INTERACTIONS = {
  protocol: 'geminiInteractions' as const,
  provider: 'google' as const,
  persistViaInteractionId: true,
};

function geminiBinding(spec: Omit<ModelBinding, 'protocol' | 'provider'>): ModelBinding {
  return { ...GEMINI_INTERACTIONS, ...spec };
}

const gemini35FlashLite = geminiBinding({
  apiId: 'gemini-3.5-flash-lite',
  efforts: { normal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
  defaultEffort: 'normal',
  allowEffortSelect: true,
  summaries: true,
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
});

const gemini31FlashLite = geminiBinding({
  apiId: 'gemini-3.1-flash-lite',
  efforts: { normal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
  defaultEffort: 'normal',
  allowEffortSelect: true,
  summaries: true,
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
});

const gemini31ProPreview = geminiBinding({
  apiId: 'gemini-3.1-pro-preview',
  efforts: { normal: 'low', medium: 'medium', high: 'high' },
  defaultEffort: 'normal',
  allowEffortSelect: true,
  summaries: true,
  maxOutputTokens: 64_000,
  temperature: 1,
  builtInTools: [],
});

const gemini31FlashLiteImage = geminiBinding({
  apiId: 'gemini-3.1-flash-lite-image',
  efforts: { normal: 'minimal', high: 'high' },
  defaultEffort: 'normal',
  allowEffortSelect: true,
  summaries: false,
  maxOutputTokens: 4096,
  temperature: 1,
  builtInTools: [],
  key: 'slot_b',
});

const gemini31FlashTts = geminiBinding({
  apiId: 'gemini-3.1-flash-tts-preview',
  efforts: { normal: 'minimal' },
  summaries: false,
  maxOutputTokens: 2048,
  temperature: 1,
  builtInTools: [],
});

const gemini31FlashLive: ModelBinding = {
  protocol: 'geminiLive',
  provider: 'google',
  apiId: 'gemini-3.1-flash-live-preview',
  summaries: false,
  maxOutputTokens: 256,
  temperature: 0,
  builtInTools: [],
};

const sonar: ModelBinding = {
  protocol: 'openAi',
  provider: 'openrouter',
  apiId: 'perplexity/sonar',
  efforts: { normal: 'low', high: 'high' },
  defaultEffort: 'normal',
  allowEffortSelect: true,
  summaries: false,
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
};

const HOST_BINDINGS = {
  gemini35FlashLite,
  gemini31FlashLite,
  gemini31ProPreview,
  gemini31FlashLiteImage,
  gemini31FlashTts,
  gemini31FlashLive,
  sonar,
} as const satisfies Record<string, ModelBinding>;

type HostBindingId = keyof typeof HOST_BINDINGS;

function modelBindings(...ids: HostBindingId[]): Record<ModelId, ModelBinding> {
  const models: Record<ModelId, ModelBinding> = {};
  for (const id of ids) {
    models[id] = HOST_BINDINGS[id];
  }
  return models;
}

/** Gemini Interactions model fields for fixtures (protocol + provider live on each binding). */
function geminiModels(...ids: HostBindingId[]): {
  models: Record<ModelId, ModelBinding>;
  key: 'slot_a';
} {
  return {
    models: modelBindings(...ids),
    key: 'slot_a',
  };
}

export type { HostBindingId };
export {
  CHAT_MEDIA_LIMITS,
  geminiModels,
  HOST_BINDINGS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_INPUT_MIMES,
  IMAGE_RESOLUTIONS,
  modelBindings,
  VOICE_INPUT_MIMES,
};
