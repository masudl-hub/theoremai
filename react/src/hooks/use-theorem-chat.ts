import { useCallback, useEffect, useRef } from 'react';
import {
	branchInterfaceTurnSession,
	type ComposerPendingMessage,
	type ComposerProfileInterface,
	type ComposerRunPhase,
	consumeNextComposerQueue,
	convertSteersToFrontQueued,
	defaultInterfaceEffort,
	orderComposerPendingMessages,
	promoteComposerPendingKind,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';
import type { TurnFailure } from '../client/failure';
import { followGenerationDefaults } from '../client/generation-selection';
import { applyTurnResultToTranscript } from '../client/index';
import type { TheoremTransport } from '../client/transport';
import { type RunTurnStream, useTheoremChatActions } from './use-theorem-chat-actions';
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

/**
 * Seed the session with the profile's default model / effort once the interface loads, and keep
 * it valid as the interface changes: a pick still on the old defaults follows the new ones, and a
 * pick the profile no longer has falls back to them (see `followGenerationDefaults`).
 */
function useDefaultGeneration(
	iface: ComposerProfileInterface | null,
	session: InterfaceTurnSession,
	setSession: SetSession,
): void {
	const previous = useRef<ComposerProfileInterface | undefined>(undefined);
	useEffect(() => {
		if (!iface) return;
		const next = followGenerationDefaults(
			iface,
			{ model: session.selectedModel, effort: session.selectedEffort },
			previous.current,
		);
		previous.current = iface;
		if (next.model === session.selectedModel && next.effort === session.selectedEffort) return;
		setSession((prev) => ({ ...prev, selectedModel: next.model, selectedEffort: next.effort }));
	}, [session.selectedEffort, session.selectedModel, setSession, iface]);
}

type ChatState = ReturnType<typeof useTheoremChatState>;

/**
 * Runs one turn's stream into the transcript: live partials while it streams,
 * then the committed result (or the error) and the pending queue's next step.
 */
function useRunTurnStream(iface: ComposerProfileInterface | null, state: ChatState): RunTurnStream {
	const onRunEnded = useCallback(
		(nextPending: ComposerPendingMessage[], drain: boolean) => {
			const converted = convertSteersToFrontQueued(nextPending);
			state.setPendingMessages(orderComposerPendingMessages(converted));
			state.allowQueueDrainRef.current = drain;
			return converted;
		},
		[state],
	);

	return useCallback(
		async (
			run: (onStream: (partial: TranscriptBlock[]) => void) => Promise<TurnOk | TurnFailure>,
			options: { userBlocksAlreadyApplied?: boolean } = {},
		) => {
			if (!iface || state.busyRef.current) return;
			state.setFailure(null);
			state.busyRef.current = true;
			state.setBusy(true);
			// A new turn goes live with its user message (onUserBlocks), so the
			// previous reply never renders as streaming in between.
			if (!options.userBlocksAlreadyApplied) state.setStreaming(true);
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
						const { error, errorKind, errorInternal } = result;
						state.setFailure({ error, errorKind, ...(errorInternal ? { errorInternal } : {}) });
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

}

/** Start the next queued message once the run goes idle, when the run that ended allows it. */
function useQueueDrain(
	phase: ComposerRunPhase,
	state: ChatState,
	startTurnFromDraft: (draft: ComposerPendingMessage['draft']) => Promise<void>,
): void {
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
			await startTurnFromDraft(message.draft);
		} finally {
			state.drainLockRef.current = false;
		}
	}, [startTurnFromDraft, state]);

	useEffect(() => {
		if (phase !== 'idle' || !state.allowQueueDrainRef.current) return;
		if (!state.pendingMessages.some((m) => m.kind === 'queue')) {
			state.allowQueueDrainRef.current = false;
			return;
		}
		state.allowQueueDrainRef.current = false;
		void drainQueue();
	}, [drainQueue, phase, state]);

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

	const runTurnStream = useRunTurnStream(iface, state);

	const actions = useTheoremChatActions({ ...state, iface, transport, phase, gated, runTurnStream });

	useQueueDrain(phase, state, actions.startTurnFromDraft);

	const handleBranch = useCallback(
		(index: number) => {
			const kept = [...state.blocks, ...state.streamBlocks].slice(0, index + 1);
			state.setBlocks(kept);
			state.setStreamBlocks([]);
			state.setStreaming(false);
			state.busyRef.current = false;
			state.setBusy(false);
			state.setChatStarted(kept.length > 0);
			state.setSession((prevSession) => branchInterfaceTurnSession(prevSession, kept, iface?.lexicon));
		},
		[iface, state],
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
		failure: state.failure,
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
		handleAuthenticated: actions.handleAuthenticated,
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
