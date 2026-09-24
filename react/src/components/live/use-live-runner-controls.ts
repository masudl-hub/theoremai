import { useCallback, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';
import {
	applyLiveTranscript,
	type LiveCaptionState,
} from '../../client/live/live-captions';
import {
	type LiveFacingMode,
	type LiveVideoCapture,
	startLiveVideoCapture,
} from '../../client/live/live-video';
import type { LiveConnectPhase, LiveSessionClient, LiveSessionStatus } from '../../client/live-client';

/** Media + session lifecycle handlers for LiveRunner. */
export function useLiveRunnerControls(args: {
	clientRef: MutableRefObject<LiveSessionClient | null>;
	videoCaptureRef: MutableRefObject<LiveVideoCapture | null>;
	captionsRef: MutableRefObject<LiveCaptionState>;
	registerProfileRef: MutableRefObject<() => Promise<string>>;
	statusRef: MutableRefObject<LiveSessionStatus>;
	isMutedRef: MutableRefObject<boolean>;
	sessionPermissionsRef: MutableRefObject<string[]>;
	ensureClient: (profileId: string) => LiveSessionClient;
	clearClient: () => void;
	cancelGateDecision: (reason?: string) => void;
	stopVideo: () => void;
	resetCaptions: () => void;
	sessionActive: boolean;
	textAvailable: boolean;
	videoAvailable: boolean;
	voiceAvailable: boolean;
	isVideoOn: boolean;
	textDraft: string;
	setTextDraft: Dispatch<SetStateAction<string>>;
	setCaptions: Dispatch<SetStateAction<LiveCaptionState>>;
	reportFailure: (err: unknown) => void;
	clearFailure: () => void;
	setIsMuted: Dispatch<SetStateAction<boolean>>;
	setSessionActive: Dispatch<SetStateAction<boolean>>;
	setSessionPermissions: Dispatch<SetStateAction<string[]>>;
	setStatus: Dispatch<SetStateAction<LiveSessionStatus>>;
	setConnectPhase: Dispatch<SetStateAction<LiveConnectPhase | null>>;
	setInputLevel: Dispatch<SetStateAction<number>>;
	setOutputLevel: Dispatch<SetStateAction<number>>;
	setVideoPreview: Dispatch<SetStateAction<HTMLVideoElement | null>>;
	setVideoFacingMode: Dispatch<SetStateAction<LiveFacingMode>>;
	setIsVideoOn: Dispatch<SetStateAction<boolean>>;
}) {
	const teardownSession = useCallback(() => {
		args.cancelGateDecision();
		args.clearClient();
		args.stopVideo();
		args.setIsMuted(false);
		args.isMutedRef.current = false;
		args.setSessionActive(false);
		args.setSessionPermissions([]);
		args.sessionPermissionsRef.current = [];
		args.statusRef.current = 'disconnected';
		args.setStatus('disconnected');
		args.setConnectPhase(null);
		args.setInputLevel(0);
		args.setOutputLevel(0);
	}, [args]);

	const startSession = useCallback(async () => {
		args.clearFailure();
		args.resetCaptions();
		try {
			const profileId = await args.registerProfileRef.current();
			const liveClient = args.ensureClient(profileId);
			if (args.statusRef.current === 'disconnected' || args.statusRef.current === 'error') {
				await liveClient.connect();
			}
		} catch (err) {
			args.reportFailure(err);
		}
	}, [args]);

	const handleSendText = useCallback(() => {
		const text = args.textDraft.trim();
		if (!text || !args.clientRef.current || !args.sessionActive || !args.textAvailable) return;
		args.clientRef.current.sendText(text);
		args.setTextDraft('');
		const next = applyLiveTranscript(args.captionsRef.current, text, true, false, {
			forceNew: true,
		});
		args.captionsRef.current = next;
		args.setCaptions(next);
	}, [args]);

	const handleToggleVideo = useCallback(async () => {
		if (!args.clientRef.current || !args.sessionActive || !args.videoAvailable) return;
		if (args.isVideoOn) {
			args.stopVideo();
			return;
		}
		try {
			const capture = await startLiveVideoCapture((base64) => {
				args.clientRef.current?.sendVideo(base64);
			});
			args.videoCaptureRef.current = capture;
			args.setVideoPreview(capture.video);
			args.setVideoFacingMode(capture.facingMode());
			args.setIsVideoOn(true);
		} catch (err) {
			args.reportFailure(err);
			args.stopVideo();
		}
	}, [args]);

	const handleFlipCamera = useCallback(async () => {
		const capture = args.videoCaptureRef.current;
		if (!capture || !args.sessionActive || !args.isVideoOn) return;
		try {
			const facing = await capture.flip();
			args.setVideoFacingMode(facing);
			args.setVideoPreview(capture.video);
		} catch (err) {
			args.reportFailure(err);
		}
	}, [args]);

	const handleToggleMic = useCallback(() => {
		if (!args.clientRef.current || !args.sessionActive || !args.voiceAvailable) return;
		const muted = args.clientRef.current.toggleMute();
		args.isMutedRef.current = muted;
		args.setIsMuted(muted);
	}, [args]);

	const handleRestart = useCallback(async () => {
		teardownSession();
		await startSession();
	}, [startSession, teardownSession]);

	return {
		teardownSession,
		startSession,
		handleSendText,
		handleToggleVideo,
		handleFlipCamera,
		handleToggleMic,
		handleRestart,
	};
}
