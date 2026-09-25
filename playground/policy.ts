/**
 * Playground policy — what the hosted playground lets a draft run, on top of
 * what the kernel accepts. Not kernel truth: it reflects the free-tier keys the
 * playground runs on (Google AI Studio quotas, OpenRouter's free router).
 *
 * Grounding quotas in AI Studio (Sep 2026):
 * - Search grounding: Gemini 2 / 2.5 → 1.5K; Gemini 3 → 0.
 * - Map grounding: per model, 0 or 500 (see `mapGrounding` below).
 *
 * @module
 */

import type { Protocol, Provider } from '../src/kernel/schema.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../src/presets/google.ts';
import type { ModelBindingDraft, PlaygroundProfileType } from './draft.ts';

/** The only OpenRouter model the playground key may call. */
export const OPENROUTER_PLAYGROUND_API_ID = 'openrouter/free';

/** Default Gemini chat model — the highest free requests-per-day in the quota table. */
export const GEMINI_PLAYGROUND_DEFAULT_API_ID = 'gemini-3.1-flash-lite';

/** Default Gemini speech model on the free tier. */
export const GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID = 'gemini-3.1-flash-tts-preview';

/** Default Gemini image model on the free tier. */
export const GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID = 'gemini-3.1-flash-lite-image';

/** Default Gemini Live model on the free tier. */
export const GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID = 'gemini-3.1-flash-live-preview';

/**
 * Most input tokens a Live session takes on the free key. The model pages list 131,072, but the
 * free key holds a session to about half, so this is playground policy, not the model's limit.
 * Context compression's trigger and target stay within it.
 */
export const GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS = 65_536;

/**
 * Trace destination the playground server registers for `observability.writeTo`,
 * with a trace router's sink (`createPlaygroundTraceRouter`): each record goes
 * back to the run tab's inspector. The server keeps nothing.
 */
export const PLAYGROUND_TRACE_DESTINATION = 'playground';

export interface GeminiPlaygroundModel {
  id: string;
  label: string;
  /** The profile type the model is made for. */
  profileType: PlaygroundProfileType;
  /** Map grounding (`googleMaps`) — the model's map-grounding quota is non-zero. */
  mapGrounding: boolean;
  /** Search grounding (`googleSearch`) — the model's search-grounding quota is non-zero. */
  searchGrounding: boolean;
}

/**
 * Non-pro Gemini models with non-zero free-tier quotas (AI Studio, Sep 2026).
 * Wire ids verified against generativelanguage.googleapis.com/v1beta/models.
 */
export const GEMINI_PLAYGROUND_MODELS: readonly GeminiPlaygroundModel[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: '2.5 Flash Lite',
    profileType: 'text',
    mapGrounding: true,
    searchGrounding: true,
  },
  {
    id: 'gemini-2.5-flash',
    label: '2.5 Flash',
    profileType: 'text',
    mapGrounding: true,
    searchGrounding: true,
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: '2.5 Flash TTS',
    profileType: 'speech',
    mapGrounding: false,
    searchGrounding: true,
  },
  {
    id: 'gemini-3-flash-preview',
    label: '3 Flash',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: '3.1 Flash Lite',
    profileType: 'text',
    mapGrounding: true,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    label: '3.1 Flash Lite Image',
    profileType: 'image',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    label: '3.1 Flash TTS',
    profileType: 'speech',
    mapGrounding: true,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: '3.5 Flash Lite',
    profileType: 'text',
    mapGrounding: true,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.5-flash',
    label: '3.5 Flash',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.6-flash',
    label: '3.6 Flash',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.7-flash',
    label: '3.7 Flash',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.8-flash-tts',
    label: '3.8 Flash TTS',
    profileType: 'speech',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.8-flash-lite-tts',
    label: '3.8 Flash Lite TTS',
    profileType: 'speech',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemma-4-31b-it',
    label: 'Gemma 4 31B',
    profileType: 'text',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    label: '3.1 Flash Live',
    profileType: 'live',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.8-live',
    label: '3.8 Live',
    profileType: 'live',
    mapGrounding: false,
    searchGrounding: false,
  },
  {
    id: 'gemini-3.8-live-extended-thinking',
    label: '3.8 Live Extended Thinking',
    profileType: 'live',
    mapGrounding: false,
    searchGrounding: false,
  },
];

const GEMINI_BY_ID = new Map(GEMINI_PLAYGROUND_MODELS.map((model) => [model.id, model]));

/** Provider builtin ids — they belong on `models.*.builtInTools`, never on a custom tool. */
const GOOGLE_BUILTIN_IDS = new Set<string>(GOOGLE_BUILTIN_TOOLS.map((tool) => tool.name));

