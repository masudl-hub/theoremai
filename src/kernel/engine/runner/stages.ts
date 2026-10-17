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
import type { Profile, ResolvedGeneration, TurnEvent, TurnStage } from '../../types.ts';
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

/** Sanitized stage injects extend portable history. */
export function* applyStageInjects(
  state: StepExecutionState,
  stage: TurnStage,
  units: readonly InjectUnit[],
  extra?: { callId?: string; toolName?: string },
): Generator<TurnEvent, number> {
  const inject = injectMessages(units);
  if (inject.length === 0) return 0;
  state.currentHistory.push(...inject);
  const landed = injectedStageEvent(stage, units, extra);
  if (landed) {
    state.allEmittedEvents.push(landed);
    yield landed;
  }
  return inject.length;
}

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
    injectCount: yield* applyStageInjects(state, call.stage, out.inject),
    warnings: out.warnings,
  };
}
