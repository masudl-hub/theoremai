/**
 * What the studio sets for itself, and how it reads a binding on what it runs on. What a page's
 * lent keys allow is the page's own (`LentKeys`); nothing here knows a hosted model list.
 */

import { GOOGLE_BUILTIN_TOOLS } from '@theoremjs/agents/presets/google';
import type { ModelBindingDraft } from './draft.ts';
import type { LentBinding, ModelBindingViolation, ModelProfileType, ModelStart, StudioRunsOn } from './lent-keys.ts';
import { LOCAL_PROVIDER_ID, type ModelRoute, servesProfileType } from './providers.ts';

export type StudioConnectionMode = StudioRunsOn['mode'];

/** Each record goes back to the run tab's inspector; the server keeps nothing. */
export const STUDIO_TRACE_DESTINATION = 'studio';

/**
 * What the studio fills in where a profile leaves a setting out, by path: a profile that names no
 * place for its records is recorded to the studio, so a test run's trace shows. Written, the
 * setting is the profile's, and any other value is a difference.
 */
export const STUDIO_POLICY_UNSET: Readonly<Record<string, unknown>> = {
  'observability.writeTo': STUDIO_TRACE_DESTINATION,
};

/**
 * `profile` as a file holds it: each value the studio fills in (`STUDIO_POLICY_UNSET`) is taken
 * out, and a section left empty by that goes too. Writing a profile never writes the studio's own.
 */
export function withoutStudioFills<P extends object>(profile: P): P {
  return Object.entries(STUDIO_POLICY_UNSET).reduce<Record<string, unknown>>(
    (held, [path, fill]) => withoutFill(held, path.split('.'), fill),
    profile as Record<string, unknown>,
  ) as P;
}

function withoutFill(
  value: Record<string, unknown>,
  [key, ...rest]: string[],
  fill: unknown,
): Record<string, unknown> {
  if (key === undefined || !Object.hasOwn(value, key)) return value;
  const inner = value[key];
  if (!rest.length) {
    return inner === fill ? Object.fromEntries(Object.entries(value).filter(([at]) => at !== key)) : value;
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return value;
  const kept = withoutFill(inner as Record<string, unknown>, rest, fill);
  if (kept === inner) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([at, held]) =>
      at !== key ? [[at, held]] : Object.keys(kept).length ? [[at, kept]] : [],
    ),
  );
}

/** Provider builtin ids — they belong on `models.*.builtInTools`, never on a custom tool. */
const GOOGLE_BUILTIN_IDS = new Set<string>(GOOGLE_BUILTIN_TOOLS.map((tool) => tool.name));

/** A model served through Google's adapter. */
export function isGoogleRoute(route: Pick<ModelRoute, 'adapter'>): boolean {
  return route.adapter === 'google';
}

/** A model served through OpenRouter's adapter. */
export function isOpenRouterRoute(route: Pick<ModelRoute, 'adapter'>): boolean {
  return route.adapter === 'openrouter';
}

export function isProviderBuiltinId(name: string): boolean {
  return GOOGLE_BUILTIN_IDS.has(name);
}

/**
 * Whether the studio runs agents of `type` on a provider: on lent keys, what the keys run; on
 * the builder's own keys or machine, the adapter's answer.
 */
export function studioRunsProvider(
  type: ModelProfileType,
  provider: Pick<ModelRoute, 'adapter'>,
  on: StudioRunsOn,
): boolean {
  return on.mode === 'demo' ? on.keys.runs(type, provider.adapter) : servesProfileType(provider.adapter, type);
}

/** The model id a new binding of `type` takes. */
const MODEL_IDS: Record<ModelProfileType, string> = {
  text: 'fast',
  image: 'image',
  speech: 'voice',
  live: 'live',
  decision: 'decision',
};

/**
 * The binding a new model of `type` starts on: where `start` puts it, or with none a kernel
 * provider and no model yet, for the builder to pick.
 */
export function startingBinding(
  type: ModelProfileType,
  start?: ModelStart,
): Pick<ModelBindingDraft, 'modelId' | 'provider' | 'apiId'> {
  const begun = start?.(type) ?? { provider: type === 'decision' ? 'typesafe' : 'google', apiId: '' };
  return { modelId: MODEL_IDS[type], ...begun };
}

/** `null` when `binding` can run on `on`: a local run on local models, a lent run on what the keys allow. */
export function modelBindingViolation(binding: LentBinding, on: StudioRunsOn): ModelBindingViolation | null {
  if (on.mode === 'demo') return on.keys.violation(binding);
  if (on.mode === 'local' && binding.provider !== LOCAL_PROVIDER_ID) {
    return {
      field: 'provider',
      message: 'Local runs require local models. Switch the model provider to Local.',
    };
  }
  return null;
}
