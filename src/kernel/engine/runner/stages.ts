import { throwIfAborted } from '../../../guardrails/error.ts';
import {
  type InjectUnit,
  injectedStageEvent,
  injectMessages,
  runStage,
  type StageApplyWarning,
  type StageCallBag,
  type StageContext,
  type StageHandler,
} from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import type {
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnStage,
} from '../../types.ts';
import type { StepExecutionState } from './state.ts';

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
 * invariant: A message that keeps no text leaves history; a call it made stays on its own message.
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
  // why: The model goes on after the inject, so it reads the answer it wrote before it.
  if (reply && injectMessages(out.inject).length > 0) recordReply(state, reply, replyAt);
  return {
    abort: out.abort,
    injectCount: yield* applyStageInjects(state, call.stage, out.inject),
    warnings: out.warnings,
  };
}
