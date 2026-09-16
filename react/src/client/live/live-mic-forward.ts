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
export function liveTranscriptFromEvidence(args: {
	kind?: string;
	text?: string;
	interim?: boolean;
}): { text: string; isUser: boolean; interim: boolean } | null {
	if (!args.text) return null;
	if (args.kind === 'input_transcription') {
		return { text: args.text, isUser: true, interim: args.interim === true };
	}
	if (args.kind === 'output_transcription') {
		return { text: args.text, isUser: false, interim: args.interim === true };
	}
	return null;
}

export type LiveToolCallDraft = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	error?: string;
};

/** Fold a tool turn event into cancelled-id / runnable-call lists. */
export function applyLiveToolTurnEvent(
	tool: {
		id?: string;
		name?: string;
		phase?: string;
		arguments?: unknown;
		failure?: { message?: string };
	},
	accum: { cancelledToolIds: Set<string>; toolCalls: LiveToolCallDraft[] },
): void {
	if (tool.phase === 'cancel') {
		if (tool.id) accum.cancelledToolIds.add(tool.id);
		return;
	}
	if (!tool.name) return;
	const failure =
		tool.phase === 'error' && tool.failure?.message ? tool.failure.message : undefined;
	accum.toolCalls.push({
		id: tool.id ?? '',
		name: tool.name,
		arguments: (tool.arguments as Record<string, unknown> | undefined) ?? {},
		error: failure,
	});
}
