import type { TurnTaint } from '../../../guardrails/types.ts';
import type { TurnToolSnapshot } from '../../tools/types.ts';
import type {
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
  TurnStop,
} from '../../types.ts';

interface StepExecutionState {
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  sawTokensEvent: boolean;
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
  /** Pending Interactions `function_result` continuation for the next provider step. */
  interactionsContinuation?: {
    previousInteractionId: string;
    input: Record<string, unknown>[];
  };
  /**
   * Generation whose opening `input` was folded into `currentHistory` for steering.
   * Compared by identity so repair retries (new generation) fold again.
   */
  foldedForGeneration?: ResolvedGeneration;
}

interface AttemptFlowState {
  currentAttempt: number;
  currentReq: TurnRequest;
  currentGen: ResolvedGeneration;
}

function recordStepEvent(event: TurnEvent, state: StepExecutionState): void {
  if (event.type === 'tokens') {
    state.sawTokensEvent = true;
  }
  state.allEmittedEvents.push(event);
  state.attemptEvents.push(event);
}

export type { AttemptFlowState, StepExecutionState };
export { recordStepEvent };
