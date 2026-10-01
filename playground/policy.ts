/**
 * What the hosted playground allows on top of the kernel: Gemini runs on free-tier keys;
 * OpenRouter decisions use only the free Span model. TypeSafe has no free-model restriction.
 * AI Studio grounding quotas (Sep 2026): search is 1.5K
 * on Gemini 2 / 2.5 and 0 on Gemini 3; maps is 0 or 500 per model.
 */

import {
  isValidPair,
  isValidProfileProtocol,
  type Protocol,
  type Provider,
} from '../src/kernel/schema.ts';
import type { DecisionQuestion } from '../src/kernel/types.ts';
import { GOOGLE_BUILTIN_TOOLS } from '../src/presets/google.ts';
import type { ModelBindingDraft, PlaygroundProfileType } from './draft.ts';

export type PlaygroundConnectionMode = 'demo' | 'byok' | 'local';

/** The only OpenRouter model the playground key may call. */
export const OPENROUTER_PLAYGROUND_API_ID = 'openrouter/free';

/** Default Gemini chat model — the highest free requests-per-day in the quota table. */
export const GEMINI_PLAYGROUND_DEFAULT_API_ID = 'gemini-3.1-flash-lite';

export const GEMINI_PLAYGROUND_TTS_DEFAULT_API_ID = 'gemini-3.1-flash-tts-preview';

export const GEMINI_PLAYGROUND_IMAGE_DEFAULT_API_ID = 'gemini-3.1-flash-lite-image';

export const GEMINI_PLAYGROUND_LIVE_DEFAULT_API_ID = 'gemini-3.1-flash-live-preview';

/**
 * Most input tokens a Live session takes on the free key. The model pages list 131,072, but the
 * free key holds a session to about half, so this is playground policy, not the model's limit.
 * Context compression's trigger and target stay within it.
 */
export const GEMINI_PLAYGROUND_LIVE_INPUT_TOKENS = 65_536;

/** Each record goes back to the run tab's inspector; the server keeps nothing. */
export const PLAYGROUND_TRACE_DESTINATION = 'playground';

/** The only free Decisions API model offered by the public playground. */
export const OPENROUTER_DECISION_MODELS = [
  { id: 'respan/span-01-lite:free', label: 'Span 01 Lite Free' },
] as const;

/** The Jev model loaded by the decision example. */
export const JEV_PLAYGROUND_API_ID = 'jev-latest';

/** The most state a playground decision sends, in bytes. */
export const PLAYGROUND_DECISION_MAX_STATE_BYTES = 16_384;

/** At most this many questions, and this many options or levels in each. */
export const PLAYGROUND_DECISION_MAX_QUESTIONS = 8;
export const PLAYGROUND_DECISION_MAX_CRITERIA = 12;
/** The longest question instructions and option or level text the playground sends. */
export const PLAYGROUND_DECISION_MAX_INSTRUCTIONS_CHARS = 2_000;
export const PLAYGROUND_DECISION_MAX_CRITERION_CHARS = 500;
export const PLAYGROUND_DECISION_MAX_NAME_CHARS = 64;
export const PLAYGROUND_DECISION_MAX_ID_CHARS = 128;
/** Default and maximum request timeout on the site's decision keys. */
export const PLAYGROUND_DECISION_TIMEOUT_MS = 30_000;

type DecisionRoute = Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>;

function isSpanDecision(binding: DecisionRoute): boolean {
  return (
    binding.protocol === 'decision' && binding.provider === 'openrouter' &&
    binding.apiId.startsWith('respan/')
  );
}

/** Provider-specific request shape for the playground's Span binding. */
export function decisionQuestionViolation(
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>,
  question: DecisionQuestion,
): string | null {
  if (!isSpanDecision(binding)) return null;
  if (question.type !== 'noul') return 'Span accepts Number questions.';
  const criteria = question.criteria;
  if (
    !criteria || Object.keys(criteria).length !== 2 ||
    typeof criteria.true !== 'string' || !criteria.true.trim() ||
    typeof criteria.false !== 'string' || !criteria.false.trim()
  ) return 'Span needs true and false criteria with descriptions.';
  return null;
}

