import type { LiveConnectPhase, LiveSessionStatus } from '../live-client';

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
