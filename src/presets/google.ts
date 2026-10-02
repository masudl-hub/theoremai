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
import {
  GOOGLE_SPEECH_FORMATS,
  GOOGLE_THINKING_LEVELS,
  type GoogleThinkingLevel,
  googleEfforts,
} from './google-limits.ts';

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
  // Live closes 1007 "Thinking level is not supported for this model" (live, 01/10/2026).
  'gemini-3.8-live',
] as const;

/**
 * Models that refuse a session without a thinking level: pin `efforts`
 * (live, 01/10/2026: Live closes 1007 "Thinking level must be specified for this model").
 */
const GOOGLE_THINKING_REQUIRED_API_IDS = ['gemini-3.8-live-extended-thinking'] as const;

/** Which grounding builtins a model's free-tier quota allows. */
interface GoogleFreeTierGrounding {
  googleSearch: boolean;
  googleMaps: boolean;
}

const grounding = (googleSearch: boolean, googleMaps: boolean): GoogleFreeTierGrounding => ({
  googleSearch,
  googleMaps,
});

/**
 * Models with a non-zero free-tier quota, and the grounding each allows (AI Studio, Sep 2026).
 * A builtin with no quota is refused as if over quota: on Live, a close 1011 "You exceeded your
 * current quota" at setup, whatever the key's usage (live, 01/10/2026).
 */
const GOOGLE_FREE_TIER_GROUNDING: Readonly<Record<string, GoogleFreeTierGrounding>> = {
  'gemini-2.5-flash-lite': grounding(true, true),
  'gemini-2.5-flash': grounding(true, true),
  'gemini-2.5-flash-preview-tts': grounding(true, false),
  'gemini-3-flash-preview': grounding(false, false),
  'gemini-3.1-flash-lite': grounding(false, true),
  'gemini-3.1-flash-lite-image': grounding(false, false),
  'gemini-3.1-flash-tts-preview': grounding(false, true),
  'gemini-3.5-flash-lite': grounding(false, true),
  'gemini-3.5-flash': grounding(false, false),
  'gemini-3.6-flash': grounding(false, false),
  'gemini-3.7-flash': grounding(false, false),
  'gemini-3.8-flash-tts': grounding(false, false),
  'gemini-3.8-flash-lite-tts': grounding(false, false),
  'gemma-4-26b-a4b-it': grounding(false, false),
  'gemma-4-31b-it': grounding(false, false),
  'gemini-3.1-flash-live-preview': grounding(false, false),
  'gemini-3.8-live': grounding(false, false),
  'gemini-3.8-live-extended-thinking': grounding(false, false),
};

/** Grounding builtins the free tier allows on `apiId`; none for a model with no free quota. */
function googleFreeTierBuiltins(apiId: string): Array<'googleSearch' | 'googleMaps'> {
  const allowed = GOOGLE_FREE_TIER_GROUNDING[apiId.trim()];
  if (!allowed) return [];
  return (['googleSearch', 'googleMaps'] as const).filter((id) => allowed[id]);
}

interface GoogleBindingViolation {
  field: 'apiId' | 'efforts' | 'summaries' | 'builtInTools';
  message: string;
}

function pinsEffort(binding: Pick<ModelBinding, 'efforts'>): boolean {
  return Object.keys(binding.efforts ?? {}).length > 0;
}

/**
 * The first setting Google would refuse on this binding, or `undefined`. With `freeTier`, it
 * also holds the binding to the free-tier table: a listed model, and only the grounding its
 * quota allows.
 */
function googleBindingViolation(
  binding: Pick<ModelBinding, 'apiId' | 'efforts' | 'summaries' | 'builtInTools'>,
  options: { freeTier?: boolean } = {},
): GoogleBindingViolation | undefined {
  const apiId = binding.apiId.trim();
  const noThinking: readonly string[] = GOOGLE_NO_THINKING_API_IDS;
  const thinkingRequired: readonly string[] = GOOGLE_THINKING_REQUIRED_API_IDS;
  if (noThinking.includes(apiId)) {
    if (pinsEffort(binding)) {
      return {
        field: 'efforts',
        message: `${apiId} takes no thinking level; leave efforts unset.`,
      };
    }
    if (binding.summaries !== undefined) {
      return {
        field: 'summaries',
        message: `${apiId} takes no thinking setting; leave summaries unset.`,
      };
    }
  }
  if (thinkingRequired.includes(apiId) && !pinsEffort(binding)) {
    return { field: 'efforts', message: `${apiId} needs a thinking level; pin efforts.` };
  }
  if (!options.freeTier) return undefined;
  if (!GOOGLE_FREE_TIER_GROUNDING[apiId]) {
    return { field: 'apiId', message: `${apiId} has no free-tier quota.` };
  }
  const allowed: readonly string[] = googleFreeTierBuiltins(apiId);
  for (const builtin of binding.builtInTools ?? []) {
    if ((builtin === 'googleSearch' || builtin === 'googleMaps') && !allowed.includes(builtin)) {
      return { field: 'builtInTools', message: `${apiId} has no free-tier quota for ${builtin}.` };
    }
  }
  return undefined;
}

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
  GoogleBindingViolation,
  GoogleFreeTierGrounding,
  GoogleImageAspectRatio,
  GoogleImageInputMime,
  GoogleImageOutputMime,
  GoogleImagePins,
  GoogleImageResolution,
  GoogleInteractionsPersistence,
  GoogleLivePins,
  GoogleSpeechPins,
  GoogleSpeechVoice,
  GoogleThinkingLevel,
  GoogleVoiceInputMime,
};
export {
  GOOGLE_BUILTIN_TOOLS,
  GOOGLE_FREE_TIER_GROUNDING,
  GOOGLE_IMAGE_ASPECT_RATIOS,
  GOOGLE_IMAGE_INPUT_MIMES,
  GOOGLE_IMAGE_OUTPUT_MIMES,
  GOOGLE_IMAGE_RESOLUTIONS,
  GOOGLE_NO_THINKING_API_IDS,
  GOOGLE_SINGLE_TURN_API_IDS,
  GOOGLE_SPEECH_FORMATS,
  GOOGLE_SPEECH_VOICES,
  GOOGLE_THINKING_LEVELS,
  GOOGLE_THINKING_REQUIRED_API_IDS,
  GOOGLE_VOICE_INPUT_MIMES,
  googleBindingViolation,
  googleEfforts,
  googleFreeTierBuiltins,
  googleInteractionsPersistence,
  registerGooglePreset,
};
