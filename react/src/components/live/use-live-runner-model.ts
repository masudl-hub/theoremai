import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveIngressEnabledFromSpec } from '../../../../mod.ts';
import type { LiveProfileInterface } from '../../../../src/interface/mod.ts';
import type { LiveCaptionState, LiveCaptionTurn } from '../../client/live/live-captions';
import { liveState } from '../../client/live/live-state';
import { useLiveRunnerControls } from './use-live-runner-controls';
import { useLiveRunnerGate, useLiveRunnerUiState } from './use-live-runner-ui';
import { useLiveSessionClient } from './use-live-session-client';

type LiveControls = ReturnType<typeof useLiveRunnerControls>;

/**
 * Calls start from the landing (voice, or video + voice), not on mount. Once
 * started, the call view stays until a reload; ending leaves Start call. Each
 * restart is a new conversation; earlier calls' captions stay, above a divider.
 */
function useLiveCallLifecycle(
	controls: LiveControls,
	captionsRef: MutableRefObject<LiveCaptionState>,
	sessionActive: boolean,
	videoAvailable: boolean,
) {
	const [callStarted, setCallStarted] = useState(false);
	const [ended, setEnded] = useState(false);
	const videoOnConnectRef = useRef(false);

	const startCall = useCallback(
		(options: { video: boolean }) => {
			videoOnConnectRef.current = options.video && videoAvailable;
			setCallStarted(true);
			setEnded(false);
			void controls.startSession();
		},
		[controls, videoAvailable],
	);

	// Camera capture needs a live session, so a video call turns it on once connected.
	useEffect(() => {
		if (!sessionActive || !videoOnConnectRef.current) return;
		videoOnConnectRef.current = false;
		void controls.handleToggleVideo();
	}, [controls, sessionActive]);

	const handleEnd = useCallback(() => {
		videoOnConnectRef.current = false;
		controls.teardownSession();
		setEnded(true);
	}, [controls]);

	const [pastCalls, setPastCalls] = useState<LiveCaptionTurn[][]>([]);

	const handleRestart = useCallback(async () => {
		const previous = captionsRef.current.turns;
		if (previous.length > 0) setPastCalls((calls) => [...calls, previous]);
		setEnded(false);
		await controls.handleRestart();
	}, [controls, captionsRef]);

	const teardownSessionRef = useRef(controls.teardownSession);
	teardownSessionRef.current = controls.teardownSession;

	useEffect(() => {
		return () => {
			teardownSessionRef.current();
		};
	}, []);

	return { callStarted, ended, pastCalls, startCall, handleEnd, handleRestart };
}

/**
 * Owns LiveRunner state, session client, and stage callbacks.
 * `registerProfile` resolves the live profile id the relay should open — hosts
 * with a fixed profile return it directly; the playground registers its draft.
 */
