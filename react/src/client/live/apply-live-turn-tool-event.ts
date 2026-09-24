import type { TurnEvent } from '../../../../mod.ts';
import { TheoremStreamError } from '../transport.ts';

type LiveToolEventArgs = {
	gateOpen: boolean;
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
function toolStepFailure(tool: NonNullable<TurnEvent['tool']>): TheoremStreamError {
	const failure = tool.failure;
	return failure
		? new TheoremStreamError(failure.kind, failure.error, failure.message)
		: new TheoremStreamError('failed');
}

function clearToolUnlessGated(args: LiveToolEventArgs): void {
	if (!args.gateOpen) args.clearActiveTool();
}

function applyToolPhase(tool: NonNullable<TurnEvent['tool']>, args: LiveToolEventArgs): void {
	if (tool.phase === 'cancel' || tool.phase === 'complete') {
		clearToolUnlessGated(args);
		return;
	}
	if (tool.phase === 'error') {
		args.reportFailure(toolStepFailure(tool));
		clearToolUnlessGated(args);
		return;
	}
	if (tool.name) args.setActiveTool(tool.name);
}

/** Apply a live turn event to active-tool / caption / error state. */
export function applyLiveTurnToolEvent(event: TurnEvent, args: LiveToolEventArgs): void {
	if (event.type === 'done') {
		args.clearInterim();
		clearToolUnlessGated(args);
		return;
	}
	if (event.type === 'tool' && event.tool) {
		applyToolPhase(event.tool, args);
	}
}
