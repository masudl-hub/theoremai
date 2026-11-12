import { throwIfAborted } from '../../../guardrails/error.ts';
import { hookFailed } from '../../hook-failure.ts';
import type { TurnInjectStage } from '../../schema.ts';
import {
  type InjectUnit,
  injectedStageEvent,
  injectMessages,
  runStage,
  type StageApplyWarning,
  type StageCallBag,
  type StageContext,
  type StageHandler,
  sanitizeInjects,
  stageAllowsAffordance,
} from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import type { ToolOperationOutcome } from '../../tools/operation.ts';
import type {
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnStage,
} from '../../types.ts';
import { landLateResults, type StepExecutionState, unreadLateResults } from './state.ts';

export interface ApplyTurnStageArgs extends StageCallBag {
  profile: Profile;
  generation: ResolvedGeneration;
  state: StepExecutionState;
  stage: StageContext['stage'];
  step: number;
  onStage?: StageHandler;
  signal?: AbortSignal;
  /** Another provider step would exceed maxSteps — reject inject. */
  injectWouldExceedMaxSteps?: boolean;
  host?: unknown;
  /** Where that answer's text begins in the attempt's reply. */
  replyAt?: number;
}

/**
 * A model call's reply joins turn history. Its text message, whose text begins at `at` in the
 * attempt's reply, is the one an inject's drop cuts.
 */
export function recordReply(
  state: StepExecutionState,
  reply: readonly TurnHistoryMessage[],
  at: number | undefined,
): void {
  state.currentHistory.push(...reply);
  if (at === undefined) return;
  for (const message of reply) {
    if (typeof message.content === 'string') state.replyMessages.push({ message, at });
  }
}

export interface ApplyTurnStageResult {
  abort?: boolean | { reason?: string };
  injectCount: number;
  /** Late results landed at this stage: the model takes another step to read them. */
  lateLanded: boolean;
  warnings: StageApplyWarning[];
}

/** The least of the reply text any of `units` says the user has; `undefined` when none says. */
function releasedOf(units: readonly InjectUnit[]): number | undefined {
  const counts = units.flatMap((unit) => (unit.released === undefined ? [] : [unit.released]));
  return counts.length > 0 ? Math.min(...counts) : undefined;
}

/** `events` less their last `count` characters of reply text, cut from the end. */
function withoutTextTail(events: readonly TurnEvent[], count: number): TurnEvent[] {
  const out = [...events];
  let left = count;
  for (let index = out.length - 1; index >= 0 && left > 0; index -= 1) {
    const event = out[index];
    if (event?.type !== 'text') continue;
    const keep = Math.max(0, event.text.length - left);
    left -= event.text.length - keep;
    if (keep === 0) out.splice(index, 1);
    else out[index] = { ...event, text: event.text.slice(0, keep) };
  }
  return out;
}

/**
 * Drops the draft past the `released` characters of the attempt's reply the user has: from its
 * history messages, from what the attempt gate reads, and from the reply. Returns `released` when
 * a draft was dropped.
 *
 * invariant: A message that keeps no text leaves history, unless it made calls: then it stays
 * with its calls and without the words.
 */
function dropDraft(state: StepExecutionState, released: number | undefined): number | undefined {
  if (released === undefined || released >= state.replyText.length) return undefined;
  const dropped = state.replyText.length - released;
  state.replyText = state.replyText.slice(0, released);
  state.released = state.released.slice(0, Math.max(0, state.released.length - dropped));
  state.attemptEvents = withoutTextTail(state.attemptEvents, dropped);
  const kept: StepExecutionState['replyMessages'] = [];
  for (const { message, at } of state.replyMessages) {
    const text = typeof message.content === 'string' ? message.content : '';
    const keep = text.slice(0, Math.max(0, released - at));
    const index = state.currentHistory.indexOf(message);
    if (index < 0) continue;
    if (keep) {
      const cut = keep === text ? message : { ...message, content: keep };
      state.currentHistory[index] = cut;
      kept.push({ message: cut, at });
    } else if (message.tool_calls) {
      const { content: _dropped, ...calls } = message;
      state.currentHistory[index] = calls;
    } else state.currentHistory.splice(index, 1);
  }
  state.replyMessages = kept;
  return released;
}

/**
 * Sanitized stage injects extend portable history. An inject whose host says the user has only
 * part of the attempt's reply drops the rest first (`StageResult.released`).
 */
export function* applyStageInjects(
  state: StepExecutionState,
  stage: TurnStage,
  units: readonly InjectUnit[],
  extra?: { callId?: string; toolName?: string },
): Generator<TurnEvent, number> {
  const inject = injectMessages(units);
  if (inject.length === 0) return 0;
  const released = dropDraft(state, releasedOf(units));
  state.currentHistory.push(...inject);
  const landed = injectedStageEvent(stage, units, {
    ...extra,
    ...(released === undefined ? {} : { released }),
  });
  if (landed) {
    state.allEmittedEvents.push(landed);
    yield landed;
  }
  return inject.length;
}

/**
 * The steers waiting for this turn, sanitized, when `stage` takes an inject the turn can read.
 * `waiting` is what the queue gave, to mark joined once `units` land.
 */
