import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CaptionFocus } from '../../client/live/caption-focus';
import { applyLiveTurnToolEvent } from '../../client/live/apply-live-turn-tool-event';
import {
	clearLiveCaptionInterim,
	emptyLiveCaptionState,
	latestLiveCaptionTurnId,
	type LiveCaptionState,
} from '../../client/live/live-captions';
import type { LiveToolGatePrompt } from '../../client/live/live-tool';
import { type LiveFacingMode, type LiveVideoCapture } from '../../client/live/live-video';
import type { LiveConnectPhase, LiveSessionStatus } from '../../client/live-client';
import type { ToolGateResolution } from '../../client/tool-resume';

/** UI + media state bag for the live runner. */
export function useLiveRunnerUiState() {
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
	const [everConnected, setEverConnected] = useState(false);
	const [videoPreview, setVideoPreview] = useState<HTMLVideoElement | null>(null);
	const [videoFacingMode, setVideoFacingMode] = useState<LiveFacingMode>('user');

	const videoCaptureRef = useRef<LiveVideoCapture | null>(null);
	const captionsRef = useRef(captions);
	const isMutedRef = useRef(isMuted);
	const sessionPermissionsRef = useRef(sessionPermissions);
	const statusRef = useRef(status);

	captionsRef.current = captions;
	isMutedRef.current = isMuted;
	sessionPermissionsRef.current = sessionPermissions;
	statusRef.current = status;

	useEffect(() => {
		if (sessionActive) setEverConnected(true);
	}, [sessionActive]);

	const focusLatestCaption = useCallback((next: LiveCaptionState) => {
		const latestId = latestLiveCaptionTurnId(next);
		if (latestId) setCaptionFocus(latestId);
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
		setVideoPreview(null);
		setVideoFacingMode('user');
		setIsVideoOn(false);
	}, []);

	return {
		status,
		setStatus,
		connectPhase,
		setConnectPhase,
		inputLevel,
		setInputLevel,
		outputLevel,
		setOutputLevel,
		isMuted,
		setIsMuted,
		isVideoOn,
		setIsVideoOn,
		activeTool,
		setActiveTool,
		captions,
		setCaptions,
		captionFocus,
		setCaptionFocus,
		error,
		setError,
		textDraft,
		setTextDraft,
		textComposerOpen,
		setTextComposerOpen,
		sessionActive,
		setSessionActive,
		sessionPermissions,
		setSessionPermissions,
		everConnected,
		videoPreview,
		setVideoPreview,
		videoFacingMode,
		setVideoFacingMode,
		videoCaptureRef,
		captionsRef,
		isMutedRef,
		sessionPermissionsRef,
		statusRef,
		focusLatestCaption,
		resetCaptions,
		stopVideo,
	};
}

/** Gate prompt + live turn-tool event wiring. */
export function useLiveRunnerGate(args: {
	setCaptions: Dispatch<SetStateAction<LiveCaptionState>>;
	setActiveTool: Dispatch<SetStateAction<string | null>>;
	setError: Dispatch<SetStateAction<string>>;
}) {
	const [gatePrompt, setGatePrompt] = useState<LiveToolGatePrompt | null>(null);
	const gatePromptRef = useRef(gatePrompt);
	gatePromptRef.current = gatePrompt;
	const gateResolverRef = useRef<((resolution: ToolGateResolution) => void) | null>(null);
	const gateRejectRef = useRef<((reason: Error) => void) | null>(null);

	const handleLiveTurnEvent = useCallback(
		(event: Parameters<typeof applyLiveTurnToolEvent>[0]) => {
			applyLiveTurnToolEvent(event, {
				gateOpen: Boolean(gatePromptRef.current),
				clearInterim: () => {
					args.setCaptions((prev) => clearLiveCaptionInterim(prev));
				},
				clearActiveTool: () => {
					args.setActiveTool(null);
				},
				setError: args.setError,
				setActiveTool: args.setActiveTool,
			});
		},
		[args],
	);

	const waitForGateDecision = useCallback((prompt: LiveToolGatePrompt) => {
		return new Promise<ToolGateResolution>((resolve, reject) => {
			setGatePrompt(prompt);
			gateResolverRef.current = resolve;
			gateRejectRef.current = reject;
		});
	}, []);

	const resolveGateDecision = useCallback((resolution: ToolGateResolution) => {
		gateResolverRef.current?.(resolution);
		gateResolverRef.current = null;
		gateRejectRef.current = null;
		setGatePrompt(null);
	}, []);

	const cancelGateDecision = useCallback((reason = 'Live session ended') => {
		if (gateRejectRef.current) {
			gateRejectRef.current(new Error(reason));
		}
		gateResolverRef.current = null;
		gateRejectRef.current = null;
		setGatePrompt(null);
	}, []);

	return {
		gatePrompt,
		gatePromptRef,
		handleLiveTurnEvent,
		waitForGateDecision,
		resolveGateDecision,
		cancelGateDecision,
	};
}
