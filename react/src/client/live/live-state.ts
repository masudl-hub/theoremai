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

export function liveStateLabel(args: {
	status: LiveSessionStatus;
	connectPhase: LiveConnectPhase | null;
	toolName: string | null;
	isMuted: boolean;
	voiceEnabled?: boolean;
}): string {
	if (args.toolName) return `calling ${args.toolName}`;
	if (args.connectPhase === 'socket') return 'connecting';
	if (args.connectPhase === 'microphone') return 'requesting mic';
	if (args.status === 'speaking') return 'speaking';
	if (args.status === 'listening' || args.status === 'ready') {
		if (args.voiceEnabled === false) return 'connected';
		return args.isMuted ? 'muted' : 'listening';
	}
	if (args.status === 'connecting') return 'connecting';
	if (args.status === 'error') return 'error';
	return 'ended';
}
