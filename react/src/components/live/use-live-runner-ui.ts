import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { type LexiconOverrides, type SessionEvent, TheoremError } from '../../../../mod.ts';
import { type ClientFailure, clientFailure } from '../../client/failure';
import { applyLiveTurnToolEvent } from '../../client/live/apply-live-turn-tool-event';
import {
	clearLiveCaptionInterim,
	emptyLiveCaptionState,
	type LiveCaptionState,
} from '../../client/live/live-captions';
import type { LiveToolGatePrompt } from '../../client/live/live-tool';
import type { LiveFacingMode, LiveVideoCapture } from '../../client/live/live-video';
import { sessionEndedText } from '../../client/live/session-ended';
import type { LiveConnectPhase, LiveSessionStatus } from '../../client/live-client';
import type { ToolGateResolution } from '../../client/tool-resume';

/** UI + media state bag for the live runner. `lexicon` is the interface's: the profile's wording. */
export function useLiveRunnerUiState(lexicon: LexiconOverrides) {
	const [status, setStatus] = useState<LiveSessionStatus>('disconnected');
	const [connectPhase, setConnectPhase] = useState<LiveConnectPhase | null>(null);
	const [inputLevel, setInputLevel] = useState(0);
	const [outputLevel, setOutputLevel] = useState(0);
	const [isMuted, setIsMuted] = useState(false);
	const [isVideoOn, setIsVideoOn] = useState(false);
	const [activeTool, setActiveTool] = useState<string | null>(null);
	const [captions, setCaptions] = useState<LiveCaptionState>(emptyLiveCaptionState);
	const [failure, setFailure] = useState<ClientFailure | null>(null);
	/** The user's line for a session the provider ended after warning it would. */
	const [sessionEnded, setSessionEnded] = useState<string | null>(null);
	const [textDraft, setTextDraft] = useState('');
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

	const reportFailure = useCallback(
		(err: unknown) => {
			setFailure(clientFailure(err, lexicon));
		},
		[lexicon],
	);

	const clearFailure = useCallback(() => {
		setFailure(null);
	}, []);

	const reportSessionEnded = useCallback(
		(session: SessionEvent) => {
			setSessionEnded(sessionEndedText(session, lexicon));
		},
		[lexicon],
	);

	const clearSessionEnded = useCallback(() => {
		setSessionEnded(null);
	}, []);

	const resetCaptions = useCallback(() => {
		setCaptions(emptyLiveCaptionState());
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
		failure,
		reportFailure,
		clearFailure,
		sessionEnded,
		reportSessionEnded,
		clearSessionEnded,
		textDraft,
		setTextDraft,
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
		resetCaptions,
		stopVideo,
	};
}

/** Gate prompt + live turn-tool event wiring. */
export function useLiveRunnerGate(args: {
	setCaptions: Dispatch<SetStateAction<LiveCaptionState>>;
	setActiveTool: Dispatch<SetStateAction<string | null>>;
	reportFailure: (err: unknown) => void;
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
				reportFailure: args.reportFailure,
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

	const cancelGateDecision = useCallback(() => {
		// lexicon-exempt: internal diagnostic; the user reads error.cancelled
		gateRejectRef.current?.(new TheoremError('cancelled', 'live session ended with a gate open'));
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
