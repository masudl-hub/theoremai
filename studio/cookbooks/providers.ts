/**
 * Provider and model cookbooks: hosted builtin tool catalogs, provider-specific
 * media/voice vocabularies, and model/protocol binding rules.
 *
 * @module
 */

import {
  type ModelBinding,
  type ProfileImageSpec,
  type ProfileLiveSpec,
  type ProfileSpeechSpec,
  TheoremError,
} from '@theoremjs/agents';

/** The Gemini API's model list, which a connection check reads with a key. */
export const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini TTS voice names for `speech.voice` and `live.voice`. */
export const GOOGLE_SPEECH_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

/** The name of a Gemini speech voice. */
export type GoogleSpeechVoice = (typeof GOOGLE_SPEECH_VOICES)[number];

/** The thinking levels Gemini's `thinkingLevel` takes; OpenRouter models take them all. */
export const GOOGLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

/** The audio format Gemini speech returns (PCM, wrapped as WAV); OpenRouter speech also takes `mp3`. */
export const GOOGLE_SPEECH_FORMATS = ['pcm'] as const;

/** A thinking level Gemini takes: minimal, low, medium, or high. */
export type GoogleThinkingLevel = (typeof GOOGLE_THINKING_LEVELS)[number];

/**
 * A `geminiInteractions` or `geminiLive` binding's `efforts`, typed to the levels Gemini takes.
 * The runtime check refuses an untyped host's level when the binding is built, not when a turn runs.
 */
export function googleEfforts<Efforts extends Record<string, GoogleThinkingLevel>>(
  efforts: Efforts,
): Efforts {
  for (const [alias, level] of Object.entries(efforts)) {
    if (!(GOOGLE_THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new TheoremError(
        'config',
        `Effort '${alias}': Gemini does not take '${level}' (${GOOGLE_THINKING_LEVELS.join(', ')})`,
      );
    }
  }
  return efforts;
}

/** The image MIME types a Gemini profile can take as input. */
export const GOOGLE_IMAGE_INPUT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** The audio MIME types a Gemini profile can take as voice input. */
export const GOOGLE_VOICE_INPUT_MIMES = [
  'audio/webm',
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
] as const;

/**
 * TTS models that reject any history with a model turn, so compaction's summary fails them
 * (live, 29/09/2026).
 */
export const GOOGLE_SINGLE_TURN_API_IDS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-3.1-flash-tts-preview',
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
] as const;

/**
 * Models that reject any thinking setting, `summaries: false` included: leave
 * `efforts` and `summaries` unset (live, 30/09/2026).
 */
export const GOOGLE_NO_THINKING_API_IDS = [
  'gemini-2.5-flash-image',
  'antigravity-preview-05-2026',
  'antigravity-preview-09-2026',
  'antigravity-preview-latest',
] as const;

/**
 * Models that refuse a thinking level and take `summaries`: leave `efforts` unset
 * (live, 01/10/2026: Live closes 1007 "Thinking level is not supported for this model";
 * 04/10/2026: setup takes `includeThoughts` either way).
 */
export const GOOGLE_NO_EFFORT_API_IDS = ['gemini-3.8-live'] as const;

/**
 * Models that refuse a session without a thinking level: pin `efforts`
 * (live, 01/10/2026: Live closes 1007 "Thinking level must be specified for this model").
 */
export const GOOGLE_THINKING_REQUIRED_API_IDS = ['gemini-3.8-live-extended-thinking'] as const;

/** Which grounding builtins a model's free-tier quota allows. */
export interface GoogleFreeTierGrounding {
  googleSearch: boolean;
  googleMaps: boolean;
}

const grounding = (googleSearch: boolean, googleMaps: boolean): GoogleFreeTierGrounding => ({
  googleSearch,
  googleMaps,
});

/**
 * Models with a non-zero free-tier quota, and the grounding each allows (AI Studio, Sep 2026).
 * No model keeps free Maps quota: 3.5 Flash-Lite turns with Maps are refused as over quota
 * (live, 13/10/2026).
 * A builtin with no quota is refused as if over quota: on Live, a close 1011 "You exceeded your
 * current quota" at setup, whatever the key's usage (live, 01/10/2026).
 */
