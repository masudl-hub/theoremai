import type { ToolCallEvent, TurnEventOf } from '../../../../mod.ts';

/** Whether a mic frame should be sent upstream given mute / socket / barge-in gates. */
export function shouldForwardMicFrame(args: {
	isMuted: boolean;
	socketOpen: boolean;
	modelPlaying: boolean;
	rms: number;
	bargeInRmsWhileSpeaking: number;
}): boolean {
	if (args.isMuted || !args.socketOpen) return false;
	if (args.modelPlaying && args.rms < args.bargeInRmsWhileSpeaking) return false;
	return true;
}

/** Classify live evidence transcription into a UI transcript callback payload. */
export function liveTranscriptFromEvidence(
	event: TurnEventOf<'evidence'>,
): { text: string; isUser: boolean; interim: boolean } | null {
	const { evidence, text } = event;
	if (!text) return null;
	if (evidence.kind !== 'input_transcription' && evidence.kind !== 'output_transcription') return null;
	return { text, isUser: evidence.kind === 'input_transcription', interim: evidence.interim === true };
}

export type LiveToolCallDraft = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	error?: string;
};

/**
 * Fold a tool turn event into cancelled-id / runnable-call lists. The model's
 * call is runnable; its failure (a name or arguments the provider could not
 * use) makes it answer the model with that failure instead.
 */
export function applyLiveToolTurnEvent(
	tool: ToolCallEvent,
	accum: { cancelledToolIds: Set<string>; toolCalls: LiveToolCallDraft[] },
): void {
	if (tool.phase === undefined) {
		accum.toolCalls.push({ id: tool.callId, name: tool.name, arguments: tool.arguments });
		return;
	}
	if (tool.phase === 'cancel') {
		accum.cancelledToolIds.add(tool.callId);
		return;
	}
	if (tool.phase !== 'error') return;
	const call = accum.toolCalls.find((draft) => draft.id === tool.callId);
	if (call) call.error = tool.failure.message;
}
