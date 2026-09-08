import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TurnEvent } from 'theorum';
import { liveIngressEnabledFromSpec } from 'theorum';
import type { LiveProfileInterface } from 'theorum/interface';
import type { CaptionFocus } from '../../client/live/caption-focus';
import {
	applyLiveTranscript,
	clearLiveCaptionInterim,
	emptyLiveCaptionState,
	type LiveCaptionState,
	latestLiveCaptionTurnId,
} from '../../client/live/live-captions';
import { registerPlaygroundLiveProfile } from '../../client/live/live-session';
import { liveStateLabel } from '../../client/live/live-state';
import { invokePlaygroundLiveTool, type LiveToolPausePrompt } from '../../client/live/live-tool';
import { type LiveVideoCapture, startLiveVideoCapture } from '../../client/live/live-video';
import {
	type LiveConnectPhase,
	LiveSessionClient,
	type LiveSessionStatus,
} from '../../client/live-client';
import type { PlaygroundRunPayload } from '../../client/run-payload';
import type { ToolPauseResolution } from '../../client/tool-resume';
import { LiveStage } from './LiveStage';
import { LiveToolPausePanel } from './LiveToolPausePanel';

export type LiveRunnerProps = {
	iface: LiveProfileInterface;
	payload: PlaygroundRunPayload;
};

function toolFailureMessage(tool: NonNullable<TurnEvent['tool']>): string {
	if (tool.failure?.message) return tool.failure.message;
	if (tool.name) return `Tool '${tool.name}' failed`;
	return 'Tool call failed';
}

