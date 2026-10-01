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

const GOOGLE_IMAGE_INPUT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

const GOOGLE_VOICE_INPUT_MIMES = ['audio/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'] as const;

/**
 * TTS models that reject any history with a model turn, so compaction's summary fails them
 * (live, 29/09/2026).
 */
const GOOGLE_SINGLE_TURN_API_IDS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
] as const;

/**
 * Models that reject any thinking setting, `summaries: false` included: leave
 * `efforts` and `summaries` unset (live, 30/09/2026).
 */
const GOOGLE_NO_THINKING_API_IDS = [
  'gemini-2.5-flash-image',
  'antigravity-preview-05-2026',
  'antigravity-preview-09-2026',
  'antigravity-preview-latest',
] as const;

type GoogleSpeechPins = Omit<ProfileSpeechSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

type GoogleLivePins = Omit<ProfileLiveSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

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

const GOOGLE_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;

/** What a Gemini image model can be asked to return. */
const GOOGLE_IMAGE_OUTPUT_MIMES = ['image/png', 'image/jpeg'] as const;

type GoogleImageInputMime = (typeof GOOGLE_IMAGE_INPUT_MIMES)[number];
type GoogleVoiceInputMime = (typeof GOOGLE_VOICE_INPUT_MIMES)[number];
type GoogleImageAspectRatio = (typeof GOOGLE_IMAGE_ASPECT_RATIOS)[number];
type GoogleImageResolution = (typeof GOOGLE_IMAGE_RESOLUTIONS)[number];
type GoogleImageOutputMime = (typeof GOOGLE_IMAGE_OUTPUT_MIMES)[number];

type GoogleImagePins = Omit<ProfileImageSpec, 'aspectRatio' | 'resolution' | 'mimeType'> & {
  aspectRatio?: GoogleImageAspectRatio;
  resolution?: GoogleImageResolution;
  mimeType?: GoogleImageOutputMime;
};

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

type GoogleInteractionsPersistence = Required<
  Pick<ModelBinding, 'store' | 'persistViaInteractionId'>
>;

/**
 * Google chains a turn (`previous_interaction_id`) only onto a stored interaction, so
 * both settings move together; `false` stores nothing and the host resends history.
 */
function googleInteractionsPersistence(chained: boolean): GoogleInteractionsPersistence {
  return { store: chained, persistViaInteractionId: chained };
}

/** Registers into the default scope; a scope of its own takes `GOOGLE_BUILTIN_TOOLS`. */
function registerGooglePreset(): void {
  registerTools(GOOGLE_BUILTIN_TOOLS);
}

export type {
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImageOutputMime,
  GoogleImagePins,
  GoogleImageResolution,
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
  GOOGLE_IMAGE_OUTPUT_MIMES,
  GOOGLE_IMAGE_RESOLUTIONS,
  GOOGLE_NO_THINKING_API_IDS,
  GOOGLE_SINGLE_TURN_API_IDS,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_VOICE_INPUT_MIMES,
  googleInteractionsPersistence,
  registerGooglePreset,
};
