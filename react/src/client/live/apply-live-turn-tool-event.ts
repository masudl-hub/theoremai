import type { TurnEvent } from '../../../../mod.ts';

type LiveToolEventArgs = {
	gateOpen: boolean;
	clearInterim: () => void;
	clearActiveTool: () => void;
	setError: (message: string) => void;
	setActiveTool: (name: string) => void;
};

export type { LiveToolEventArgs };

function toolFailureMessage(tool: NonNullable<TurnEvent['tool']>): string {
	if (tool.failure?.message) return tool.failure.message;
	if (tool.name) return `Tool '${tool.name}' failed`;
	return 'Tool call failed';
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
		args.setError(toolFailureMessage(tool));
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
