/**
 * Host-owned model bindings and media defaults used by test fixtures.
 *
 * Media vocabularies come from the Google preset; model wire bindings are local.
 *
 * @module
 */

import type { ModelBinding, ModelId } from '../../src/kernel/types.ts';
import {
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_VOICE_INPUT_MIMES,
} from '../../src/presets/google.ts';

const KIB = 1024;
const MIB = KIB * KIB;

/** Fixture chat media caps (app/host policy). */
const CHAT_MEDIA_LIMITS = {
  maxFiles: 10,
  maxBytes: 8 * MIB,
  maxTurnBytes: 32 * MIB,
} as const;

const IMAGE_INPUT_MIMES = [...GOOGLE_IMAGE_INPUT_MIMES];
const VOICE_INPUT_MIMES = [...GOOGLE_VOICE_INPUT_MIMES];
const IMAGE_ASPECT_RATIOS = [...GOOGLE_IMAGE_ASPECT_RATIOS];
const IMAGE_SIZES = [...GOOGLE_IMAGE_SIZES];

const GEMINI_INTERACTIONS = {
  protocol: 'geminiInteractions' as const,
  provider: 'google' as const,
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
  key: 'paid',
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
  efforts: { normal: 'none' },
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

/** Convenience map for tests that need several model ids. */
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

/** Build `models` from host fixture bindings. */
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
  key: 'slotA';
} {
  return {
    models: modelBindings(...ids),
    key: 'slotA',
  };
}

export type { HostBindingId };
export {
  CHAT_MEDIA_LIMITS,
  geminiModels,
  HOST_BINDINGS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_INPUT_MIMES,
  IMAGE_SIZES,
  modelBindings,
  VOICE_INPUT_MIMES,
};
