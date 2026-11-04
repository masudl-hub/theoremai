import type { ToolCallEvent, ToolFailure, TurnEvent } from '@theoremjs/agents';
import { TheoremStreamError } from '@theoremjs/web/client';

/** The tool a live call is running: its name, and its activity label once the call runs. */
export type LiveActiveTool = { name: string; activity?: string };

/** The tool to show after `next`: only the running phase carries the activity, so a later phase of that tool keeps it. */
export function nextActiveTool(prev: LiveActiveTool | null, next: LiveActiveTool): LiveActiveTool {
  return next.activity === undefined && prev?.name === next.name ? prev : next;
}

type LiveToolEventArgs = {
  /** The call whose gate the user is looking at, if one is open. */
  gateCallId: string | undefined;
  /** Close the open gate without an answer: its call is gone. */
  withdrawGate: () => void;
  clearInterim: () => void;
  clearActiveTool: () => void;
  reportFailure: (err: unknown) => void;
  setActiveTool: (tool: LiveActiveTool) => void;
};

export type { LiveToolEventArgs };

/**
 * A failed tool step as the host reported it: the user reads its wording (else
 * the labels' for its kind); the model's `message` stays builder detail.
 */
function toolStepFailure(failure: ToolFailure): TheoremStreamError {
  return new TheoremStreamError(failure.kind, failure.error, failure.message);
}

function clearToolUnlessGated(args: LiveToolEventArgs): void {
  if (args.gateCallId === undefined) args.clearActiveTool();
}

function applyToolPhase(tool: ToolCallEvent, args: LiveToolEventArgs): void {
  if (tool.phase === 'cancel' && tool.callId === args.gateCallId) {
    args.withdrawGate();
    args.clearActiveTool();
    return;
  }
  if (tool.phase === 'cancel' || tool.phase === 'complete') {
    clearToolUnlessGated(args);
    return;
  }
  if (tool.phase === 'error') {
    args.reportFailure(toolStepFailure(tool.failure));
    clearToolUnlessGated(args);
    return;
  }
  args.setActiveTool(
    tool.phase === 'running' && tool.activity
      ? { name: tool.name, activity: tool.activity }
      : { name: tool.name },
  );
}

/** Apply a live turn event to active-tool / caption / error state. */
export function applyLiveTurnToolEvent(event: TurnEvent, args: LiveToolEventArgs): void {
  if (event.type === 'done') {
    args.clearInterim();
    clearToolUnlessGated(args);
    return;
  }
  if (event.type === 'tool') applyToolPhase(event.tool, args);
}
