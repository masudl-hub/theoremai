/**
 * Normalized turn stop reasons and resume policy.
 *
 * Providers map Interactions `status` / OpenAI `finish_reason` into `TurnStop`.
 * Hosts classify client SSE drops via `turnStopFromClientStreamEnd`.
 *
 * @module
 */

import { CONTINUE_STOP_KINDS, type ContinueStopKind, type TurnStopKind } from './schema.ts';

/** Normalized stop attached to terminal `done` events and host continue requests. */
export interface TurnStop {
  kind: TurnStopKind;
  /** Raw provider / native reason for diagnostics. */
  native?: string;
}

/**
 * Fixed continue instruction for resumeable stops.
 * Hosts should not invent per-app continue prompts.
 */
export const CONTINUE_INSTRUCTION =
  'Continue and finish the incomplete output from the previous turn. Do not restart from scratch; preserve what was already generated and complete it.';

/** Default kinds hosts may offer Continue for (= full ContinueStopKind set). */
export const DEFAULT_ALLOW_CONTINUE: readonly ContinueStopKind[] = CONTINUE_STOP_KINDS;

/**
 * Default kinds for one silent auto-continue (hosts wait briefly, then resume once).
 * Never includes kinds outside ContinueStopKind (e.g. cancelled / tool / gate / completed).
 */
export const DEFAULT_AUTO_CONTINUE: readonly ContinueStopKind[] = ['length', 'stream_incomplete'];

/** Pause before the one-shot auto-continue so a flaky tunnel can settle. */
export const AUTO_CONTINUE_DELAY_MS = 1_500;

/** Profile turn-continuation policy under `turnBehaviour.resumption`. */
export interface ProfileTurnResumptionSpec {
  /**
   * Kinds eligible for a Continue / continueFrom turn.
   * When omitted, length / stream_incomplete / provider_error are eligible.
   * Only `ContinueStopKind` values are valid — not tool / cancelled / completed / …
   */
  allowContinue?: ContinueStopKind[];
  /**
   * Kinds the host may auto-continue without a CTA.
   * Kernel does not loop; hosts call continueFrom and pass `continuation`.
   */
  autoContinue?: ContinueStopKind[];
  /**
   * Max continueFrom rounds the kernel will accept for this profile.
   * Compared against `TurnRequest.continuation` (1-based continue attempt).
   * When omitted, only kind allowlists apply (no count cap).
   */
  maxContinues?: number;
}

const CONTINUE_KIND_SET = new Set<string>(CONTINUE_STOP_KINDS);

/** True when `kind` may appear in allowContinue / autoContinue. */
export function isContinueStopKind(kind: string): kind is ContinueStopKind {
  return CONTINUE_KIND_SET.has(kind);
}

/**
 * Mid-turn + resume policy for text / image / speech profiles.
 *
 * - `resumption` — continueFrom after a non-user stop (all three types).
 * - `allowSteering` — stage **inject** gate on text and live (default true).
 *   Image / speech must omit. Stage events always emit when the runner uses stages.
 *
 * Stop / AbortSignal is not a profile knob — composer interfaces always
 * project `canStop: true` because `TurnRequest.signal` is already wired.
 */
export interface ProfileTurnBehaviourSpec {
  resumption?: ProfileTurnResumptionSpec;
  /**
   * When true (default on text/live), host `onStage` inject affordances are applied
   * (`profileAllowsInject`). Does not hide stage emission.
   */
  allowSteering?: boolean;
}

/** Partial state passed when continuing a resumeable stop. */
export interface TurnContinueFrom {
  stop: TurnStop;
  partialText?: string;
  /** Serialized artifact / code preview from the interrupted turn. */
  partialArtifact?: string;
}

const RESUMEABLE_DEFAULT = new Set<ContinueStopKind>(DEFAULT_ALLOW_CONTINUE);

/** True when this stop may be continued (profile allow list or default). */
export function isResumeableStop(
  stop: TurnStop | undefined,
  allowContinue?: readonly ContinueStopKind[],
): boolean {
  if (!stop) return false;
  if (!isContinueStopKind(stop.kind)) return false;
  const allow = allowContinue?.length ? new Set(allowContinue) : RESUMEABLE_DEFAULT;
  return allow.has(stop.kind);
}

/** True when the host aborted (user Stop). */
export function isUserCancelledStop(stop: TurnStop | undefined): boolean {
  return stop?.kind === 'cancelled';
}