export function geminiPlaygroundModel(apiId: string): GeminiPlaygroundModel | undefined {
  return GEMINI_BY_ID.get(apiId.trim());
}

export function isGoogleTransport(protocol: Protocol, provider: Provider): boolean {
  return (protocol === 'geminiInteractions' || protocol === 'geminiLive') && provider === 'google';
}

export function isOpenRouterTransport(protocol: Protocol, provider: Provider): boolean {
  return protocol === 'openAi' && provider === 'openrouter';
}

/**
 * Whether the playground has a model on this transport for a profile type: Gemini
 * for every type, OpenRouter's free router for text only (it routes to chat models).
 */
export function playgroundRunsTransport(
  type: PlaygroundProfileType,
  protocol: Protocol,
  provider: Provider,
): boolean {
  if (isGoogleTransport(protocol, provider)) return true;
  return isOpenRouterTransport(protocol, provider) && type === 'text';
}

/**
 * Whether a binding is on a playground model made for another profile type. A
 * model the playground doesn't list isn't judged here; `modelBindingViolation`
 * reports it.
 */
export function servesOtherProfileType(
  type: PlaygroundProfileType,
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>,
): boolean {
  if (isOpenRouterTransport(binding.protocol, binding.provider)) return type !== 'text';
  if (!isGoogleTransport(binding.protocol, binding.provider)) return false;
  const model = geminiPlaygroundModel(binding.apiId);
  return model !== undefined && model.profileType !== type;
}

/** Whether `name` is a provider builtin id, which a custom tool may not take. */
export function isProviderBuiltinId(name: string): boolean {
  return GOOGLE_BUILTIN_IDS.has(name);
}

/** Builtins a playground Gemini model has free-tier quota for. */
export function allowedBuiltinsForGemini(apiId: string): string[] {
  const model = geminiPlaygroundModel(apiId);
  if (!model) return [];
  const out: string[] = [];
  if (model.searchGrounding) out.push('googleSearch');
  if (model.mapGrounding) out.push('googleMaps');
  out.push('urlContext');
  return out;
}

/** The model a new binding starts on for a profile type. */
export function defaultBindingForProfileType(
  type: PlaygroundProfileType,
): Pick<ModelBindingDraft, 'modelId' | 'protocol' | 'provider' | 'apiId'> {
  switch (type) {
    case 'live':
      return {
        modelId: 'live',
        protocol: 'geminiLive',
        provider: 'google',
        apiId: GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID,
      };
    case 'speech':
      return {
        modelId: 'voice',
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID,
      };
    case 'text':
      return {
        modelId: 'fast',
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: GEMINI_PLAYGROUND_DEFAULT_API_ID,
      };
    case 'image':
      return {
        modelId: 'image',
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID,
      };
  }
}

/** Why the playground can't run a binding, and the binding field that has to change. */
export interface ModelBindingViolation {
  field: 'provider' | 'apiId' | 'builtInTools';
  message: string;
}

/**
 * Why the playground can't run this binding, or `null` when it can. Checks only
 * the free-tier keys: which models they may call and which grounding quotas they
 * have. Whether a model suits the profile type is the kernel's and provider's.
 */
export function modelBindingViolation(
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId' | 'builtInTools'>,
): ModelBindingViolation | null {
  const apiId = binding.apiId.trim();
  if (isOpenRouterTransport(binding.protocol, binding.provider)) {
    return apiId === OPENROUTER_PLAYGROUND_API_ID ? null : {
      field: 'apiId',
      message: `OpenRouter models in the playground must use ${OPENROUTER_PLAYGROUND_API_ID}.`,
    };
  }
  if (!isGoogleTransport(binding.protocol, binding.provider)) {
    return {
      field: 'provider',
      message: `The playground runs Google and OpenRouter models only.`,
    };
  }
  const model = geminiPlaygroundModel(apiId);
  if (!model) {
    return {
      field: 'apiId',
      message: `${apiId} is not a playground Gemini model — pro and unrated models are blocked.`,
    };
  }
  const allowed = allowedBuiltinsForGemini(apiId);
  for (const builtin of binding.builtInTools) {
    if (allowed.includes(builtin)) continue;
    const field = 'builtInTools';
    if (builtin === 'googleMaps') {
      return {
        field,
        message: `${apiId} has no free-tier map-grounding quota — remove googleMaps.`,
      };
    }
    if (builtin === 'googleSearch') {
      return {
        field,
        message: `${apiId} has no free-tier search-grounding quota — remove googleSearch.`,
      };
    }
    return {
      field,
      message: `${builtin} is not allowed with ${apiId} on the playground free tier.`,
    };
  }
  return null;
}
