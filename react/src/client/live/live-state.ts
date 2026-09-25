export type LiveConnectPhase = 'socket' | 'microphone';
export type LiveSessionStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'ready'
	| 'listening'
	| 'speaking'
	| 'working'
	| 'error';

/** What a live call is doing, for its status line; the UI words it. */
export type LiveState =
	| 'calling_tool'
	| 'connecting'
	| 'requesting_mic'
	| 'speaking'
	| 'connected'
	| 'muted'
	| 'listening'
	| 'error'
	| 'ended';

export function liveState(args: {
	status: LiveSessionStatus;
	connectPhase: LiveConnectPhase | null;
	toolName: string | null;
	isMuted: boolean;
	voiceEnabled?: boolean;
}): LiveState {
	if (args.toolName) return 'calling_tool';
	if (args.connectPhase === 'socket') return 'connecting';
	if (args.connectPhase === 'microphone') return 'requesting_mic';
	if (args.status === 'speaking') return 'speaking';
	if (args.status === 'listening' || args.status === 'ready') {
		if (args.voiceEnabled === false) return 'connected';
		return args.isMuted ? 'muted' : 'listening';
	}
	if (args.status === 'connecting') return 'connecting';
	if (args.status === 'error') return 'error';
	return 'ended';
}