export function useLiveRunnerModel(
	iface: LiveProfileInterface,
	registerProfile: () => Promise<string>,
) {
	const ui = useLiveRunnerUiState(iface.lexicon);
	const gate = useLiveRunnerGate({
		setCaptions: ui.setCaptions,
		setActiveTool: ui.setActiveTool,
		reportFailure: ui.reportFailure,
	});
	const registerProfileRef = useRef(registerProfile);
	registerProfileRef.current = registerProfile;

	const voiceAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'audio');
	const videoAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'video');
	const textAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'text');

	const state = useMemo(
		() =>
			liveState({
				status: ui.status,
				connectPhase: ui.connectPhase,
				toolName: ui.activeTool,
				isMuted: ui.isMuted,
				voiceEnabled: voiceAvailable,
			}),
		[ui.activeTool, ui.connectPhase, ui.isMuted, ui.status, voiceAvailable],
	);

	const { clientRef, ensureClient, clearClient } = useLiveSessionClient({
		voiceAvailable,
		handleLiveTurnEvent: gate.handleLiveTurnEvent,
		waitForGateDecision: gate.waitForGateDecision,
		captionsRef: ui.captionsRef,
		gatePromptRef: gate.gatePromptRef,
		isMutedRef: ui.isMutedRef,
		sessionPermissionsRef: ui.sessionPermissionsRef,
		videoCaptureRef: ui.videoCaptureRef,
		setConnectPhase: ui.setConnectPhase,
		setStatus: ui.setStatus,
		setSessionActive: ui.setSessionActive,
		lexicon: iface.lexicon,
		reportFailure: ui.reportFailure,
		clearFailure: ui.clearFailure,
		reportSessionEnded: ui.reportSessionEnded,
		clearSessionEnded: ui.clearSessionEnded,
		setCaptions: ui.setCaptions,
		setInputLevel: ui.setInputLevel,
		setOutputLevel: ui.setOutputLevel,
		setActiveTool: ui.setActiveTool,
		setSessionPermissions: ui.setSessionPermissions,
		setVideoPreview: ui.setVideoPreview,
		setVideoFacingMode: ui.setVideoFacingMode,
		setIsVideoOn: ui.setIsVideoOn,
	});

	const controls = useLiveRunnerControls({
		clientRef,
		videoCaptureRef: ui.videoCaptureRef,
		captionsRef: ui.captionsRef,
		registerProfileRef,
		statusRef: ui.statusRef,
		isMutedRef: ui.isMutedRef,
		sessionPermissionsRef: ui.sessionPermissionsRef,
		ensureClient,
		clearClient,
		cancelGateDecision: gate.cancelGateDecision,
		stopVideo: ui.stopVideo,
		resetCaptions: ui.resetCaptions,
		sessionActive: ui.sessionActive,
		textAvailable,
		videoAvailable,
		voiceAvailable,
		isVideoOn: ui.isVideoOn,
		textDraft: ui.textDraft,
		setTextDraft: ui.setTextDraft,
		setCaptions: ui.setCaptions,
		reportFailure: ui.reportFailure,
		clearFailure: ui.clearFailure,
		setIsMuted: ui.setIsMuted,
		setSessionActive: ui.setSessionActive,
		setSessionPermissions: ui.setSessionPermissions,
		setStatus: ui.setStatus,
		setConnectPhase: ui.setConnectPhase,
		setInputLevel: ui.setInputLevel,
		setOutputLevel: ui.setOutputLevel,
		setVideoPreview: ui.setVideoPreview,
		setVideoFacingMode: ui.setVideoFacingMode,
		setIsVideoOn: ui.setIsVideoOn,
	});

	const { callStarted, ended, pastCalls, startCall, handleEnd, handleRestart } = useLiveCallLifecycle(
		controls,
		ui.captionsRef,
		ui.sessionActive,
		videoAvailable,
	);

	return {
		handle: iface.identity.handle,
		callStarted,
		pastCalls,
		captions: ui.captions,
		failure: ui.failure,
		sessionEnded: ui.sessionEnded,
		inputLevel: ui.inputLevel,
		isMuted: ui.isMuted,
		isVideoOn: ui.isVideoOn,
		outputLevel: ui.outputLevel,
		sessionActive: ui.sessionActive,
		liveState: state,
		activeTool: ui.activeTool,
		status: ui.status,
		textAvailable,
		textDraft: ui.textDraft,
		toolActive: ui.activeTool !== null || gate.gatePrompt !== null,
		videoAvailable,
		videoFacingMode: ui.videoFacingMode,
		videoPreview: ui.videoPreview,
		voiceAvailable,
		// Also after ending (or failing) before the first connect, so the call can't get stuck.
		canRestart: !ui.sessionActive && ui.status !== 'connecting' && (ui.everConnected || ended || ui.failure !== null),
		gatePrompt: gate.gatePrompt,
		setTextDraft: ui.setTextDraft,
		handleEnd,
		startCall,
		handleRestart,
		handleSendText: controls.handleSendText,
		handleToggleMic: controls.handleToggleMic,
		handleFlipCamera: controls.handleFlipCamera,
		handleToggleVideo: controls.handleToggleVideo,
		resolveGateDecision: gate.resolveGateDecision,
	};
}