export const GOOGLE_FREE_TIER_GROUNDING: Readonly<Record<string, GoogleFreeTierGrounding>> = {
  'gemini-2.5-flash-lite': grounding(true, false),
  'gemini-2.5-flash': grounding(true, false),
  'gemini-2.5-flash-preview-tts': grounding(true, false),
  'gemini-3-flash-preview': grounding(false, false),
  'gemini-3.1-flash-lite': grounding(false, false),
  'gemini-3.1-flash-lite-image': grounding(false, false),
  'gemini-3.1-flash-tts-preview': grounding(false, false),
  'gemini-3.5-flash-lite': grounding(false, false),
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
export function googleFreeTierBuiltins(apiId: string): Array<'googleSearch' | 'googleMaps'> {
  const allowed = GOOGLE_FREE_TIER_GROUNDING[apiId.trim()];
  if (!allowed) return [];
  return (['googleSearch', 'googleMaps'] as const).filter((id) => allowed[id]);
}

/** A Gemini binding field that breaks a Gemini rule, and what is wrong with it. */
export interface GoogleBindingViolation {
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
export function googleBindingViolation(
  binding: Pick<ModelBinding, 'apiId' | 'efforts' | 'summaries' | 'builtInTools'>,
  options: { freeTier?: boolean } = {},
): GoogleBindingViolation | undefined {
  const apiId = binding.apiId.trim();
  const noThinking: readonly string[] = GOOGLE_NO_THINKING_API_IDS;
  const noEffort: readonly string[] = GOOGLE_NO_EFFORT_API_IDS;
  const thinkingRequired: readonly string[] = GOOGLE_THINKING_REQUIRED_API_IDS;
  if ((noThinking.includes(apiId) || noEffort.includes(apiId)) && pinsEffort(binding)) {
    return {
      field: 'efforts',
      message: `${apiId} takes no thinking level; leave efforts unset.`,
    };
  }
  if (noThinking.includes(apiId) && binding.summaries !== undefined) {
    return {
      field: 'summaries',
      message: `${apiId} takes no thinking setting; leave summaries unset.`,
    };
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

/** The speech settings a Gemini profile may pin, with the voice narrowed to Gemini's. */
export type GoogleSpeechPins = Omit<ProfileSpeechSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

/** The live settings a Gemini profile may pin, with the voice narrowed to Gemini's. */
export type GoogleLivePins = Omit<ProfileLiveSpec, 'voice'> & {
  voice?: GoogleSpeechVoice;
};

/** The aspect ratios a Gemini image model can return. */
export const GOOGLE_IMAGE_ASPECT_RATIOS = [
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

/** The resolutions a Gemini image model can return. */
export const GOOGLE_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;

/** What a Gemini image model can be asked to return. */
export const GOOGLE_IMAGE_OUTPUT_MIMES = ['image/png', 'image/jpeg'] as const;

/** One of {@linkcode GOOGLE_IMAGE_INPUT_MIMES}. */
export type GoogleImageInputMime = (typeof GOOGLE_IMAGE_INPUT_MIMES)[number];
/** One of {@linkcode GOOGLE_VOICE_INPUT_MIMES}. */
export type GoogleVoiceInputMime = (typeof GOOGLE_VOICE_INPUT_MIMES)[number];
/** One of {@linkcode GOOGLE_IMAGE_ASPECT_RATIOS}. */
export type GoogleImageAspectRatio = (typeof GOOGLE_IMAGE_ASPECT_RATIOS)[number];
/** One of {@linkcode GOOGLE_IMAGE_RESOLUTIONS}. */
export type GoogleImageResolution = (typeof GOOGLE_IMAGE_RESOLUTIONS)[number];
/** One of {@linkcode GOOGLE_IMAGE_OUTPUT_MIMES}. */
export type GoogleImageOutputMime = (typeof GOOGLE_IMAGE_OUTPUT_MIMES)[number];

/** The image settings a Gemini profile may pin, narrowed to what Gemini accepts. */
export type GoogleImagePins = Omit<ProfileImageSpec, 'aspectRatio' | 'resolution' | 'mimeType'> & {
  aspectRatio?: GoogleImageAspectRatio;
  resolution?: GoogleImageResolution;
  mimeType?: GoogleImageOutputMime;
};

/** The tools Gemini runs itself, as `builtin` tool definitions. */
export const GOOGLE_BUILTIN_TOOLS = [
  {
    type: 'builtin' as const,
    name: 'googleSearch',
    description: 'Google Search grounding',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
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
    // why: Google refuses a request that carries Maps with Search or URL context.
    conflictsWith: ['googleSearch', 'urlContext'],
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
  },
];

/** `/images` takes image references only; a profile on it lists nothing wider in `inputs.attachments.accept`. */
export const OPENROUTER_IMAGES_INPUT_MIMES = ['image/*'] as const;

/**
 * What `/images` never sends the model: it reads the prompt text and the reference images
 * only. The chat path (`image.includeText`) sends the system prompt and history.
 */
export const OPENROUTER_IMAGES_IGNORED_INPUTS = ['system', 'history'] as const;

/** The tools OpenRouter runs itself, as `builtin` tool definitions. */
export const OPENROUTER_BUILTIN_TOOLS = [
  {
    type: 'builtin' as const,
    name: 'webSearch',
    description: 'OpenRouter web search',
    category: 'grounding',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
  },
];

/**
 * Whether an Ollama model thinks, read from the server's `POST /api/show` reply for it:
 * `capabilities` lists `thinking` (Ollama 0.34.0, 04/10/2026). The host fetches the reply.
 */
export function ollamaModelThinks(show: unknown): boolean {
  if (!show || typeof show !== 'object') return false;
  const { capabilities } = show as { capabilities?: unknown };
  return Array.isArray(capabilities) && capabilities.includes('thinking');
}

/** A local binding field its model would refuse, and what is wrong with it. */
export interface LocalBindingViolation {
  field: 'efforts';
  message: string;
}

/**
 * The first setting a local server would refuse on this binding, or `undefined`. A thinking
 * level goes to the server as `reasoning_effort`; Ollama answers HTTP 400 "does not support
 * thinking" for a model that does not think (04/10/2026).
 */
export function localBindingViolation(
  binding: Pick<ModelBinding, 'apiId' | 'efforts'>,
  model: { thinks: boolean },
): LocalBindingViolation | undefined {
  if (!model.thinks && Object.keys(binding.efforts ?? {}).length > 0) {
    return {
      field: 'efforts',
      message: `${binding.apiId.trim()} does not think; leave efforts unset.`,
    };
  }
  return undefined;
}
