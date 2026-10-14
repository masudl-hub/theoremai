/**
 * What the hosted studio allows on top of the kernel: Gemini runs on free-tier keys;
 * OpenRouter decisions use only the free Span model. TypeSafe has no free-model restriction.
 * Which grounding each model's free quota allows is the Google preset's table.
 */

import type { DecisionQuestion } from '../src/kernel/types.ts';
import { GOOGLE_BUILTIN_TOOLS, googleFreeTierBuiltins } from '../src/presets/google.ts';
import type { ModelBindingDraft, StudioProfileType } from './draft.ts';
import { LOCAL_PROVIDER_ID, type ModelRoute, servesProfileType } from './providers.ts';

export type StudioConnectionMode = 'demo' | 'byok' | 'local';

/**
 * The settings the studio sets for itself on a profile it opens, by path (`*` is any one key): a
 * decision takes the studio's state limit, and a run's records go to the page, since a run in the
 * studio is a test. A profile in the studio differs from the project's in these and in nothing else.
 */
export const STUDIO_POLICY_PATHS: readonly string[] = ['inputs.maxStateBytes', 'observability.writeTo'];

/** The only OpenRouter model the studio key may call. */
export const OPENROUTER_STUDIO_API_ID = 'openrouter/free';

/** Default Gemini chat model — the highest free requests-per-day in the quota table. */
export const GEMINI_STUDIO_DEFAULT_API_ID = 'gemini-3.1-flash-lite';

export const GEMINI_STUDIO_TTS_DEFAULT_API_ID = 'gemini-3.1-flash-tts-preview';

export const GEMINI_STUDIO_IMAGE_DEFAULT_API_ID = 'gemini-3.1-flash-lite-image';

export const GEMINI_STUDIO_LIVE_DEFAULT_API_ID = 'gemini-3.1-flash-live-preview';

/**
 * Most input tokens a Live session takes on the free key. The model pages list 131,072, but the
 * free key holds a session to about half, so this is studio policy, not the model's limit.
 * Context compression's trigger and target stay within it.
 */
export const GEMINI_STUDIO_LIVE_INPUT_TOKENS = 65_536;

/** Each record goes back to the run tab's inspector; the server keeps nothing. */
export const STUDIO_TRACE_DESTINATION = 'studio';

/** The only free Decisions API model offered by the public studio. */
export const OPENROUTER_DECISION_MODELS = [
  { id: 'respan/span-01-lite:free', label: 'Span 01 Lite Free' },
] as const;

/** The Jev model loaded by the decision example. */
export const JEV_STUDIO_API_ID = 'jev-latest';

/** The most state a studio decision sends, in bytes. */
export const STUDIO_DECISION_MAX_STATE_BYTES = 16_384;

/** At most this many questions, and this many options or levels in each. */
export const STUDIO_DECISION_MAX_QUESTIONS = 8;
export const STUDIO_DECISION_MAX_CRITERIA = 12;
/** The longest question instructions and option or level text the studio sends. */
export const STUDIO_DECISION_MAX_INSTRUCTIONS_CHARS = 2_000;
export const STUDIO_DECISION_MAX_CRITERION_CHARS = 500;
export const STUDIO_DECISION_MAX_NAME_CHARS = 64;
export const STUDIO_DECISION_MAX_ID_CHARS = 128;
/** Default and maximum request timeout on the site's decision keys. */
export const STUDIO_DECISION_TIMEOUT_MS = 30_000;

export type DecisionRoute = Pick<ModelRoute, 'adapter' | 'apiId' | 'decision'>;

function isSpanDecision(binding: DecisionRoute): boolean {
  return (
    binding.decision && binding.adapter === 'openrouter' && binding.apiId.startsWith('respan/')
  );
}

