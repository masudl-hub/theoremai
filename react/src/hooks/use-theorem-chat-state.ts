import { useCallback, useRef, useState } from 'react';
import {
	type ComposerPendingMessage,
	emptyInterfaceTurnSession,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';

type SetSession = (
	value: InterfaceTurnSession | ((prev: InterfaceTurnSession) => InterfaceTurnSession),
) => void;

export type { SetSession };

/** Composer / transcript / session state behind {@link useTheoremChat}. */
export function useTheoremChatState() {
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