export function LiveRunner({ iface, payload }: LiveRunnerProps) {
	const [status, setStatus] = useState<LiveSessionStatus>('disconnected');
	const [connectPhase, setConnectPhase] = useState<LiveConnectPhase | null>(null);
	const [inputLevel, setInputLevel] = useState(0);
	const [outputLevel, setOutputLevel] = useState(0);
	const [isMuted, setIsMuted] = useState(false);
	const [isVideoOn, setIsVideoOn] = useState(false);
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const [captions, setCaptions] = useState<LiveCaptionState>(emptyLiveCaptionState);
	const [captionFocus, setCaptionFocus] = useState<CaptionFocus>(null);
	const [error, setError] = useState('');
	const [textDraft, setTextDraft] = useState('');
	const [textComposerOpen, setTextComposerOpen] = useState(false);
	const [sessionActive, setSessionActive] = useState(false);
	const [sessionPermissions, setSessionPermissions] = useState<string[]>([]);
	const [pausePrompt, setPausePrompt] = useState<LiveToolPausePrompt | null>(null);
	const [everConnected, setEverConnected] = useState(false);

	const clientRef = useRef<LiveSessionClient | null>(null);
	const videoCaptureRef = useRef<LiveVideoCapture | null>(null);
	const pauseResolverRef = useRef<((resolution: ToolPauseResolution) => void) | null>(null);
	const pauseRejectRef = useRef<((reason: Error) => void) | null>(null);

	const captionsRef = useRef(captions);
	const pausePromptRef = useRef(pausePrompt);
	const isMutedRef = useRef(isMuted);
	const sessionPermissionsRef = useRef(sessionPermissions);
	const payloadRef = useRef(payload);
	const statusRef = useRef(status);

	captionsRef.current = captions;
	pausePromptRef.current = pausePrompt;
	isMutedRef.current = isMuted;
	sessionPermissionsRef.current = sessionPermissions;
	payloadRef.current = payload;
	statusRef.current = status;

	const voiceAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'audio');
	const videoAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'video');
	const textAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'text');

	const stateLabel = useMemo(
		() =>
			liveStateLabel({
				status,
				connectPhase,
				toolName: activeTool,
				isMuted,
				voiceEnabled: voiceAvailable,
			}),
		[activeTool, connectPhase, isMuted, status, voiceAvailable],
	);

	const toolActive = activeTool !== null || pausePrompt !== null;

	useEffect(() => {
		if (sessionActive) setEverConnected(true);
	}, [sessionActive]);

	const focusLatestCaption = useCallback((next: LiveCaptionState) => {
		const latestId = latestLiveCaptionTurnId(next);
		if (latestId) setCaptionFocus(latestId);
	}, []);

	const handleLiveTurnEvent = useCallback((event: TurnEvent) => {
		if (event.type === 'done') {
			setCaptions((prev) => clearLiveCaptionInterim(prev));
			if (!pausePromptRef.current) setActiveTool(null);
			return;
		}
		if (event.type !== 'tool' || !event.tool) return;

		const tool = event.tool;
		if (tool.phase === 'cancel') {
			if (!pausePromptRef.current) setActiveTool(null);
			return;
		}
		if (tool.phase === 'error') {
			setError(toolFailureMessage(tool));
			if (!pausePromptRef.current) setActiveTool(null);
			return;
		}
		if (tool.phase === 'complete') {
			if (!pausePromptRef.current) setActiveTool(null);
			return;
		}
		if (tool.name) {
			setActiveTool(tool.name);
		}
	}, []);

	const waitForPauseDecision = useCallback((prompt: LiveToolPausePrompt) => {
		return new Promise<ToolPauseResolution>((resolve, reject) => {
			setPausePrompt(prompt);
			pauseResolverRef.current = resolve;
			pauseRejectRef.current = reject;
		});
	}, []);

	const resolvePauseDecision = useCallback((resolution: ToolPauseResolution) => {
		pauseResolverRef.current?.(resolution);
		pauseResolverRef.current = null;
		pauseRejectRef.current = null;
		setPausePrompt(null);
	}, []);

	const cancelPauseDecision = useCallback((reason = 'Live session ended') => {
		if (pauseRejectRef.current) {
			pauseRejectRef.current(new Error(reason));
		}
		pauseResolverRef.current = null;
		pauseRejectRef.current = null;
		setPausePrompt(null);
	}, []);

	const resetCaptions = useCallback(() => {
		setCaptions(emptyLiveCaptionState());
		setCaptionFocus(null);
	}, []);

	const stopVideo = useCallback(() => {
		if (videoCaptureRef.current) {
			videoCaptureRef.current.stop();
			videoCaptureRef.current = null;
		}
		setIsVideoOn(false);
	}, []);

	const ensureClient = useCallback(
		(profileId: string) => {
			if (clientRef.current) return clientRef.current;

			const client = new LiveSessionClient({
				profile: profileId,
				voiceIngress: voiceAvailable,
				onConnectPhase: (phase) => {
					setConnectPhase(phase);
				},
				onStatusChange: (next) => {
					setStatus(next);
					if (next === 'listening' || next === 'ready') {
						setSessionActive(true);
						setError('');
					}
					if (next === 'disconnected' || next === 'error') {
						setSessionActive(false);
						if (videoCaptureRef.current) {
							videoCaptureRef.current.stop();
							videoCaptureRef.current = null;
						}
						setIsVideoOn(false);
					}
				},
				onTranscript: (text, isUser, meta) => {
					const next = applyLiveTranscript(captionsRef.current, text, isUser, meta?.interim);
					captionsRef.current = next;
					setCaptions(next);
					if (!meta?.interim) {
						const latestId = latestLiveCaptionTurnId(next);
						if (latestId) setCaptionFocus(latestId);
					}
				},
				onTurnEvent: handleLiveTurnEvent,
				onVolumeLevel: (level, isUser) => {
					if (isUser) {
						setInputLevel(isMutedRef.current ? 0 : level);
					} else {
						setOutputLevel(level);
					}
				},
				onError: (message) => {
					setError(message);
				},
				onToolCall: async (name, args) => {
					setActiveTool(name);
					setError('');
					try {
						const result = await invokePlaygroundLiveTool({
							payload: payloadRef.current,
							name,
							input: args,
							sessionPermissions: sessionPermissionsRef.current,
							onPause: waitForPauseDecision,
						});
						sessionPermissionsRef.current = result.sessionPermissions;
						setSessionPermissions(result.sessionPermissions);
						const outputError =
							typeof result.output.error === 'string' ? result.output.error : undefined;
						if (outputError) setError(outputError);
						return result.output;
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						setError(message);
						return { error: message };
					} finally {
						if (!pausePromptRef.current) setActiveTool(null);
					}
				},
			});

			clientRef.current = client;
			return client;
		},
		[handleLiveTurnEvent, voiceAvailable, waitForPauseDecision],
	);

	const teardownSession = useCallback(() => {
		cancelPauseDecision();
		if (clientRef.current) {
			clientRef.current.disconnect();
			clientRef.current = null;
		}
		stopVideo();
		setIsMuted(false);
		isMutedRef.current = false;
		setTextComposerOpen(false);
		setSessionActive(false);
		setSessionPermissions([]);
		sessionPermissionsRef.current = [];
		statusRef.current = 'disconnected';
		setStatus('disconnected');
		setConnectPhase(null);
		setInputLevel(0);
		setOutputLevel(0);
	}, [cancelPauseDecision, stopVideo]);

	const startSession = useCallback(async () => {
		setError('');
		resetCaptions();
		try {
			const profileId = await registerPlaygroundLiveProfile(payloadRef.current);
			const liveClient = ensureClient(profileId);
			if (statusRef.current === 'disconnected' || statusRef.current === 'error') {
				await liveClient.connect();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [ensureClient, resetCaptions]);

	const handleSendText = useCallback(() => {
		const text = textDraft.trim();
		if (!text || !clientRef.current || !sessionActive || !textAvailable) return;
		clientRef.current.sendText(text);
		setTextDraft('');
		const next = applyLiveTranscript(captionsRef.current, text, true, false, {
			forceNew: true,
		});
		captionsRef.current = next;
		setCaptions(next);
		focusLatestCaption(next);
	}, [focusLatestCaption, sessionActive, textAvailable, textDraft]);

	const handleToggleTextComposer = useCallback(() => {
		if (!textAvailable) return;
		setTextComposerOpen((open) => !open);
	}, [textAvailable]);

	const handleToggleVideo = useCallback(async () => {
		if (!clientRef.current || !sessionActive || !videoAvailable) return;
		if (isVideoOn) {
			stopVideo();
			return;
		}
		try {
			videoCaptureRef.current = await startLiveVideoCapture((base64) => {
				clientRef.current?.sendVideo(base64);
			});
			setIsVideoOn(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			stopVideo();
		}
	}, [isVideoOn, sessionActive, stopVideo, videoAvailable]);

	const handleToggleMic = useCallback(() => {
		if (!clientRef.current || !sessionActive || !voiceAvailable) return;
		const muted = clientRef.current.toggleMute();
		isMutedRef.current = muted;
		setIsMuted(muted);
	}, [sessionActive, voiceAvailable]);

	const handleEnd = useCallback(() => {
		teardownSession();
	}, [teardownSession]);

	const handleRestart = useCallback(async () => {
		teardownSession();
		await startSession();
	}, [startSession, teardownSession]);

	const startSessionRef = useRef(startSession);
	const teardownSessionRef = useRef(teardownSession);
	startSessionRef.current = startSession;
	teardownSessionRef.current = teardownSession;

	useEffect(() => {
		void startSessionRef.current();
		return () => {
			teardownSessionRef.current();
		};
	}, []);

	return (
		<div className="live-runner">
			<LiveStage
				captionFocus={captionFocus}
				captionTurns={captions.turns}
				error={error}
				handle={iface.identity.handle}
				inputLevel={inputLevel}
				interimAgent={captions.interimAgent}
				interimUser={captions.interimUser}
				isMuted={isMuted}
				isVideoOn={isVideoOn}
				onCaptionFocusChange={setCaptionFocus}
				onEnd={handleEnd}
				onRestart={() => {
					void handleRestart();
				}}
				onSendText={handleSendText}
				onTextDraftChange={setTextDraft}
				onToggleMic={handleToggleMic}
				onToggleTextComposer={handleToggleTextComposer}
				onToggleVideo={() => {
					void handleToggleVideo();
				}}
				outputLevel={outputLevel}
				sessionActive={sessionActive}
				stateLabel={stateLabel}
				status={status}
				textAvailable={textAvailable}
				textComposerOpen={textComposerOpen}
				textDraft={textDraft}
				toolActive={toolActive}
				videoAvailable={videoAvailable}
				voiceAvailable={voiceAvailable}
				canRestart={!sessionActive && everConnected && status !== 'connecting'}
			/>

			{pausePrompt ? (
				<LiveToolPausePanel pause={pausePrompt.pause} onResolve={resolvePauseDecision} />
			) : null}
		</div>
	);
}
