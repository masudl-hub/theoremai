import { CONTINUE_STOP_KINDS, type ContinueStopKind, type ProfileType } from './schema.ts';
import type { TurnStop } from './turn-events.ts';

export type { TurnStop };

/**
 * Profile types whose continue turn sends the continue instruction. Image and
 * speech continue by re-sending the host's request unchanged.
 */
export const CONTINUE_INSTRUCTION_TYPES: readonly ProfileType[] = ['text'];

/** The stop kinds that offer Continue when a profile names none. */
export const DEFAULT_ALLOW_CONTINUE: readonly ContinueStopKind[] = CONTINUE_STOP_KINDS;

/** Hosts wait briefly, then continue once on their own. */
export const DEFAULT_AUTO_CONTINUE: readonly ContinueStopKind[] = ['length', 'stream_incomplete'];

/** Pause before the one-shot auto-continue so a flaky tunnel can settle. */
export const AUTO_CONTINUE_DELAY_MS = 1_500;

/** Which stops a profile offers Continue for, and which the host continues on its own. */
export interface ProfileTurnResumptionSpec {
  /**
   * The host's UI policy for offering Continue: the kernel does not refuse a `continueFrom`
   * outside it, since a continue is one more turn the host could send as plain text anyway.
   * Omit → length / stream_incomplete / provider_error; `[]` = none.
   */
  allowContinue?: ContinueStopKind[];
  /**
   * Omit → length / stream_incomplete; `[]` = none. The kernel does not loop: the host
   * sends the `continueFrom` turn with `continuation`.
   */
  autoContinue?: ContinueStopKind[];
  /** Compared against `TurnRequest.continuation`. Omit → no count cap. */
  maxContinues?: number;
}

const CONTINUE_KIND_SET = new Set<string>(CONTINUE_STOP_KINDS);

/** True when the stop kind can be continued. */
export function isContinueStopKind(kind: string): kind is ContinueStopKind {
  return CONTINUE_KIND_SET.has(kind);
}

/**
 * `allowSteering` is text / live only; image and speech omit it. Stop is not a profile knob:
 * interfaces always project `canStop: true` because `TurnRequest.signal` is always wired.
 */
export interface ProfileTurnBehaviourSpec {
  resumption?: ProfileTurnResumptionSpec;
  /** Default true on text / live. Gates injects only; stage events still emit. */
  allowSteering?: boolean;
}

/**
 * Image / speech turn behaviour: resumption only. A continue re-sends the
 * host's request unchanged, so there is no continue instruction, and there is
 * no mid-turn inject to steer.
 */
export interface MediaTurnBehaviourSpec {
  resumption?: ProfileTurnResumptionSpec;
}

/**
 * The stop a continue turn resumes. The partial reply is not carried here: a
 * text continue reads it as the last assistant message in `input.history`, and
 * an image or speech continue re-sends the original request.
 */
export interface TurnContinueFrom {
  stop: TurnStop;
}

const RESUMEABLE_DEFAULT = new Set<ContinueStopKind>(DEFAULT_ALLOW_CONTINUE);

/** True when the stop can be continued under the allowed kinds. */
export function isResumeableStop(
  stop: TurnStop | undefined,
  allowContinue?: readonly ContinueStopKind[],
): boolean {
  if (!stop) return false;
  if (!isContinueStopKind(stop.kind)) return false;
  const allow = allowContinue ? new Set(allowContinue) : RESUMEABLE_DEFAULT;
  return allow.has(stop.kind);
}

export function stageAbortStop(
  abort: true | { reason?: string },
): TurnStop & { kind: 'cancelled' } {
  return typeof abort === 'object' && abort.reason
    ? { kind: 'cancelled', native: abort.reason }
    : { kind: 'cancelled' };
}

/** True when the user cancelled the turn. */
export function isUserCancelledStop(stop: TurnStop | undefined): boolean {
  return stop?.kind === 'cancelled';
}

/** `policy` is the profile's `profileTurnResumption(profile)`. */
export function shouldAutoContinue(
  stop: TurnStop | undefined,
  policy?: Pick<ProfileTurnResumptionSpec, 'allowContinue' | 'autoContinue'>,
): boolean {
  if (!stop || !isContinueStopKind(stop.kind)) return false;
  const auto = policy?.autoContinue ?? DEFAULT_AUTO_CONTINUE;
  return auto.includes(stop.kind) && isResumeableStop(stop, policy?.allowContinue);
}

/** The profile's resumption policy, or `undefined` for a live profile. */
export function profileTurnResumption(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): ProfileTurnResumptionSpec | undefined {
  if (profile.type === 'live') return undefined;
  return profile.turnBehaviour?.resumption;
}

/** Text-only, for the interface `allowSteering` projection; `profileAllowsInject` adds live. */
export function profileAllowsSteering(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): boolean {
  if (profile.type !== 'text') return false;
  return profile.turnBehaviour?.allowSteering !== false;
}

/** Gates injects only, never stage emission. */
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

/** `null` when `sawTerminal`, so the host keeps the provider's stop. */
export function turnStopFromClientStreamEnd(opts: {
  abortedByUser: boolean;
  sawTerminal: boolean;
  hadPartial?: boolean;
}): TurnStop | null {
  if (opts.sawTerminal) return null;
  if (opts.abortedByUser) return { kind: 'cancelled' };
  return { kind: 'stream_incomplete' };
}

/** Thrown when a model call stops before it finishes, carrying the stop. */
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
