/**
 * Text `runTurn` wiring around the stage spine: record stage events in step
 * state and append sanitized injects to turn history.
 *
 * Contract: `docs/contracts/stages.md`. The stage itself runs in `runStage`.
 *
 * @module
 */

import { throwIfAborted } from '../../../guardrails/error.ts';
import {
  runStage,
  type StageApplyWarning,
  type StageCallBag,
  type StageContext,
  type StageHandler,
} from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import type { Profile, ResolvedGeneration, TurnEvent, TurnHistoryMessage } from '../../types.ts';
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
}

export interface ApplyTurnStageResult {
  abort?: boolean | { reason?: string };
  injectCount: number;
  warnings: StageApplyWarning[];
}

/**
 * Append already-sanitized inject messages to turn history. Mirrors them into
 * the Interactions continuation when one is active. Returns how many landed.
 */
export function applyStageInjects(
  state: StepExecutionState,
  inject: readonly TurnHistoryMessage[],
): number {
  if (inject.length === 0) return 0;
  state.currentHistory.push(...inject);
  if (state.interactionsContinuation) {
    for (const msg of inject) {
      if (msg.role === 'tool') continue;
      state.interactionsContinuation.messages.push(msg);
    }
  }
  return inject.length;
}

/** Run a turn stage, recording every stage event on step state. */
export async function* applyTurnStage(
  args: ApplyTurnStageArgs,
): AsyncGenerator<TurnEvent, ApplyTurnStageResult> {
  const { profile, generation, state, onStage, host, ...call } = args;
  throwIfAborted(call.signal);
  const run = runStage({
    ...call,
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
  return {
    abort: out.abort,
    injectCount: applyStageInjects(state, out.inject),
    warnings: out.warnings,
  };
}
