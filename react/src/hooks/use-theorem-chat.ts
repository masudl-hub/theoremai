import { useCallback, useEffect, useMemo, useRef } from 'react';
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
	removeLandedSteers,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';
import type { TurnFailure } from '../client/failure';
import { followGenerationDefaults } from '../client/generation-selection';
import { applyTurnResultToTranscript } from '../client/index';
import type { TheoremTransport, TurnEventSink } from '../client/transport';
import { type RunTurnStream, useTheoremChatActions } from './use-theorem-chat-actions';
import { type MessageDelivery, type SetSession, useTheoremChatState } from './use-theorem-chat-state';

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

/** The streamed blocks, ending on the turn's error unless the stream already carried it. */
function withTurnError(blocks: TranscriptBlock[], error: string): TranscriptBlock[] {
	if (blocks.some((block) => block.kind === 'error')) return blocks;
	return [...blocks, { id: crypto.randomUUID(), kind: 'error', message: error }];
}

/**
 * Shows a failed turn's error. Once the message is in the transcript, the
 * failure is too, closing the turn (the message, or the reply as far as it
 * got, shows it failed); a message that never went out (refused attachments)
 * is still in the composer, so the failure shows there.
 */
function showTurnFailure(
	state: ChatState,
	result: TurnFailure,
	streamed: TranscriptBlock[],
	unposted: boolean,
): void {
	const { error, errorKind, errorInternal } = result;
	if (unposted) {
		state.setFailure({ error, errorKind, ...(errorInternal ? { errorInternal } : {}) });
	} else {
		const failed = withTurnError(streamed, error);
		state.setBlocks((prev) => [...prev, ...failed]);
		state.setDelivery(null);
	}
	if (result.issues) state.setIssues(result.issues);
}

/**
 * Runs one turn's stream into the transcript: live partials while it streams,
 * then the committed result (or the error) and the pending queue's next step.
 */
function useRunTurnStream(iface: ComposerProfileInterface | null, state: ChatState): RunTurnStream {
	// The current reply's work across its runs: a gate splits a reply into runs, and the wait between doesn't count.
	const replyWorkedMs = useRef(0);
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
			// A new message posts itself (onUserBlocks) with a fresh delivery.
			const priorDelivery = state.deliveryRef.current;
			state.busyRef.current = true;
			state.setBusy(true);
			// A new turn goes live with its user message (onUserBlocks), so the
			// previous reply never renders as streaming in between.
			if (!options.userBlocksAlreadyApplied) state.setStreaming(true);
			state.allowQueueDrainRef.current = false;
			// A run that starts on a gate (a decision, sign-in, walking away) continues its reply; any other starts one.
			if (!state.sessionRef.current.gatedTool) replyWorkedMs.current = 0;
			const runStartedAt = Date.now();

			const work = (async () => {
				let latestStream: TranscriptBlock[] = [];
				const result = await run((partial) => {
					latestStream = partial;
					state.scheduleStreamBlocks(partial);
				});

				const endedAt = Date.now();
				replyWorkedMs.current += endedAt - runStartedAt;
				state.cancelPendingStreamFrame();
				state.busyRef.current = false;
				state.setBusy(false);
				state.setStreaming(false);
				state.abortRef.current = null;
				state.turnIdRef.current = null;

				if (!result.ok) {
					if (result.session) state.setSession(result.session);
					const unposted =
						options.userBlocksAlreadyApplied === true && state.deliveryRef.current === priorDelivery;
					if (!result.aborted) showTurnFailure(state, result, latestStream, unposted);
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
					worked: { workedMs: replyWorkedMs.current, endedAt },
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

const DELIVERY_ORDER: readonly MessageDelivery[] = ['sending', 'sent', 'delivered', 'read'];

/** The server's own reports (bookkeeping, a failure, the end), which say nothing of the model having the message. */
const SERVER_EVENTS = new Set(['stage', 'guardrail', 'session', 'error', 'done']);
/** The reply itself (its thinking and tool calls come before it). */
const REPLY_EVENTS = new Set(['text', 'structured', 'media']);

/**
 * How far an event shows the message got: any event means the server took it,
 * one from the model (thinking, a tool call) means the model has it, and the
 * reply means it was read.
 */
function deliveryOf(event: Parameters<TurnEventSink>[0]): MessageDelivery {
	if (REPLY_EVENTS.has(event.type)) return 'read';
	return SERVER_EVENTS.has(event.type) ? 'sent' : 'delivered';
}

/**
 * The transport, with each turn's events also clearing the steers they report
 * as landed (so the run's end requeues only the steers the agent never saw),
 * and moving the posted message's delivery forward.
 */
function useTappedTransport(transport: TheoremTransport, state: ChatState): TheoremTransport {
	return useMemo(() => {
		const tap =
			(onEvent: TurnEventSink): TurnEventSink =>
			(event) => {
				if (event.type === 'stage' && event.injected?.length) {
					state.pendingRef.current = removeLandedSteers(state.pendingRef.current, event);
					state.setPendingMessages((prev) => removeLandedSteers(prev, event));
				}
				const delivery = state.deliveryRef.current;
				const reached = deliveryOf(event);
				if (delivery && DELIVERY_ORDER.indexOf(reached) > DELIVERY_ORDER.indexOf(delivery.status)) {
					state.setDelivery({ status: reached });
				}
				onEvent(event);
			};
		return {
			...transport,
			turn: (request, onEvent, signal) => transport.turn(request, tap(onEvent), signal),
			invoke: (request, onEvent, signal) => transport.invoke(request, tap(onEvent), signal),
		};
	}, [transport, state.pendingRef, state.setPendingMessages, state.deliveryRef, state.setDelivery]);
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

	const steerTransport = useTappedTransport(transport, state);
	const actions = useTheoremChatActions({
		...state,
		iface,
		transport: steerTransport,
		phase,
		gated,
		runTurnStream,
	});

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
			// The kept transcript's last message isn't the one whose delivery was tracked.
			state.setDelivery(null);
			state.setSession((prevSession) => branchInterfaceTurnSession(prevSession, kept));
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
		/** The latest message's delivery; `null` before the first and once its turn failed. */
		delivery: state.delivery?.status ?? null,
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