export function* steersToLand(
  state: StepExecutionState,
  profile: Profile,
  stage: TurnStage,
  injectWouldExceedMaxSteps: boolean | undefined,
): Generator<TurnEvent, { waiting: readonly InjectUnit[]; units: InjectUnit[] } | undefined> {
  const waiting = state.steers?.waiting() ?? [];
  if (waiting.length === 0) return undefined;
  if (!stageAllowsAffordance(stage, 'inject') || !profileAllowsInject(profile)) return undefined;
  if (injectWouldExceedMaxSteps) return undefined;
  const guarded = sanitizeInjects(waiting, profile.guardrails, state.trace.root);
  let next = guarded.next();
  while (!next.done) {
    state.allEmittedEvents.push(next.value);
    yield next.value;
    next = guarded.next();
  }
  return { waiting, units: next.value };
}

/** Where a turn asks its late-results source, and whether the model reads another step after it. */
export interface LateResultsAt {
  stage: TurnInjectStage;
  step: number;
  host: unknown;
  signal?: AbortSignal;
  /** Another model step would pass `maxSteps`: mid-turn, nothing is asked. */
  injectWouldExceedMaxSteps?: boolean;
}

/**
 * The late results the turn's source gives at `at` that the conversation does not hold yet. It is
 * asked only where the model reads what lands: as the turn opens, or mid-turn when the profile
 * takes steering and another step fits. A source that throws is reported and gives nothing.
 */
export async function* unreadLateResultsAt(
  state: StepExecutionState,
  profile: Profile,
  at: LateResultsAt,
): AsyncGenerator<TurnEvent, ToolOperationOutcome[]> {
  const source = state.lateResults;
  if (!source) return [];
  if (at.stage !== 'pre_turn' && (!profileAllowsInject(profile) || at.injectWouldExceedMaxSteps)) {
    return [];
  }
  let given: readonly ToolOperationOutcome[];
  try {
    given = await source({
      stage: at.stage,
      step: at.step,
      host: at.host,
      ...(at.signal ? { signal: at.signal } : {}),
    });
  } catch (err) {
    throwIfAborted(at.signal);
    const failed = hookFailed('lateResults', err, { stage: at.stage, span: state.trace.root });
    state.allEmittedEvents.push(failed);
    yield failed;
    return [];
  }
  throwIfAborted(at.signal);
  return unreadLateResults(state, given);
}

/** Lands `unread` in turn history with the `late_results` event that records where. */
export function* landLateResultsAt(
  state: StepExecutionState,
  profile: Profile,
  unread: readonly ToolOperationOutcome[],
  at: Pick<LateResultsAt, 'stage' | 'step'>,
): Generator<TurnEvent, boolean> {
  if (unread.length === 0) return false;
  const landed = landLateResults(state, unread, profile.labels, at.stage);
  const event: TurnEvent = { type: 'late_results', ...landed, stage: at.stage, step: at.step };
  state.allEmittedEvents.push(event);
  yield event;
  return true;
}

/**
 * Runs a turn stage: the host's handler, then the steers waiting for the turn. Both land together,
 * the host's first; an abort lands neither.
 */
export async function* applyTurnStage(
  args: ApplyTurnStageArgs,
): AsyncGenerator<TurnEvent, ApplyTurnStageResult> {
  const { profile, generation, state, onStage, host, reply, replyAt, ...call } = args;
  throwIfAborted(call.signal);
  const run = runStage({
    ...call,
    ...(reply ? { reply } : {}),
    history: state.currentHistory,
    handlers: onStage ? [onStage] : [],
    guardrails: profile.guardrails,
    injectAllowed: profileAllowsInject(profile),
    host: host ?? generation.host,
    span: state.trace.root,
  });
  let next = await run.next();
  while (!next.done) {
    state.allEmittedEvents.push(next.value);
    yield next.value;
    next = await run.next();
  }
  const out = next.value;
  const steers = out.abort
    ? undefined
    : yield* steersToLand(state, profile, call.stage, call.injectWouldExceedMaxSteps);
  const units = [...out.inject, ...(steers?.units ?? [])];
  // why: pre_turn's late results land as the turn opens, before this stage runs.
  const lateAt =
    !out.abort && call.stage === 'before_end' ? { stage: call.stage, step: call.step } : undefined;
  const late = lateAt
    ? yield* unreadLateResultsAt(state, profile, {
        ...lateAt,
        host: host ?? generation.host,
        ...(call.signal ? { signal: call.signal } : {}),
        ...(call.injectWouldExceedMaxSteps ? { injectWouldExceedMaxSteps: true } : {}),
      })
    : [];
  // why: The model goes on after the inject or the late results, so it reads the answer it wrote before them.
  if (reply && (injectMessages(units).length > 0 || late.length > 0)) {
    recordReply(state, reply, replyAt);
  }
  const injectCount = yield* applyStageInjects(state, call.stage, units);
  if (steers) state.steers?.joined(steers.waiting);
  const lateLanded = lateAt ? yield* landLateResultsAt(state, profile, late, lateAt) : false;
  return { abort: out.abort, injectCount, lateLanded, warnings: out.warnings };
}
