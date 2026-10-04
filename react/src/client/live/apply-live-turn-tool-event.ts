import type { ToolCallEvent, ToolFailure, TurnEvent } from '@theoremjs/agents';
import { TheoremStreamError } from '../transport.ts';

type LiveToolEventArgs = {
	/** The call whose gate the user is looking at, if one is open. */
	gateCallId: string | undefined;
	/** Close the open gate without an answer: its call is gone. */
	withdrawGate: () => void;
	clearInterim: () => void;
	clearActiveTool: () => void;
	reportFailure: (err: unknown) => void;
	setActiveTool: (name: string) => void;
};

export type { LiveToolEventArgs };

/**
 * A failed tool step as the host reported it: the user reads its wording (else
 * the lexicon's for its kind); the model's `message` stays builder detail.
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
	args.setActiveTool(tool.name);
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
