/**
 * Keys a page lends to whoever opens its studio. The studio runs agents on them for anyone, so it
 * holds those runs to what the page says its keys allow. A studio given none has no such runs:
 * it runs on the builder's own keys, their own machine, or their project.
 *
 * @module
 */

import type { TaintGate } from '@theoremjs/agents/guardrails';
import type { DecisionQuestion } from '@theoremjs/agents/kernel';
import type { ModelBindingDraft, StudioProfileType } from './draft.ts';
import type { ModelRoute } from './providers.ts';

/** An agent type that runs on a model. */
export type ModelProfileType = Exclude<StudioProfileType, 'host'>;

/** Where a new model of `type` starts: its provider and API model. */
export type ModelStart = (type: ModelProfileType) => Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'>;

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
  /** Question ids, option labels, model ids, and the handle. */
  nameChars: number;
  /** The profile id, the contract, and the API model. */
  idChars: number;
  stateBytes: number;
  timeoutMs: number;
}

/** What runs on lent keys keep to, whatever a profile says. The editor notes each where it is set. */
export interface LentHolds {
  /** Runs reach public hosts only: a profile's network rules give way to the kernel's default. */
  publicHostsOnly: boolean;
  /** The calls a turn refuses once it has read a remote result. A profile that refuses more keeps its own. */
  afterRemoteRead: TaintGate;
}

/** A page's lent keys, and what runs on them. */
export interface LentKeys {
  /** The models a binding of `type` may pick on a provider from `definition`, in order. */
  models(type: ModelProfileType, definition: string | undefined): readonly LentModel[];
  /** Whether the keys run agents of `type` on a provider from `definition`. */
  runs(type: ModelProfileType, definition: string | undefined): boolean;
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
  /** Why `state` can't be decided on by `binding`'s model; `null` when it can. */
  stateViolation(binding: ModelRoute, state: unknown): string | null;
  /** The most input tokens a Live session holds on the keys. Compression starts below it. */
  liveInputTokens: number;
  /** What runs on the keys keep to, whatever a profile says. */
  holds: LentHolds;
}

/**
 * What a studio runs on: a page's lent keys, the builder's own keys, or their own machine. Runs
 * on lent keys always carry the keys they are held to.
 */
export type StudioRunsOn =
  | { mode: 'demo'; keys: LentKeys }
  | { mode: 'byok' }
  | { mode: 'local' };

/**
 * The compression sizes a Live session runs with on lent keys: those the profile sets, and for a
 * blank one Gemini's rule (start at 80% of the window, keep half the start), applied to what a
 * session holds on the keys. Gemini would apply it to the model's whole window, past what the keys
 * hold, so the session would be cut before compression started.
 */
export function lentCompression(
  keys: Pick<LentKeys, 'liveInputTokens'>,
  set: { triggerTokens?: number; targetTokens?: number },
): { triggerTokens: number; targetTokens: number } {
  const triggerTokens = set.triggerTokens ?? Math.round(keys.liveInputTokens * 0.8);
  return { triggerTokens, targetTokens: set.targetTokens ?? Math.round(triggerTokens / 2) };
}

/** The builder's own keys. */
export const ON_OWN_KEYS: StudioRunsOn = { mode: 'byok' };
