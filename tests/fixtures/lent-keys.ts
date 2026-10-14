/**
 * Lent keys for tests: the examples' Google models, OpenRouter's free router for text,
 * and Jev for decisions. Each Google model may use URL context; none may ground.
 */
import type { LentKeys, LentModel, ModelProfileType } from '../../studio/mod.ts';

const GOOGLE: Record<Exclude<ModelProfileType, 'decision'>, LentModel> = {
  text: { id: 'gemini-3.1-flash-lite', label: '3.1 Flash Lite' },
  image: { id: 'gemini-3.1-flash-lite-image', label: '3.1 Flash Lite Image' },
  speech: { id: 'gemini-3.1-flash-tts-preview', label: '3.1 Flash TTS' },
  live: { id: 'gemini-3.1-flash-live-preview', label: '3.1 Flash Live' },
};
/** The example's second text model, on the keys too. */
const SECOND_TEXT: LentModel = { id: 'gemini-3.5-flash-lite', label: '3.5 Flash Lite' };
const GOOGLE_IDS = new Set([...Object.values(GOOGLE), SECOND_TEXT].map((model) => model.id));
const ROUTER: LentModel = { id: 'openrouter/free', label: 'Free router' };
const JEV: LentModel = { id: 'jev-latest', label: 'Jev' };

const models: LentKeys['models'] = (type, adapter) => {
  if (type === 'decision') return adapter === 'typesafe' ? [JEV] : [];
  if (adapter === 'google') return type === 'text' ? [GOOGLE.text, SECOND_TEXT] : [GOOGLE[type]];
  return adapter === 'openrouter' && type === 'text' ? [ROUTER] : [];
};

export const TEST_KEYS: LentKeys = {
  models,
  runs: (type, adapter) => models(type, adapter).length > 0,
  start: (type) =>
    type === 'decision'
      ? { provider: 'typesafe', apiId: JEV.id }
      : { provider: 'google', apiId: GOOGLE[type].id },
  violation: (binding) => {
    const type = binding.decision ? 'decision' : undefined;
    const offered = type
      ? models(type, binding.adapter)
      : (['text', 'image', 'speech', 'live'] as const).flatMap((each) =>
          models(each, binding.adapter),
        );
    if (!offered.length) return { field: 'provider', message: 'These keys run no such model.' };
    if (!offered.some((model) => model.id === binding.apiId.trim())) {
      return { field: 'apiId', message: `${binding.apiId} is not on these keys.` };
    }
    const refused = binding.builtInTools.find((id) => id !== 'urlContext');
    return refused
      ? { field: 'builtInTools', message: `${refused} is not allowed on these keys.` }
      : null;
  },
  builtins: (apiId) => (GOOGLE_IDS.has(apiId.trim()) ? ['urlContext'] : []),
  decision: {
    questions: 8,
    criteria: 12,
    instructionsChars: 2_000,
    criterionChars: 500,
    nameChars: 64,
    idChars: 128,
    stateBytes: 16_384,
    timeoutMs: 30_000,
  },
  questionViolation: () => null,
  liveInputTokens: 65_536,
};

/** A run on `TEST_KEYS`. */
export const ON_TEST_KEYS = { mode: 'demo', keys: TEST_KEYS } as const;
