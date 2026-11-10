import {
  CONTINUE_STOP_KINDS,
  type ContinueStopKind,
  type ProfileType,
  type StepLimitMode,
} from './schema.ts';
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

/** The `native` of a `filtered` stop that Theorem's own guardrail made, not the provider's filter. */
const GUARDRAIL_STOP_NATIVES: ReadonlySet<string> = new Set([
  'egress',
  'canary',
  'prompt_echo',
  'provider_tool_leak',
]);

/** Whether Theorem's own guardrail ended the turn, so its error or refusal already says why. */
export function isGuardrailStop(stop: TurnStop): boolean {
  return stop.kind === 'filtered' && GUARDRAIL_STOP_NATIVES.has(stop.native ?? '');
}

/** Pause before an auto-continue, the host's or the turn's own, so a flaky tunnel can settle. */
export const AUTO_CONTINUE_DELAY_MS = 1_500;

/** Which stops a profile offers Continue for, and which the host continues on its own. */
export interface ProfileTurnResumptionSpec {
  /**
   * Which early stops the host offers the user a Continue for; the kernel doesn't refuse a continue
   * after other stops.
   *
   * @remarks The host's UI policy for offering Continue: the kernel does not refuse a
   * `continueFrom` outside it, since a continue is one more turn the host could send as plain text
   * anyway. Omit → length / stream_incomplete / provider_error; `[]` = none.
   */
  allowContinue?: ContinueStopKind[];
  /**
   * Which early stops are continued without asking, whether or not allowContinue offers a Continue
   * for them. When set, a text turn sends a listed failed model call that gave no reply again
   * itself; the host continues the rest. Naming length also repairs a call the output limit cut
   * off: the model gets back what it wrote, or that it wrote nothing, and is asked again to fit.
   *
   * @remarks Omit → length / stream_incomplete; `[]` = none. Apart from `allowContinue`: a stop can
   * be continued without Continue being offered for it. The host sends the `continueFrom` turn with
   * `continuation`. A text turn also sends a failed model call (`provider_error`,
   * `stream_incomplete`) again itself when this list is set and names that stop, and the call gave
   * no reply and no tool call: the turn keeps its history, its step count and what it has read. A
   * failure the same call would meet again (the provider refused the request) is not sent again,
   * except once without its files when it carried any: accepted that way, the turn goes on and
   * `done.mediaRefused` names them. Named here, `length` also repairs a call the output limit cut
   * off: the model gets back what it wrote, or that it wrote nothing, and is asked again to fit.
   * Omitted, a turn sends nothing again.
   */
  autoContinue?: ContinueStopKind[];
  /**
   * How many times one reply may be continued; once set, each continue must say which one it is.
   * Also how many model calls one text turn sends again itself, failed calls and cut-off repairs
   * together (one when unset).
   *
   * @remarks Compared against `TurnRequest.continuation`; omit → no count cap. Also how many model
   * calls one text turn sends again itself, failed calls and cut-off repairs together; omit → one.
   */
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
  /** Continuing a reply that stopped early; live uses sessionResumption instead. */
  resumption?: ProfileTurnResumptionSpec;
  /**
   * Lets your onStage hook add messages to a running turn. Text profiles also let the user steer.
   *
   * @remarks Default true on text / live. Gates injects only; stage events still emit.
   */
  allowSteering?: boolean;
  /**
   * What happens when a turn reaches maxSteps while the model still wants tools: the turn stops
   * with no answer, or the last call is made without tools so it answers.
   *
   * @remarks Text only. What the last model call under `maxSteps` may do. Omit = `'stop'`: it may
   * call tools, and if it does the turn stops as `step_limit`. `'answer'` sends it without tools.
   */
  atStepLimit?: StepLimitMode;
}

/**
 * Image / speech turn behaviour: resumption only. A continue re-sends the
 * host's request unchanged, so there is no continue instruction, and there is
 * no mid-turn inject to steer.
 */
export interface MediaTurnBehaviourSpec {
  /** Continuing a reply that stopped early; live uses sessionResumption instead. */
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

const FAILED_STOP_KINDS = new Set<TurnStop['kind']>(['provider_error', 'stream_incomplete']);

/** True for a stop where the model call failed; the rest either finished or were stopped on purpose. */
export function isFailedStopKind(kind: TurnStop['kind']): boolean {
  return FAILED_STOP_KINDS.has(kind);
}

/** True for a turn that ended in failure: its model call failed, or the model never gave its answer. */
export function isFailedTurnStop(kind: TurnStop['kind']): boolean {
  return isFailedStopKind(kind) || kind === 'answer_missing';
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
  policy?: Pick<ProfileTurnResumptionSpec, 'autoContinue'>,
): boolean {
  if (!stop || !isContinueStopKind(stop.kind)) return false;
  // why: Offering Continue (`allowContinue`) is the host's own choice, apart from this one.
  return (policy?.autoContinue ?? DEFAULT_AUTO_CONTINUE).includes(stop.kind);
}

/** The profile's resumption policy, or `undefined` for a live profile. */
export function profileTurnResumption(profile: {
  type: string;
  turnBehaviour?: ProfileTurnBehaviourSpec;
}): ProfileTurnResumptionSpec | undefined {
  if (profile.type === 'live') return undefined;
  return profile.turnBehaviour?.resumption;
}

/** How many model calls a turn sends again when the output limit cuts one off: `maxContinues` (one when unset) while `autoContinue` names `length`, else none. */
export function cutOffRepairs(profile: Parameters<typeof profileTurnResumption>[0]): number {
  const policy = profileTurnResumption(profile);
  if (!policy?.autoContinue?.includes('length')) return 0;
  return policy.maxContinues ?? 1;
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

/** True when the error is a `GenerationStopError`. */
export function isGenerationStopError(err: unknown): err is GenerationStopError {
  return err instanceof GenerationStopError;
}
