import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineProfile } from 'theorum';
import {
	type ComposerPendingMessage,
	defaultInterfaceEffort,
	defaultInterfaceModel,
	emptyInterfaceTurnSession,
	type InterfaceTurnSession,
	interfaceFromProfile,
	type TranscriptBlock,
} from 'theorum/interface';
import type { PlaygroundRunPayload } from './client/index';

type SetSession = (
	value: InterfaceTurnSession | ((prev: InterfaceTurnSession) => InterfaceTurnSession),
) => void;

export type { SetSession };

/** Composer / transcript / session state for TheorumRunApp. */
export function useTheorumRunAppState() {
	const [payload, setPayload] = useState<PlaygroundRunPayload | null>(null);
	const [ready, setReady] = useState(false);
	const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
	const [streamBlocks, setStreamBlocks] = useState<TranscriptBlock[]>([]);
	const [draftText, setDraftText] = useState('');
	const [pendingFiles, setPendingFiles] = useState<File[]>([]);
	const [pendingVoice, setPendingVoice] = useState<File[]>([]);
	const [pendingMessages, setPendingMessages] = useState<ComposerPendingMessage[]>([]);
	const [issues, setIssues] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [errorInternal, setErrorInternal] = useState('');
	const [busy, setBusy] = useState(false);
	const [chatStarted, setChatStarted] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [session, setSession] = useState<InterfaceTurnSession>(emptyInterfaceTurnSession());

	const streamRafRef = useRef<number | null>(null);
	const pendingStreamRef = useRef<TranscriptBlock[] | null>(null);
	const blocksRef = useRef(blocks);
	blocksRef.current = blocks;
	const busyRef = useRef(false);
	const abortRef = useRef<AbortController | null>(null);
	const turnIdRef = useRef<string | null>(null);
	const pendingRef = useRef(pendingMessages);
	pendingRef.current = pendingMessages;
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const drainLockRef = useRef(false);
	const allowQueueDrainRef = useRef(false);
	const runPromiseRef = useRef<Promise<void> | null>(null);

	const cancelPendingStreamFrame = useCallback(() => {
		if (streamRafRef.current != null) {
			cancelAnimationFrame(streamRafRef.current);
			streamRafRef.current = null;
		}
		pendingStreamRef.current = null;
	}, []);

	const scheduleStreamBlocks = useCallback((partial: TranscriptBlock[]) => {
		pendingStreamRef.current = partial;
		if (streamRafRef.current != null) return;
		streamRafRef.current = requestAnimationFrame(() => {
			streamRafRef.current = null;
			const next = pendingStreamRef.current;
			pendingStreamRef.current = null;
			if (next) setStreamBlocks(next);
		});
	}, []);

	const clearComposer = useCallback(() => {
		setDraftText('');
		setPendingFiles([]);
		setPendingVoice([]);
	}, []);

	return {
		payload,
		setPayload,
		ready,
		setReady,
		blocks,
		setBlocks,
		streamBlocks,
		setStreamBlocks,
		draftText,
		setDraftText,
		pendingFiles,
		setPendingFiles,
		pendingVoice,
		setPendingVoice,
		pendingMessages,
		setPendingMessages,
		issues,
		setIssues,
		error,
		setError,
		errorInternal,
		setErrorInternal,
		busy,
		setBusy,
		chatStarted,
		setChatStarted,
		streaming,
		setStreaming,
		session,
		setSession,
		blocksRef,
		busyRef,
		abortRef,
		turnIdRef,
		pendingRef,
		sessionRef,
		drainLockRef,
		allowQueueDrainRef,
		runPromiseRef,
		cancelPendingStreamFrame,
		scheduleStreamBlocks,
		clearComposer,
	};
}

/** Load payload + derive iface / liveIface / title. */
export function useTheorumRunBootstrap(args: {
	missingPayloadHref: string;
	readRunId: () => string | null;
	loadPayload: (runId: string) => PlaygroundRunPayload | null;
	payload: PlaygroundRunPayload | null;
	setPayload: (p: PlaygroundRunPayload | null) => void;
	setReady: (ready: boolean) => void;
	session: InterfaceTurnSession;
	setSession: SetSession;
}) {
	useEffect(() => {
		const runId = args.readRunId();
		if (!runId) {
			globalThis.location.href = args.missingPayloadHref;
			return;
		}
		const loaded = args.loadPayload(runId);
		if (!loaded) {
			globalThis.location.href = args.missingPayloadHref;
			return;
		}
		args.setPayload(loaded);
		args.setReady(true);
	}, [
		args.loadPayload,
		args.missingPayloadHref,
		args.readRunId,
		args.setPayload,
		args.setReady,
	]);

	const iface = useMemo(() => {
		if (!args.payload || args.payload.profile.type === 'live') return null;
		return interfaceFromProfile(defineProfile(args.payload.profile));
	}, [args.payload]);

	const liveIface = useMemo(() => {
		if (args.payload?.profile.type !== 'live') return null;
		return interfaceFromProfile(defineProfile(args.payload.profile));
	}, [args.payload]);

	const titleHandle = useMemo(() => {
		if (!args.payload) return 'Run';
		return interfaceFromProfile(defineProfile(args.payload.profile)).identity.handle;
	}, [args.payload]);

	useEffect(() => {
		if (!iface) return;
		const model = args.session.selectedModel ?? defaultInterfaceModel(iface);
		if (!model) return;
		const effort = defaultInterfaceEffort(iface, model);
		if (!args.session.selectedModel || (effort && !args.session.selectedEffort)) {
			args.setSession((prev) => ({
				...prev,
				selectedModel: prev.selectedModel ?? model,
				...(effort ? { selectedEffort: prev.selectedEffort ?? effort } : {}),
			}));
		}
	}, [
		args.session.selectedEffort,
		args.session.selectedModel,
		args.setSession,
		iface,
	]);

	useEffect(() => {
		document.title = `${titleHandle} · Theorum Playground`;
	}, [titleHandle]);

	return { iface, liveIface, titleHandle };
}
