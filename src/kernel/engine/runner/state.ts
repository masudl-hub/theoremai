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
  /** Last provider stop from a discarded provider `done` event. */
  lastStop?: TurnStop;
  /** Latest Google Interactions id observed on the current provider stream. */
  lastInteractionId?: string;
  /** Pending Interactions `function_result` continuation for the next provider step. */
  interactionsContinuation?: {
    previousInteractionId: string;
    input: Record<string, unknown>[];
  };
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
