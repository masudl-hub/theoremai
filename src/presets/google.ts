/**
 * Google / Gemini convenience preset.
 *
 * @module
 */

import { registerTools } from '../kernel/default-scope.ts';
import type {
  ModelBinding,
  ProfileImageSpec,
  ProfileLiveSpec,
  ProfileSpeechSpec,
} from '../kernel/types.ts';
import { GOOGLE_SPEECH_VOICES, type GoogleSpeechVoice } from './google/speech-voices.ts';

/** Common Gemini image input MIME allowlist. */
const GOOGLE_IMAGE_INPUT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** Common voice/audio input MIME allowlist for Gemini multimodal. */
const GOOGLE_VOICE_INPUT_MIMES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'] as const;

type GoogleSpeechPins = Omit<ProfileSpeechSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

type GoogleLivePins = Omit<ProfileLiveSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

/** Aspect ratios accepted by the Google image preset. */
const GOOGLE_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '3:2',
  '2:3',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

/** Output sizes currently exposed by the Google image preset. */
const GOOGLE_IMAGE_SIZES = ['1K'] as const;

/** MIME type accepted for image input by the Google convenience preset. */
type GoogleImageInputMime = (typeof GOOGLE_IMAGE_INPUT_MIMES)[number];
/** MIME type accepted for voice input by the Google convenience preset. */
type GoogleVoiceInputMime = (typeof GOOGLE_VOICE_INPUT_MIMES)[number];
/** Aspect-ratio option accepted by the Google image preset. */
type GoogleImageAspectRatio = (typeof GOOGLE_IMAGE_ASPECT_RATIOS)[number];
/** Output-size option accepted by the Google image preset. */
type GoogleImageSize = (typeof GOOGLE_IMAGE_SIZES)[number];

/** Image profile fields narrowed to values supported by the Google preset. */
type GoogleImagePins = Omit<ProfileImageSpec, 'aspectRatio' | 'size' | 'mimeType'> & {
  aspectRatio?: GoogleImageAspectRatio;
  size?: GoogleImageSize;
  mimeType?: GoogleImageInputMime | 'image/jpeg';
};

/** Built-in Google tools registered by the Google convenience preset. */
const GOOGLE_BUILTIN_TOOLS = [
  {
    type: 'builtin' as const,
    name: 'googleSearch',
    description: 'Google Search grounding',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    forcePaidKey: true,
    wire: { interactions: 'google_search', openRouter: 'web', live: 'googleSearch' },
  },
  {
    type: 'builtin' as const,
    name: 'googleMaps',
    description: 'Google Maps grounding',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    wire: { interactions: 'google_maps', live: 'googleMaps' },
  },
  {
    type: 'builtin' as const,
    name: 'urlContext',
    description: 'Fetch URL context',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    wire: { interactions: 'url_context', live: 'urlContext' },
  },
  {
    type: 'builtin' as const,
    name: 'codeExecution',
    description: 'Google code execution',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    wire: { interactions: 'code_execution', live: 'codeExecution' },
  },
];

/** How a Gemini Interactions binding keeps its turns: `store` and `persistViaInteractionId` together. */
type GoogleInteractionsPersistence = Required<
  Pick<ModelBinding, 'store' | 'persistViaInteractionId'>
>;

/**
 * Spread into a Gemini Interactions binding. Google chains a turn onto the
 * last one (`previous_interaction_id`) only when it stored that interaction,
 * so both settings move together: `true` keeps turns on Google and chains
 * them, `false` stores nothing and the host sends the history every turn.
 */
function googleInteractionsPersistence(chained: boolean): GoogleInteractionsPersistence {
  return { store: chained, persistViaInteractionId: chained };
}

/** Register the Google builtins in the default scope; a scope of its own takes `GOOGLE_BUILTIN_TOOLS`. */
function registerGooglePreset(): void {
  registerTools(GOOGLE_BUILTIN_TOOLS);
}

export type {
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImagePins,
  GoogleImageSize,
  GoogleInteractionsPersistence,
  GoogleLivePins,
  GoogleSpeechPins,
  GoogleSpeechVoice,
  GoogleVoiceInputMime,
};
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_SIZES,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_VOICE_INPUT_MIMES,
  googleInteractionsPersistence,
  registerGooglePreset,
};
