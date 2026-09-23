import { useCallback, useEffect } from 'react';
import {
	branchInterfaceTurnSession,
	type ComposerPendingMessage,
	type ComposerProfileInterface,
	type ComposerRunPhase,
	consumeNextComposerQueue,
	convertSteersToFrontQueued,
	defaultInterfaceEffort,
	defaultInterfaceModel,
	orderComposerPendingMessages,
	promoteComposerPendingKind,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';
import { applyTurnResultToTranscript } from '../client/index';
import type { TheoremTransport } from '../client/transport';
import { useTheoremChatActions } from './use-theorem-chat-actions';
import { type SetSession, useTheoremChatState } from './use-theorem-chat-state';

export type UseTheoremChatOptions = {
	transport: TheoremTransport;
	/** Composer interface for the host profile — see `useTheoremInterface`. `null` while loading. */
	iface: ComposerProfileInterface | null;
};

type TurnOk = {
	ok: true;
	session: InterfaceTurnSession;
	userBlocks?: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
};

type TurnFail = {
	ok: false;
	error: string;
	errorInternal?: string;
	issues?: string[];
	aborted?: boolean;
};

/** Seed the session with the profile's default model / effort once the interface loads. */
function useDefaultGeneration(
	iface: ComposerProfileInterface | null,
	session: InterfaceTurnSession,
	setSession: SetSession,
): void {
	useEffect(() => {
		if (!iface) return;
		const model = session.selectedModel ?? defaultInterfaceModel(iface);
		if (!model) return;
		const effort = defaultInterfaceEffort(iface, model);
		if (!session.selectedModel || (effort && !session.selectedEffort)) {
			setSession((prev) => ({
				...prev,
				selectedModel: prev.selectedModel ?? model,
				...(effort ? { selectedEffort: prev.selectedEffort ?? effort } : {}),
			}));
		}
	}, [session.selectedEffort, session.selectedModel, setSession, iface]);
}

/**
 * Headless chat model: transcript, streaming, composer drafts, pending
 * queue / steer / stash, tool gates. Render it with `@theoremai/react/ui` or
 * your own components.
 */
export function useTheoremChat({ transport, iface }: UseTheoremChatOptions) {
	const state = useTheoremChatState();
	useDefaultGeneration(iface, state.session, state.setSession);

	const gated = state.session.gatedTool !== null;
	const phase: ComposerRunPhase = state.busy ? 'streaming' : gated ? 'gated' : 'idle';

	const handleGenerationChange = useCallback(
		(next: { modelId: string; effort?: string }) => {
			const effort =
				next.effort ?? (iface ? defaultInterfaceEffort(iface, next.modelId) : undefined);
			state.setSession((prev) => ({
				...prev,
				selectedModel: next.modelId,
				...(effort ? { selectedEffort: effort } : { selectedEffort: undefined }),
			}));
		},
		[iface, state],
	);

	const onRunEnded = useCallback(
		(nextPending: ComposerPendingMessage[], drain: boolean) => {
			const converted = convertSteersToFrontQueued(nextPending);
			state.setPendingMessages(orderComposerPendingMessages(converted));
			state.allowQueueDrainRef.current = drain;
			return converted;
		},
		[state],
	);

	const runTurnStream = useCallback(
		async (
			run: (onStream: (partial: TranscriptBlock[]) => void) => Promise<TurnOk | TurnFail>,
			options: { userBlocksAlreadyApplied?: boolean } = {},
		) => {
			if (!iface || state.busyRef.current) return;
			state.setError('');
			state.setErrorInternal('');
			state.busyRef.current = true;
			state.setBusy(true);
			state.setStreaming(true);
			state.allowQueueDrainRef.current = false;

			const work = (async () => {
				let latestStream: TranscriptBlock[] = [];
				const result = await run((partial) => {
					latestStream = partial;
					state.scheduleStreamBlocks(partial);
				});

				state.cancelPendingStreamFrame();
				state.busyRef.current = false;
				state.setBusy(false);
				state.setStreaming(false);
				state.abortRef.current = null;
				state.turnIdRef.current = null;

				if (!result.ok) {
					if (!result.aborted) {
						state.setError(result.error);
						state.setErrorInternal(result.errorInternal ?? '');
						if (result.issues) state.setIssues(result.issues);
					}
					state.setStreamBlocks([]);
					onRunEnded(state.pendingRef.current, false);
					return;
				}

				const merged = applyTurnResultToTranscript({
					blocks: state.blocksRef.current,
					streamBlocks: latestStream,
					session: result.session,
					userBlocks: options.userBlocksAlreadyApplied ? undefined : result.userBlocks,
					assistantBlocks: result.assistantBlocks,
				});
				state.setBlocks(merged.blocks);
				state.setStreamBlocks(merged.streamBlocks);
				state.setSession(merged.session);

				if (merged.session.gatedTool !== null) return;
				onRunEnded(state.pendingRef.current, true);
			})();

			state.runPromiseRef.current = work;
			try {
				await work;
			} finally {
				if (state.runPromiseRef.current === work) state.runPromiseRef.current = null;
			}
		},
		[iface, onRunEnded, state],
	);

	const actions = useTheoremChatActions({
		iface,
		transport,
		phase,
		gated,
		draftText: state.draftText,
		pendingFiles: state.pendingFiles,
		pendingVoice: state.pendingVoice,
		clearComposer: state.clearComposer,
		runTurnStream,
		sessionRef: state.sessionRef,
		blocksRef: state.blocksRef,
		abortRef: state.abortRef,
		turnIdRef: state.turnIdRef,
		busyRef: state.busyRef,
		runPromiseRef: state.runPromiseRef,
		allowQueueDrainRef: state.allowQueueDrainRef,
		setBlocks: state.setBlocks,
		setStreamBlocks: state.setStreamBlocks,
		setSession: state.setSession,
		setChatStarted: state.setChatStarted,
		setPendingMessages: state.setPendingMessages,
		setDraftText: state.setDraftText,
		setPendingFiles: state.setPendingFiles,
		setPendingVoice: state.setPendingVoice,
		setIssues: state.setIssues,
		setError: state.setError,
		setErrorInternal: state.setErrorInternal,
		pendingRef: state.pendingRef,
	});

	const drainQueue = useCallback(async () => {
		if (
			state.drainLockRef.current ||
			state.busyRef.current ||
			state.sessionRef.current.gatedTool
		) {
			return;
		}
		const { message, remaining } = consumeNextComposerQueue(state.pendingRef.current);
		if (!message) return;
		state.drainLockRef.current = true;
		state.setPendingMessages(remaining);
		try {
			await actions.startTurnFromDraft(message.draft);
		} finally {
			state.drainLockRef.current = false;
		}
	}, [actions, state]);

	useEffect(() => {
		if (phase !== 'idle' || !state.allowQueueDrainRef.current) return;
		if (!state.pendingMessages.some((m) => m.kind === 'queue')) {
			state.allowQueueDrainRef.current = false;
			return;
		}
		state.allowQueueDrainRef.current = false;
		void drainQueue();
	}, [drainQueue, phase, state]);

	const handleBranch = useCallback(
		(index: number) => {
			const kept = [...state.blocks, ...state.streamBlocks].slice(0, index + 1);
			state.setBlocks(kept);
			state.setStreamBlocks([]);
			state.setStreaming(false);
			state.busyRef.current = false;
			state.setBusy(false);
			state.setChatStarted(kept.length > 0);
			state.setSession((prevSession) => branchInterfaceTurnSession(prevSession, kept));
		},
		[state],
	);

	const handlePendingQueue = useCallback(
		(id: string) => {
			const message = state.pendingRef.current.find((m) => m.id === id);
			if (!message || message.kind !== 'stash') return;
			if (phase === 'idle') {
				state.allowQueueDrainRef.current = true;
			}
			state.setPendingMessages((prev) => promoteComposerPendingKind(prev, id, 'queue'));
		},
		[phase, state],
	);

	return {
		iface,
		blocks: state.blocks,
		chatStarted: state.chatStarted,
		draftText: state.draftText,
		error: state.error,
		errorInternal: state.errorInternal,
		issues: state.issues,
		pendingFiles: state.pendingFiles,
		pendingMessages: state.pendingMessages,
		pendingVoice: state.pendingVoice,
		phase,
		session: state.session,
		streamBlocks: state.streamBlocks,
		streaming: state.streaming,
		setDraftText: state.setDraftText,
		setPendingFiles: state.setPendingFiles,
		setPendingVoice: state.setPendingVoice,
		setPendingMessages: state.setPendingMessages,
		setIssues: state.setIssues,
		handleAuthCredential: actions.handleAuthCredential,
		handleBranch,
		handleSubmit: actions.handleSubmit,
		handleStop: actions.handleStop,
		handleMenuAction: actions.handleMenuAction,
		handlePendingQueue,
		handlePendingRestore: actions.handlePendingRestore,
		handleSendNow: actions.handleSendNow,
		handleToolDecision: actions.handleToolDecision,
		handleGenerationChange,
	};
}