export function decisionStateViolation(
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>,
  state: unknown,
): string | null {
  if (!isSpanDecision(binding)) return null;
  if (typeof state === 'string') return null;
  if (
    typeof state === 'object' && state !== null && !Array.isArray(state) &&
    Object.keys(state).length > 0 &&
    Object.entries(state).every(([key, value]) =>
      (key === 'input' || key === 'output') && spanMessages(value),
    )
  ) return null;
  return 'Span state must be a string or input/output messages.';
}

/** Text, one role/content message, or a nonempty list of such messages. */
function spanMessages(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(spanMessage);
  return spanMessage(value);
}

function spanMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const message = value as Record<string, unknown>;
  return (
    typeof message.role === 'string' && !!message.role.trim() &&
    typeof message.content === 'string'
  );
}

export interface GeminiPlaygroundModel {
  id: string;
  label: string;
  profileType: PlaygroundProfileType;
  /** The model's map-grounding quota is non-zero. */
  mapGrounding: boolean;
  /** The model's search-grounding quota is non-zero. */
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

/** Gemini serves every type; OpenRouter's free router routes to chat models, so text only. */
export function playgroundRunsTransport(
  type: PlaygroundProfileType,
  protocol: Protocol,
  provider: Provider,
  mode: PlaygroundConnectionMode = 'demo',
): boolean {
  if (mode !== 'demo') {
    return browserRunsTransport(type, protocol, provider);
  }
  if (type === 'decision') {
    return protocol === 'decision' && (provider === 'typesafe' || provider === 'openrouter');
  }
  if (isGoogleTransport(protocol, provider)) return true;
  return isOpenRouterTransport(protocol, provider) && type === 'text';
}

function browserRunsTransport(type: PlaygroundProfileType, protocol: Protocol, provider: Provider): boolean {
  return isValidPair(protocol, provider) && isValidProfileProtocol(type, protocol) && (provider !== 'local' || type !== 'image');
}

/** A model the playground doesn't list isn't judged here; `modelBindingViolation` reports it. */
export function servesOtherProfileType(
  type: PlaygroundProfileType,
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>,
): boolean {
  if (binding.protocol === 'decision') return type !== 'decision';
  if (isOpenRouterTransport(binding.protocol, binding.provider)) {
    return type !== 'text';
  }
  if (!isGoogleTransport(binding.protocol, binding.provider)) return false;
  const model = geminiPlaygroundModel(binding.apiId);
  return model !== undefined && model.profileType !== type;
}

export function isProviderBuiltinId(name: string): boolean {
  return GOOGLE_BUILTIN_IDS.has(name);
}

export function allowedBuiltinsForGemini(apiId: string): string[] {
  const model = geminiPlaygroundModel(apiId);
  if (!model) return [];
  const out: string[] = [];
  if (model.searchGrounding) out.push('googleSearch');
  if (model.mapGrounding) out.push('googleMaps');
  out.push('urlContext');
  return out;
}

export function defaultBindingForProfileType(
  type: Exclude<PlaygroundProfileType, 'host'>,
): Pick<ModelBindingDraft, 'modelId' | 'protocol' | 'provider' | 'apiId'> {
  switch (type) {
    case 'decision':
      return {
        modelId: 'decision',
        protocol: 'decision',
        provider: 'typesafe',
        apiId: JEV_PLAYGROUND_API_ID,
      };
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

export interface ModelBindingViolation {
  field: 'provider' | 'apiId' | 'builtInTools';
  message: string;
}

/**
 * `null` when it can run. Checks the playground model catalog and Gemini free-tier quotas; whether a
 * model suits the profile type is the kernel's call.
 */
export function modelBindingViolation(
  binding: Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId' | 'builtInTools'>,
  mode: PlaygroundConnectionMode = 'demo',
): ModelBindingViolation | null {
  if (mode !== 'demo') {
    if (mode === 'local' && binding.provider !== 'local') {
      return {
        field: 'provider',
        message: 'Local runs require local models. Switch the model provider to Local.',
      };
    }
    return null;
  }
  const apiId = binding.apiId.trim();
  if (binding.protocol === 'decision') {
    if (binding.provider === 'typesafe') return null;
    if (binding.provider === 'openrouter') {
      return OPENROUTER_DECISION_MODELS.some((model) => model.id === apiId)
        ? null
        : { field: 'apiId', message: `${apiId} is not a playground OpenRouter decision model.`,
          };
    }
  }
  if (isOpenRouterTransport(binding.protocol, binding.provider)) {
    return apiId === OPENROUTER_PLAYGROUND_API_ID
      ? null
      : {
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
