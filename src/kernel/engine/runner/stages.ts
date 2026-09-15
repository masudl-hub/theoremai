/**
 * Runner-side turn-stage emit + affordance application.
 *
 * Contract: `docs/contracts/stages.md`. Shared by text `runTurn` (slice 1 spine).
 *
 * @module
 */

import { throwIfAborted } from '../../../guardrails/error.ts';
import { detectionForTrust, resolveGuardrailPolicy } from '../../../guardrails/policy.ts';
import { sanitizeHistory } from '../../../guardrails/sanitize.ts';
import { wireInteractionPart } from '../../interaction-parts.ts';
import {
  applyStageResult,
  buildStageContext,
  type StageApplyWarning,
  type StageCallBag,
  type StageContext,
  type StageHandler,
  stageEventFields,
} from '../../stages.ts';
import { profileAllowsInject } from '../../stop.ts';
import type { Profile, ResolvedGeneration, TurnEvent, TurnHistoryMessage } from '../../types.ts';
import { invokeStageHandler } from '../stage-invoke.ts';
import type { StepExecutionState } from './state.ts';

function sanitizeStageInjects(
  profile: Profile,
  messages: TurnHistoryMessage[],
): TurnHistoryMessage[] {
  const policy = resolveGuardrailPolicy(profile.guardrails);
  return sanitizeHistory(messages, detectionForTrust(policy, 'untrusted'));
}

function stageMessageToInteractionStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const type = msg.role === 'assistant' ? 'model_output' : 'user_input';
  if (msg.parts && msg.parts.length > 0) {
    return {
      type,
      content: msg.parts.map(wireInteractionPart),
    };
  }
  return { type, content: [{ type: 'text', text: msg.content ?? '' }] };
}

/** Move opening user `generation.input` into history (Interactions-safe fold). */
function foldGenerationInputIntoHistory(
  generation: ResolvedGeneration,
  state: StepExecutionState,
): void {
  if (state.foldedForGeneration === generation) return;
  state.foldedForGeneration = generation;
  if (generation.input.length === 0) return;
  const textOnly = generation.input.every((p) => p.type === 'text');
  if (textOnly) {
    state.currentHistory.push({
      role: 'user',
      content: generation.input.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    });
  } else {
    state.currentHistory.push({
      role: 'user',
      parts: [...generation.input],
    });
  }
  generation.input = [];
}

export interface ApplyTurnStageArgs extends StageCallBag {
  profile: Profile;
  generation: ResolvedGeneration;
  state: StepExecutionState;
  stage: StageContext['stage'];
  step: number;
  onStage?: StageHandler;
  signal?: AbortSignal;
  /** Fold generation.input into history when true (pre_turn + handler present). */
  foldInput?: boolean;
  /** Another provider step would exceed maxSteps — reject inject. */
  injectWouldExceedMaxSteps?: boolean;
  host?: unknown;
}

export interface ApplyTurnStageResult {
  abort?: boolean | { reason?: string };
  injectCount: number;
  warnings: StageApplyWarning[];
}

function appendInjects(
  state: StepExecutionState,
  profile: Profile,
  inject: TurnHistoryMessage[],
): number {
  if (inject.length === 0) return 0;
  const sanitized = sanitizeStageInjects(profile, inject);
  if (sanitized.length === 0) return 0;
  state.currentHistory.push(...sanitized);
  if (state.interactionsContinuation) {
    for (const msg of sanitized) {
      if (msg.role === 'tool') continue;
      state.interactionsContinuation.input.push(stageMessageToInteractionStep(msg));
    }
  }
  return sanitized.length;
}

/** Apply stage inject messages onto turn history (shared with tool execute stages). */
export function applyStageInjects(
  state: StepExecutionState,
  profile: Profile,
  inject: TurnHistoryMessage[],
): number {
  return appendInjects(state, profile, inject);
}

/**
 * Emit a `stage` event, invoke `onStage`, apply returned affordances.
 * Stage events always emit. Inject requires `profileAllowsInject`.
 */
export async function* applyTurnStage(
  args: ApplyTurnStageArgs,
): AsyncGenerator<TurnEvent, ApplyTurnStageResult> {
  throwIfAborted(args.signal);

  // Stream stage events stay lean (no outputRaw/failure). Hosts read those on
  // StageContext via onStage; tool failures also ride tool events.
  const event: TurnEvent = stageEventFields(args.stage, {
    callId: args.callId,
    toolName: args.tool,
    callNotStarted: args.callNotStarted,
    awaiting: args.awaiting,
    gate: args.gate,
    stop: args.stop,
  });
  args.state.allEmittedEvents.push(event);
  yield event;

  if (args.foldInput && args.onStage) {
    foldGenerationInputIntoHistory(args.generation, args.state);
  }

  const empty: ApplyTurnStageResult = { injectCount: 0, warnings: [] };
  if (!args.onStage) return empty;

  const ctx = buildStageContext({
    stage: args.stage,
    step: args.step,
    history: args.state.currentHistory,
    host: args.host ?? args.generation.host,
    callId: args.callId,
    tool: args.tool,
    input: args.input,
    callNotStarted: args.callNotStarted,
    outputRaw: args.outputRaw,
    outputModel: args.outputModel,
    failure: args.failure,
    awaiting: args.awaiting,
    stop: args.stop,
    gate: args.gate,
  });

  const raw = await invokeStageHandler(args.onStage, ctx, args.signal);

  const applied = applyStageResult({
    stage: args.stage,
    result: raw,
    injectAllowed: profileAllowsInject(args.profile),
    injectWouldExceedMaxSteps: args.injectWouldExceedMaxSteps,
  });

  if (applied.warnings.length > 0) {
    const warnEv: TurnEvent = {
      type: 'stage',
      stage: args.stage,
      stageWarnings: applied.warnings,
    };
    args.state.allEmittedEvents.push(warnEv);
    yield warnEv;
  }

  let injectCount = 0;
  if (applied.inject?.length) {
    injectCount = appendInjects(args.state, args.profile, applied.inject);
  }

  return {
    abort: applied.abort,
    injectCount,
    warnings: applied.warnings,
  };
}

/** True when another provider step would exceed profile/generation maxSteps. */
export function injectWouldExceedMaxSteps(
  stepCount: number,
  maxSteps: number | undefined,
): boolean {
  if (maxSteps === undefined || maxSteps <= 0) return false;
  return stepCount >= maxSteps;
}