/** Provider-specific request shape for the studio's Span binding. */
export function decisionQuestionViolation(
  binding: DecisionRoute,
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
  binding: DecisionRoute,
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

export interface GeminiStudioModel {
  id: string;
  label: string;
  profileType: StudioProfileType;
}

/**
 * Non-pro Gemini models with non-zero free-tier quotas (AI Studio, Sep 2026).
 * Wire ids verified against generativelanguage.googleapis.com/v1beta/models.
 */
export const GEMINI_STUDIO_MODELS: readonly GeminiStudioModel[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: '2.5 Flash Lite',
    profileType: 'text',
  },
  {
    id: 'gemini-2.5-flash',
    label: '2.5 Flash',
    profileType: 'text',
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: '2.5 Flash TTS',
    profileType: 'speech',
  },
  {
    id: 'gemini-3-flash-preview',
    label: '3 Flash',
    profileType: 'text',
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: '3.1 Flash Lite',
    profileType: 'text',
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    label: '3.1 Flash Lite Image',
    profileType: 'image',
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    label: '3.1 Flash TTS',
    profileType: 'speech',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: '3.5 Flash Lite',
    profileType: 'text',
  },
  {
    id: 'gemini-3.5-flash',
    label: '3.5 Flash',
    profileType: 'text',
  },
  {
    id: 'gemini-3.6-flash',
    label: '3.6 Flash',
    profileType: 'text',
  },
  {
    id: 'gemini-3.7-flash',
    label: '3.7 Flash',
    profileType: 'text',
  },
  {
    id: 'gemini-3.8-flash-tts',
    label: '3.8 Flash TTS',
    profileType: 'speech',
  },
  {
    id: 'gemini-3.8-flash-lite-tts',
    label: '3.8 Flash Lite TTS',
    profileType: 'speech',
  },
  {
    id: 'gemma-4-26b-a4b-it',
    label: 'Gemma 4 26B',
    profileType: 'text',
  },
  {
    id: 'gemma-4-31b-it',
    label: 'Gemma 4 31B',
    profileType: 'text',
  },
  {
    id: 'gemini-3.1-flash-live-preview',
    label: '3.1 Flash Live',
    profileType: 'live',
  },
  {
    id: 'gemini-3.8-live',
    label: '3.8 Live',
    profileType: 'live',
  },
  {
    id: 'gemini-3.8-live-extended-thinking',
    label: '3.8 Live Extended Thinking',
    profileType: 'live',
  },
];

const GEMINI_BY_ID = new Map(GEMINI_STUDIO_MODELS.map((model) => [model.id, model]));

/** Provider builtin ids — they belong on `models.*.builtInTools`, never on a custom tool. */
const GOOGLE_BUILTIN_IDS = new Set<string>(GOOGLE_BUILTIN_TOOLS.map((tool) => tool.name));

export function geminiStudioModel(apiId: string): GeminiStudioModel | undefined {
  return GEMINI_BY_ID.get(apiId.trim());
}

/** A model served through Google's adapter. */
export function isGoogleRoute(route: Pick<ModelRoute, 'adapter'>): boolean {
  return route.adapter === 'google';
}

/** A model served through OpenRouter's adapter. */
export function isOpenRouterRoute(route: Pick<ModelRoute, 'adapter'>): boolean {
  return route.adapter === 'openrouter';
}

/**
 * Whether the studio runs agents of `type` on a provider. On the site's keys Gemini serves every
 * type, and OpenRouter's free router routes to chat models, so text only. On the builder's own
 * keys or machine it is the adapter's answer.
 */
export function studioRunsProvider(
  type: Exclude<StudioProfileType, 'host'>,
  provider: Pick<ModelRoute, 'adapter'>,
  mode: StudioConnectionMode = 'demo',
): boolean {
  if (mode !== 'demo') return servesProfileType(provider.adapter, type);
  if (type === 'decision') return provider.adapter === 'typesafe' || isOpenRouterRoute(provider);
  if (isGoogleRoute(provider)) return true;
  return isOpenRouterRoute(provider) && type === 'text';
}

