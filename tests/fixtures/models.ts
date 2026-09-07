/**
 * Host-owned model specs and media defaults used by test fixtures.
 *
 * Media vocabularies come from the Google preset; model wire specs are local.
 *
 * @module
 */

import type { ModelId, ModelSpec } from '../../src/kernel/types.ts';
import {
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_VOICE_INPUT_MIMES,
} from '../../src/presets/google.ts';

const FLASH_LITE_THINKING = ['minimal', 'low', 'medium', 'high'] as const;
const PRO_THINKING = ['low', 'medium', 'high'] as const;

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

const gemini35FlashLite: ModelSpec = {
  apiId: 'gemini-3.5-flash-lite',
  thinking: { on: 'high', off: 'minimal' },
  thinkingLevels: [...FLASH_LITE_THINKING],
  summaries: { on: 'auto', off: 'none' },
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
};

const gemini31FlashLite: ModelSpec = {
  apiId: 'gemini-3.1-flash-lite',
  thinking: { on: 'high', off: 'minimal' },
  thinkingLevels: [...FLASH_LITE_THINKING],
  summaries: { on: 'auto', off: 'none' },
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
};

const gemini31ProPreview: ModelSpec = {
  apiId: 'gemini-3.1-pro-preview',
  thinking: { on: 'high', off: 'low' },
  thinkingLevels: [...PRO_THINKING],
  summaries: { on: 'auto', off: 'none' },
  maxOutputTokens: 64_000,
  temperature: 1,
  builtInTools: [],
};

const gemini31FlashLiteImage: ModelSpec = {
  apiId: 'gemini-3.1-flash-lite-image',
  thinking: { on: 'high', off: 'minimal' },
  thinkingLevels: ['minimal', 'high'],
  summaries: { on: 'none', off: 'none' },
  maxOutputTokens: 4096,
  temperature: 1,
  builtInTools: [],
  key: 'paid',
};

const gemini31FlashTts: ModelSpec = {
  apiId: 'gemini-3.1-flash-tts-preview',
  thinking: { on: 'minimal', off: 'minimal' },
  thinkingLevels: ['minimal'],
  summaries: { on: 'none', off: 'none' },
  maxOutputTokens: 2048,
  temperature: 1,
  builtInTools: [],
};

const sonar: ModelSpec = {
  apiId: 'perplexity/sonar',
  thinking: { on: 'high', off: 'low' },
  thinkingLevels: [...PRO_THINKING],
  summaries: { on: 'none', off: 'none' },
  maxOutputTokens: 8192,
  temperature: 1,
  builtInTools: [],
};

/** Convenience map for tests that need several model ids. */
const HOST_MODELS = {
  gemini35FlashLite,
  gemini31FlashLite,
  gemini31ProPreview,
  gemini31FlashLiteImage,
  gemini31FlashTts,
  sonar,
} as const satisfies Record<string, ModelSpec>;

type HostModelId = keyof typeof HOST_MODELS;

/** Build `allow` + `config` from host fixture specs. */
function modelAllow(...ids: HostModelId[]): {
  allow: ModelId[];
  config: Record<ModelId, ModelSpec>;
} {
  const config: Record<ModelId, ModelSpec> = {};
  for (const id of ids) {
    config[id] = HOST_MODELS[id];
  }
  return { allow: [...ids], config };
}

/** Gemini Interactions model block for fixtures (protocol + provider + allow/config). */
function geminiModel(...ids: HostModelId[]): {
  allow: ModelId[];
  config: Record<ModelId, ModelSpec>;
  protocol: 'geminiInteractions';
  provider: 'google';
  key: 'slotA';
  thinking: 'minimal';
} {
  return {
    protocol: 'geminiInteractions',
    provider: 'google',
    key: 'slotA',
    thinking: 'minimal',
    ...modelAllow(...ids),
  };
}

export type { HostModelId };
export {
  CHAT_MEDIA_LIMITS,
  geminiModel,
  HOST_MODELS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_INPUT_MIMES,
  IMAGE_SIZES,
  modelAllow,
  VOICE_INPUT_MIMES,
};
