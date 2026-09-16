import { useCallback, useEffect, useMemo, useRef } from 'react';
import { liveIngressEnabledFromSpec } from 'theorum';
import type { LiveProfileInterface } from '../../../../src/interface/mod.ts';
import { liveStateLabel } from '../../client/live/live-state';
import type { PlaygroundRunPayload } from '../../client/run-payload';
import { useLiveRunnerControls } from './use-live-runner-controls';
import { useLiveRunnerGate, useLiveRunnerUiState } from './use-live-runner-ui';
import { useLiveSessionClient } from './use-live-session-client';

/** Owns LiveRunner state, session client, and stage callbacks. */
export function useLiveRunnerModel(iface: LiveProfileInterface, payload: PlaygroundRunPayload) {
	const ui = useLiveRunnerUiState();
	const gate = useLiveRunnerGate({
		setCaptions: ui.setCaptions,
		setActiveTool: ui.setActiveTool,
		setError: ui.setError,
	});
	const payloadRef = useRef(payload);
	payloadRef.current = payload;

	const voiceAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'audio');
	const videoAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'video');
	const textAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'text');

	const stateLabel = useMemo(
		() =>
			liveStateLabel({
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
		setError: ui.setError,
		setCaptions: ui.setCaptions,
		setCaptionFocus: ui.setCaptionFocus,
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
		payloadRef,
		statusRef: ui.statusRef,
		isMutedRef: ui.isMutedRef,
		sessionPermissionsRef: ui.sessionPermissionsRef,
		ensureClient,
		clearClient,
		cancelGateDecision: gate.cancelGateDecision,
		stopVideo: ui.stopVideo,
		resetCaptions: ui.resetCaptions,
		focusLatestCaption: ui.focusLatestCaption,
		sessionActive: ui.sessionActive,
		textAvailable,
		videoAvailable,
		voiceAvailable,
		isVideoOn: ui.isVideoOn,
		textDraft: ui.textDraft,
		setTextDraft: ui.setTextDraft,
		setCaptions: ui.setCaptions,
		setError: ui.setError,
		setIsMuted: ui.setIsMuted,
		setTextComposerOpen: ui.setTextComposerOpen,
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

	const handleEnd = useCallback(() => {
		controls.teardownSession();
	}, [controls]);

	const startSessionRef = useRef(controls.startSession);
	const teardownSessionRef = useRef(controls.teardownSession);
	startSessionRef.current = controls.startSession;
	teardownSessionRef.current = controls.teardownSession;

	useEffect(() => {
		void startSessionRef.current();
		return () => {
			teardownSessionRef.current();
		};
	}, []);

	return {
		handle: iface.identity.handle,
		captionFocus: ui.captionFocus,
		captions: ui.captions,
		error: ui.error,
		inputLevel: ui.inputLevel,
		isMuted: ui.isMuted,
		isVideoOn: ui.isVideoOn,
		outputLevel: ui.outputLevel,
		sessionActive: ui.sessionActive,
		stateLabel,
		status: ui.status,
		textAvailable,
		textComposerOpen: ui.textComposerOpen,
		textDraft: ui.textDraft,
		toolActive: ui.activeTool !== null || gate.gatePrompt !== null,
		videoAvailable,
		videoFacingMode: ui.videoFacingMode,
		videoPreview: ui.videoPreview,
		voiceAvailable,
		canRestart: !ui.sessionActive && ui.everConnected && ui.status !== 'connecting',
		gatePrompt: gate.gatePrompt,
		setCaptionFocus: ui.setCaptionFocus,
		setTextDraft: ui.setTextDraft,
		handleEnd,
		handleRestart: controls.handleRestart,
		handleSendText: controls.handleSendText,
		handleToggleMic: controls.handleToggleMic,
		handleFlipCamera: controls.handleFlipCamera,
		handleToggleTextComposer: controls.handleToggleTextComposer,
		handleToggleVideo: controls.handleToggleVideo,
		resolveGateDecision: gate.resolveGateDecision,
	};
}