/** A model the studio doesn't list isn't judged here; `modelBindingViolation` reports it. */
export function servesOtherProfileType(
  type: StudioProfileType,
  route: Pick<ModelRoute, 'adapter' | 'apiId'>,
): boolean {
  if (isOpenRouterRoute(route)) {
    const decides = OPENROUTER_DECISION_MODELS.some((model) => model.id === route.apiId.trim());
    return decides ? type !== 'decision' : type !== 'text';
  }
  if (!isGoogleRoute(route)) return false;
  const model = geminiStudioModel(route.apiId);
  return model !== undefined && model.profileType !== type;
}

export function isProviderBuiltinId(name: string): boolean {
  return GOOGLE_BUILTIN_IDS.has(name);
}

export function allowedBuiltinsForGemini(apiId: string): string[] {
  if (!geminiStudioModel(apiId)) return [];
  return [...googleFreeTierBuiltins(apiId), 'urlContext'];
}

export function defaultBindingForProfileType(
  type: Exclude<StudioProfileType, 'host'>,
): Pick<ModelBindingDraft, 'modelId' | 'provider' | 'apiId'> {
  switch (type) {
    case 'decision':
      return {
        modelId: 'decision',
        provider: 'typesafe',
        apiId: JEV_STUDIO_API_ID,
      };
    case 'live':
      return {
        modelId: 'live',
        provider: 'google',
        apiId: GEMINI_STUDIO_LIVE_DEFAULT_API_ID,
      };
    case 'speech':
      return {
        modelId: 'voice',
        provider: 'google',
        apiId: GEMINI_STUDIO_TTS_DEFAULT_API_ID,
      };
    case 'text':
      return {
        modelId: 'fast',
        provider: 'google',
        apiId: GEMINI_STUDIO_DEFAULT_API_ID,
      };
    case 'image':
      return {
        modelId: 'image',
        provider: 'google',
        apiId: GEMINI_STUDIO_IMAGE_DEFAULT_API_ID,
      };
  }
}

export interface ModelBindingViolation {
  field: 'provider' | 'apiId' | 'builtInTools';
  message: string;
}

/**
 * `null` when it can run. Checks the studio model catalog and Gemini free-tier quotas; whether a
 * model suits the profile type is the kernel's call.
 */
export function modelBindingViolation(
  binding: ModelRoute & Pick<ModelBindingDraft, 'builtInTools'>,
  mode: StudioConnectionMode = 'demo',
): ModelBindingViolation | null {
  if (mode !== 'demo') {
    if (mode === 'local' && binding.provider !== LOCAL_PROVIDER_ID) {
      return {
        field: 'provider',
        message: 'Local runs require local models. Switch the model provider to Local.',
      };
    }
    return null;
  }
  const apiId = binding.apiId.trim();
  if (binding.decision) {
    if (binding.adapter === 'typesafe') return null;
    if (isOpenRouterRoute(binding)) {
      return OPENROUTER_DECISION_MODELS.some((model) => model.id === apiId)
        ? null
        : { field: 'apiId', message: `${apiId} is not a studio OpenRouter decision model.`,
          };
    }
  }
  if (isOpenRouterRoute(binding)) {
    return apiId === OPENROUTER_STUDIO_API_ID
      ? null
      : {
          field: 'apiId',
          message: `OpenRouter models in the studio must use ${OPENROUTER_STUDIO_API_ID}.`,
        };
  }
  if (!isGoogleRoute(binding)) {
    return {
      field: 'provider',
      message: `The studio runs Google and OpenRouter models only.`,
    };
  }
  const model = geminiStudioModel(apiId);
  if (!model) {
    return {
      field: 'apiId',
      message: `${apiId} is not a studio Gemini model — pro and unrated models are blocked.`,
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
      message: `${builtin} is not allowed with ${apiId} on the studio free tier.`,
    };
  }
  return null;
}
