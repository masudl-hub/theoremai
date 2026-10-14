/**
 * Keys a page lends to whoever opens its studio. The studio runs agents on them for anyone, so it
 * holds those runs to what the page says its keys allow. A studio given none has no such runs:
 * it runs on the builder's own keys, their own machine, or their project.
 *
 * @module
 */

import type { DecisionQuestion } from '../src/kernel/types.ts';
import type { ModelBindingDraft, StudioProfileType } from './draft.ts';
import type { ModelRoute } from './providers.ts';

/** An agent type that runs on a model. */
export type ModelProfileType = Exclude<StudioProfileType, 'host'>;

/** Where a new model of `type` starts: its provider and API model. */
export type ModelStart = (type: ModelProfileType) => Pick<ModelBindingDraft, 'provider' | 'apiId'>;

/** What switching an agent's type reads from lent keys: each type's models, and where a new one starts. */
export type ModelPicks = Pick<LentKeys, 'models' | 'start'>;

/** A model the lent keys offer, as a picker lists it. */
export interface LentModel {
  id: string;
  label: string;
}

/** A binding as these checks read it: its route and its built-ins. */
export type LentBinding = ModelRoute & Pick<ModelBindingDraft, 'builtInTools'>;

/** What is wrong with a binding, on the field that holds it. */
export interface ModelBindingViolation {
  field: 'provider' | 'apiId' | 'builtInTools';
  message: string;
}

/** The most a decision sent on the lent keys may hold. */
export interface LentDecisionLimits {
  questions: number;
  /** Options or levels in one question. */
  criteria: number;
  instructionsChars: number;
  criterionChars: number;
  /** Question ids, option labels, model ids and the handle. */
  nameChars: number;
  /** The profile id, the contract and the API model. */
  idChars: number;
  stateBytes: number;
  timeoutMs: number;
}

/** A page's lent keys, and what runs on them. */
export interface LentKeys {
  /** The models a binding of `type` may pick on a provider with `adapter`, in order. */
  models(type: ModelProfileType, adapter: string | undefined): readonly LentModel[];
  /** Whether the keys run agents of `type` on a provider with `adapter`. */
  runs(type: ModelProfileType, adapter: string | undefined): boolean;
  /** The binding a new model of `type` starts on. */
  start: ModelStart;
  /** Why `binding` can't run on the keys; `null` when it can. */
  violation(binding: LentBinding): ModelBindingViolation | null;
  /** The built-ins `apiId` may use on the keys. */
  builtins(apiId: string): readonly string[];
  /** The most a decision may hold. */
  decision: LentDecisionLimits;
  /** Why `question` can't be asked of `binding`'s model; `null` when it can. */
  questionViolation(binding: ModelRoute, question: DecisionQuestion): string | null;
  /** The most input tokens a Live session holds on the keys. Compression starts below it. */
  liveInputTokens: number;
}

/**
 * What a studio runs on: a page's lent keys, the builder's own keys, or their own machine. Runs
 * on lent keys always carry the keys they are held to.
 */
export type StudioRunsOn =
  | { mode: 'demo'; keys: LentKeys }
  | { mode: 'byok' }
  | { mode: 'local' };

/** The builder's own keys. */
export const ON_OWN_KEYS: StudioRunsOn = { mode: 'byok' };
