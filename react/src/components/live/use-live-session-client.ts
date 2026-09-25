import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { type LexiconOverrides, type SessionEvent, TheoremError, type TurnEvent } from '../../../../mod.ts';
import {
	applyLiveTranscript,
	type LiveCaptionState,
} from '../../client/live/live-captions';
import type { LiveToolGatePrompt } from '../../client/live/live-tool';
import { runLiveToolCall } from '../../client/live/run-live-tool-call';
import type { LiveFacingMode, LiveVideoCapture } from '../../client/live/live-video';
import {
	type LiveConnectPhase,
	LiveSessionClient,
	type LiveSessionStatus,
} from '../../client/live-client';
import type { ToolGateResolution } from '../../client/tool-resume';
import type { TraceFeed } from '../../client/trace-feed';

export type LiveClientBindings = {
	voiceAvailable: boolean;
	/** Where the session's trace records go, when the relay delivers them. */
	traces: TraceFeed;
	handleLiveTurnEvent: (event: TurnEvent) => void;
	waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<ToolGateResolution>;
	captionsRef: MutableRefObject<LiveCaptionState>;
	gatePromptRef: MutableRefObject<LiveToolGatePrompt | null>;
	isMutedRef: MutableRefObject<boolean>;
	sessionPermissionsRef: MutableRefObject<string[]>;
	videoCaptureRef: MutableRefObject<LiveVideoCapture | null>;
	setConnectPhase: Dispatch<SetStateAction<LiveConnectPhase | null>>;
	setStatus: Dispatch<SetStateAction<LiveSessionStatus>>;
	setSessionActive: Dispatch<SetStateAction<boolean>>;
	/** The interface's `lexicon`: the profile's wording. */
	lexicon: LexiconOverrides;
	reportFailure: (err: unknown) => void;
	clearFailure: () => void;
	reportSessionEnded: (session: SessionEvent) => void;
	clearSessionEnded: () => void;
	setCaptions: Dispatch<SetStateAction<LiveCaptionState>>;
	setInputLevel: Dispatch<SetStateAction<number>>;
	setOutputLevel: Dispatch<SetStateAction<number>>;
	setActiveTool: Dispatch<SetStateAction<string | null>>;
	setSessionPermissions: Dispatch<SetStateAction<string[]>>;
	setVideoPreview: Dispatch<SetStateAction<HTMLVideoElement | null>>;
	setVideoFacingMode: Dispatch<SetStateAction<LiveFacingMode>>;
	setIsVideoOn: Dispatch<SetStateAction<boolean>>;
};

function onLiveStatusChange(
	next: LiveSessionStatus,
	bindings: LiveClientBindings,
): void {
	bindings.setStatus(next);
	if (next === 'listening' || next === 'ready') {
		bindings.setSessionActive(true);
		bindings.clearFailure();
		bindings.clearSessionEnded();
		return;
	}
	if (next !== 'disconnected' && next !== 'error') return;
	bindings.setSessionActive(false);
	if (bindings.videoCaptureRef.current) {
		bindings.videoCaptureRef.current.stop();
		bindings.videoCaptureRef.current = null;
	}
	bindings.setVideoPreview(null);
	bindings.setVideoFacingMode('user');
	bindings.setIsVideoOn(false);
}

function onLiveTranscript(
	text: string,
	isUser: boolean,
	meta: { interim?: boolean } | undefined,
	bindings: LiveClientBindings,
): void {
	const next = applyLiveTranscript(bindings.captionsRef.current, text, isUser, meta?.interim);
	bindings.captionsRef.current = next;
	bindings.setCaptions(next);
}

async function onLiveToolCall(
	name: string,
	toolArgs: Record<string, unknown>,
	meta: { callId?: string },
	bindings: LiveClientBindings,
	clientRef: MutableRefObject<LiveSessionClient | null>,
): Promise<Record<string, unknown>> {
	bindings.setActiveTool(name);
	bindings.clearFailure();
	const client = clientRef.current;
	if (!client) {
		// lexicon-exempt: internal diagnostic; the user reads error.request
		bindings.reportFailure(new TheoremError('request', 'live tool call with no session client'));
		return {};
	}
	const callId = meta.callId || `call_${Date.now()}`;
	try {
		return await runLiveToolCall({
			client,
			name,
			toolArgs,
			callId,
			sessionPermissions: bindings.sessionPermissionsRef.current,
			setSessionPermissions: (next) => {
				bindings.sessionPermissionsRef.current = next;
				bindings.setSessionPermissions(next);
			},
			waitForGateDecision: bindings.waitForGateDecision,
			lexicon: bindings.lexicon,
			reportFailure: bindings.reportFailure,
		});
	} catch (err) {
		bindings.reportFailure(err);
		return {};
	} finally {
		if (!bindings.gatePromptRef.current) bindings.setActiveTool(null);
	}
}

/** Owns LiveSessionClient construction + reconnect identity. */
export function useLiveSessionClient(bindings: LiveClientBindings) {
	const clientRef = useRef<LiveSessionClient | null>(null);
	const bindingsRef = useRef(bindings);
	bindingsRef.current = bindings;

	const ensureClient = useCallback((profileId: string) => {
		if (clientRef.current) return clientRef.current;
		const b = bindingsRef.current;
		const client = new LiveSessionClient({
			profile: profileId,
			voiceIngress: b.voiceAvailable,
			onConnectPhase: (phase) => {
				b.setConnectPhase(phase);
			},
			onStatusChange: (next) => {
				onLiveStatusChange(next, bindingsRef.current);
			},
			onTranscript: (text, isUser, meta) => {
				onLiveTranscript(text, isUser, meta, bindingsRef.current);
			},
			onTurnEvent: (event) => {
				bindingsRef.current.handleLiveTurnEvent(event);
			},
			onTrace: (record) => {
				bindingsRef.current.traces.push(record);
			},
			onVolumeLevel: (level, isUser) => {
				const current = bindingsRef.current;
				if (isUser) {
					current.setInputLevel(current.isMutedRef.current ? 0 : level);
				} else {
					current.setOutputLevel(level);
				}
			},
			onError: (err) => {
				bindingsRef.current.reportFailure(err);
			},
			onSessionEnded: (session) => {
				bindingsRef.current.reportSessionEnded(session);
			},
			onToolCall: (name, args, meta) =>
				onLiveToolCall(name, args, meta, bindingsRef.current, clientRef),
		});
		clientRef.current = client;
		return client;
	}, []);

	const clearClient = useCallback(() => {
		if (clientRef.current) {
			clientRef.current.disconnect();
			clientRef.current = null;
		}
	}, []);

	return { clientRef, ensureClient, clearClient };
}
