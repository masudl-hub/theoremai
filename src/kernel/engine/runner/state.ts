import type { GuardrailHit, TurnTaint } from '../../../guardrails/types.ts';
import type { SpanHandle } from '../../../observability/trace-span.ts';
import type { TurnToolSnapshot } from '../../tools/types.ts';
import type {
  InteractionPart,
  ModelBinding,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
  TurnStop,
} from '../../types.ts';
import type { MediaTokenFamily } from '../token-estimate.ts';
import type { CallUsage } from './usage.ts';

/** Where this turn's spans go. */
interface TurnTraceState {
  /** The turn's `invoke_agent` span; model calls and tools open under it. */
  root: SpanHandle;
  /** Validation / egress attempt the next model call belongs to (0-based). */
  attempt: number;
  /** Model calls made so far. */
  calls: number;
  /** The turn's model binding, for `gen_ai.provider.name`. */
  binding: ModelBinding | undefined;
}

interface StepExecutionState {
  trace: TurnTraceState;
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  /** Media family of the turn's model binding, for estimating unreported usage. */
  mediaFamily: MediaTokenFamily | undefined;
  allEmittedEvents: TurnEvent[];
  attemptEvents: TurnEvent[];
  /**
   * True when progressive yield withheld user-visible events during this attempt.
   *
   * The attempt gate needs it: if the mid-stream window tripped but the final
   * verdict on the whole text passes, nothing was streamed, so the buffered
   * text must be released rather than silently dropped.
   */
  withheldVisible?: boolean;
  /**
   * The canary opening the last provider call ended on, read in front of the
   * next call's reply so a token split across steps is still one match.
   */
  canaryCarry?: string;
  /**
   * System-prompt leaks this attempt withheld under a host policy. The
   * end-of-attempt verdict is pinned to block when any were seen.
   */
  promptLeaks?: GuardrailHit[];
  /**
   * Untrusted remote content this turn has already read.
   *
   * Accumulates across tool calls so a later call can be judged against what the
   * turn has ingested, not just its own arguments.
   */
  taint?: TurnTaint;
  /** Last provider stop from a discarded provider `done` event. */
  lastStop?: TurnStop;
  /** Tool snapshot at tool pause — emitted on terminal `done` when `stop.kind === 'tool'`. */
  toolSnapshot?: TurnToolSnapshot;
  /** Latest Google Interactions id observed on the current provider stream. */
  lastInteractionId?: string;
  /**
   * Pending Interactions continuation for the next provider step: tool results
   * and stage injects, sent as `continuation`.
   */
  interactionsContinuation?: {
    previousInteractionId: string;
    messages: TurnHistoryMessage[];
  };
  /** Usage of the last model call; a continuation's prompt estimate extends it. */
  lastCall?: CallUsage;
}

interface AttemptFlowState {
  currentAttempt: number;
  currentReq: TurnRequest;
  currentGen: ResolvedGeneration;
}

function recordStepEvent(event: TurnEvent, state: StepExecutionState): void {
  state.allEmittedEvents.push(event);
  state.attemptEvents.push(event);
}

/** Append user parts to turn history as one user message (plain text stays a string). */
function appendUserInput(state: StepExecutionState, parts: readonly InteractionPart[]): void {
  if (parts.length === 0) return;
  const textOnly = parts.every((p) => p.type === 'text');
  state.currentHistory.push(
    textOnly
      ? { role: 'user', content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }
      : { role: 'user', parts: [...parts] },
  );
}

/**
 * Step state for one turn. A text turn's history grows inside the turn (tool
 * steps, stage injects, repair retries), so its opening input moves into turn
 * history here and everything later lands after it; `generation.input` is then
 * empty. Image and speech turns are one call that reads only the input, so
 * theirs stays put.
 */
function openTurnState(args: {
  profile: Profile;
  generation: ResolvedGeneration;
  trace: TurnTraceState;
  mediaFamily: MediaTokenFamily | undefined;
  allEmittedEvents?: TurnEvent[];
}): StepExecutionState {
  const { profile, generation } = args;
  const state: StepExecutionState = {
    trace: args.trace,
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    mediaFamily: args.mediaFamily,
    allEmittedEvents: args.allEmittedEvents ?? [],
    attemptEvents: [],
  };
  if (profile.type === 'text') {
    appendUserInput(state, generation.input);
    generation.input = [];
  }
  return state;
}

export type { AttemptFlowState, StepExecutionState, TurnTraceState };
export { appendUserInput, openTurnState, recordStepEvent };