/** True when profile policy allows one silent auto-continue for this stop. */
export function shouldAutoContinue(
  stop: TurnStop | undefined,
  autoContinue: readonly ContinueStopKind[] | undefined = DEFAULT_AUTO_CONTINUE,
): boolean {
  if (!stop || !isContinueStopKind(stop.kind)) return false;
  const list = autoContinue ?? DEFAULT_AUTO_CONTINUE;
  if (list.length === 0) return false;
  return list.includes(stop.kind) && isResumeableStop(stop);
}

/** Read nested `turnBehaviour.resumption` from a non-live profile. */
export function profileTurnResumption(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): ProfileTurnResumptionSpec | undefined {
  if (profile.type === 'live') return undefined;
  return profile.turnBehaviour?.resumption;
}

/**
 * Text profiles may inject at stages unless `allowSteering: false`.
 * Image / speech / host: use `profileAllowsInject` for the target matrix;
 * this helper remains text-only for interface `allowSteering` projection.
 */
export function profileAllowsSteering(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): boolean {
  if (profile.type !== 'text') return false;
  return profile.turnBehaviour?.allowSteering !== false;
}

/**
 * Whether stage **inject** affordances may be applied (`docs/contracts/stages.md`).
 * Gates inject only — never stage emission or tool stages.
 *
 * Text + live when `allowSteering !== false`; never image / speech / host.
 */
export function profileAllowsInject(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): boolean {
  if (profile.type === 'text' || profile.type === 'live') {
    return profile.turnBehaviour?.allowSteering !== false;
  }
  return false;
}

/** OpenAI-compatible normalized `finish_reason` (+ optional `native_finish_reason`). */
export function turnStopFromOpenAiFinishReason(
  finishReason: string | null | undefined,
  nativeFinishReason?: string | null,
): TurnStop {
  const native = nativeFinishReason?.trim() || finishReason?.trim() || undefined;
  const effective = (nativeFinishReason || finishReason || '').toLowerCase();
  if (!effective) return { kind: 'stream_incomplete', native };
  if (effective === 'network_error' || effective.includes('network')) {
    return { kind: 'provider_error', native };
  }
  return openAiFinishKind((finishReason || '').toLowerCase(), effective, native);
}

function openAiFinishKind(finish: string, effective: string, native: string | undefined): TurnStop {
  if (finish === 'stop') {
    return /error|fail/.test(effective)
      ? { kind: 'provider_error', native }
      : { kind: 'completed', native };
  }
  if (finish === 'length') return { kind: 'length', native };
  if (finish === 'tool_calls' || finish === 'tool-calls') return { kind: 'tool', native };
  if (finish === 'content_filter' || finish === 'content-filter') {
    return { kind: 'filtered', native };
  }
  return { kind: 'provider_error', native };
}

/** Gemini Interactions terminal `status`. */
export function turnStopFromInteractionStatus(status: string | null | undefined): TurnStop {
  const s = (status || '').toLowerCase();
  const native = status || undefined;
  switch (s) {
    case 'completed':
      return { kind: 'completed', native };
    case 'incomplete':
    case 'budget_exceeded':
      return { kind: 'length', native };
    case 'requires_action':
      return { kind: 'tool', native };
    case 'cancelled':
      return { kind: 'cancelled', native };
    case 'failed':
      return { kind: 'provider_error', native };
    case 'in_progress':
    case 'queued':
      return { kind: 'stream_incomplete', native };
    default:
      return { kind: 'stream_incomplete', native };
  }
}

/**
 * Client SSE ended without a clean terminal event.
 * User Stop → cancelled; otherwise stream_incomplete (tunnel drop, etc.).
 * Returns null when `sawTerminal` so hosts keep the provider stop.
 */
export function turnStopFromClientStreamEnd(opts: {
  abortedByUser: boolean;
  sawTerminal: boolean;
  hadPartial?: boolean;
}): TurnStop | null {
  if (opts.sawTerminal) return null;
  if (opts.abortedByUser) return { kind: 'cancelled' };
  return { kind: 'stream_incomplete' };
}

/** Error hosts throw when classifying an incomplete / non-success stop. */
export class GenerationStopError extends Error {
  override readonly name = 'GenerationStopError';
  readonly stop: TurnStop;

  constructor(stop: TurnStop, message?: string) {
    super(message || `Generation stopped: ${stop.kind}`);
    this.stop = stop;
  }
}

export function isGenerationStopError(err: unknown): err is GenerationStopError {
  return err instanceof GenerationStopError;
}
