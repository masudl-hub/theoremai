import { useCallback, type MutableRefObject } from 'react';
import { TheoremError } from '../../../mod.ts';
import type {
	AttachmentValidationIssue,
	ComposerMenuAction,
	ComposerPendingMessage,
	ComposerProfileInterface,
	ComposerRunPhase,
	InterfaceTurnSession,
	TranscriptBlock,
	UserTurnDraft,
} from '../../../src/interface/mod.ts';
import {
	convertSteersToFrontQueued,
	createComposerPendingMessage,
	orderComposerPendingMessages,
	removeComposerPendingMessage,
	userDraftHasPayload,
	userDraftToSteerInject,
} from '../../../src/interface/mod.ts';
import {
	composerFieldsFromDraft,
	encodeComposerDraft,
	resumeInterfaceTool,
	streamInterfaceDraftTurn,
	streamInterfaceTurn,
	type ToolDecisionAction,
	type ToolGateResolution,
} from '../client/index';
import { type ClientFailure, clientFailure, type TurnFailure } from '../client/failure';
import type { TheoremTransport } from '../client/transport';
import type { MessageDelivery } from './use-theorem-chat-state';

function composerFieldsPayload(
	text: string,
	pendingFiles: readonly File[],
	pendingVoice: readonly File[],
) {
	const meta = (files: readonly File[]) =>
		files.map((f) => ({
			name: f.name,
			mimeType: f.type || 'application/octet-stream',
			sizeBytes: f.size,
		}));
	return {
		...(text.trim() ? { text } : {}),
		...(pendingFiles.length ? { attachments: meta(pendingFiles) } : {}),
		...(pendingVoice.length ? { voice: meta(pendingVoice) } : {}),
	};
}

function newTurnId(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `turn-${Date.now()}`;
}

export type RunTurnStream = (
	run: (
		onStream: (blocks: TranscriptBlock[]) => void,
		/** The work so far of the reply the session waits on (none when it waits on nothing). */
		paused: { workedMs: number },
	) => Promise<
		| {
				ok: true;
				session: InterfaceTurnSession;
				userBlocks?: TranscriptBlock[];
				assistantBlocks: TranscriptBlock[];
		  }
		| TurnFailure
	>,
	options?: {
		userBlocksAlreadyApplied?: boolean;
		/** The run's message walks away from the gates the reply waits on, ending that reply. */
		walksAway?: boolean;
	},
) => Promise<void>;

function beginAbortableTurn(args: {
	iface: ComposerProfileInterface | null;
	abortRef: MutableRefObject<AbortController | null>;
	turnIdRef: MutableRefObject<string | null>;
}): {
	composer: ComposerProfileInterface;
	turnId: string;
	signal: AbortSignal;
} | null {
	if (!args.iface) return null;
	const controller = new AbortController();
	args.abortRef.current = controller;
	const turnId = newTurnId();
	args.turnIdRef.current = turnId;
	return {
		composer: args.iface,
		turnId,
		signal: controller.signal,
	};
}

export type TheoremChatActionArgs = {
	iface: ComposerProfileInterface | null;
	transport: TheoremTransport;
	phase: ComposerRunPhase;
	gated: boolean;
	draftText: string;
	pendingFiles: File[];
	pendingVoice: File[];
	clearComposer: () => void;
	runTurnStream: RunTurnStream;
	sessionRef: MutableRefObject<InterfaceTurnSession>;
	blocksRef: MutableRefObject<TranscriptBlock[]>;
	abortRef: MutableRefObject<AbortController | null>;
	turnIdRef: MutableRefObject<string | null>;
	busyRef: MutableRefObject<boolean>;
	runPromiseRef: MutableRefObject<Promise<void> | null>;
	allowQueueDrainRef: MutableRefObject<boolean>;
	setBlocks: (value: TranscriptBlock[] | ((prev: TranscriptBlock[]) => TranscriptBlock[])) => void;
	setStreamBlocks: (value: TranscriptBlock[]) => void;
	setSession: (value: InterfaceTurnSession) => void;
	setChatStarted: (value: boolean) => void;
	setStreaming: (value: boolean) => void;
	setPendingMessages: (
		value:
			| ComposerPendingMessage[]
			| ((prev: ComposerPendingMessage[]) => ComposerPendingMessage[]),
	) => void;
	setDraftText: (value: string) => void;
	setPendingFiles: (value: File[]) => void;
	setPendingVoice: (value: File[]) => void;
	setIssues: (value: AttachmentValidationIssue[]) => void;
	setFailure: (value: ClientFailure | null) => void;
	setDelivery: (value: { status: MessageDelivery } | null) => void;
	pendingRef: MutableRefObject<ComposerPendingMessage[]>;
};

/** Starts a turn from the composer's fields, or from an encoded draft (queued or send-now). */
function useTurnStarters(args: TheoremChatActionArgs) {
	const startTurnFromFields = useCallback(
		async (fields: { text: string; files: File[]; voice: File[] }) => {
			const started = beginAbortableTurn(args);
			if (!started) return;

			await args.runTurnStream(
				(onStream) =>
					streamInterfaceTurn({
						iface: started.composer,
						transport: args.transport,
						session: args.sessionRef.current,
						text: fields.text,
						pendingFiles: fields.files,
						pendingVoice: fields.voice,
						signal: started.signal,
						turnId: started.turnId,
						onStream,
						onUserBlocks: (userBlocks) => {
							args.setBlocks((prev) => [...prev, ...userBlocks]);
							args.setDelivery({ status: 'sending' });
							args.setChatStarted(true);
							args.setStreaming(true);
							args.clearComposer();
						},
					}),
				{ userBlocksAlreadyApplied: true },
			);
		},
		[args],
	);

	const startTurnFromDraft = useCallback(
		async (
			draft: ComposerPendingMessage['draft'],
			options: {
				/** Send while the reply waits on gates: the message walks away from them. */
				walkAway?: boolean;
				/** Once the message posts: it leaves wherever it was waiting to be sent. */
				onPosted?: () => void;
			} = {},
		) => {
			const started = beginAbortableTurn(args);
			if (!started) return;

			await args.runTurnStream(
				(onStream, paused) =>
					streamInterfaceDraftTurn({
						iface: started.composer,
						transport: args.transport,
						session: args.sessionRef.current,
						draft,
						signal: started.signal,
						turnId: started.turnId,
						onStream,
						...(options.walkAway ? { walkAway: paused } : {}),
						onUserBlocks: (posted) => {
							args.setBlocks((prev) => [...prev, ...posted]);
							// A walked-away reply's blocks were streaming; they are posted now.
							args.setStreamBlocks([]);
							args.setDelivery({ status: 'sending' });
							args.setChatStarted(true);
							args.setStreaming(true);
							options.onPosted?.();
						},
					}),
				{ userBlocksAlreadyApplied: true, walksAway: options.walkAway === true },
			);
		},
		[args],
	);

	return { startTurnFromFields, startTurnFromDraft };
}

/** A steer with no running turn: the user reads `session.turn_ended`; queued steers move to the front. */
function steerAfterTurnEnded(args: TheoremChatActionArgs, messageId: string): void {
	args.setFailure(
		clientFailure(
			// lexicon-exempt: internal diagnostic; the user reads session.turn_ended
			new TheoremError('request', 'steer: no active turn', { copy: { key: 'session.turn_ended' } }),
			args.iface?.lexicon,
		),
	);
	args.setPendingMessages((prev) =>
		orderComposerPendingMessages(convertSteersToFrontQueued(removeComposerPendingMessage(prev, messageId))),
	);
}

/** Queue / steer / stash the composer draft, and restore a pending message into the composer. */
function usePendingActions(args: TheoremChatActionArgs) {
	const enqueuePending = useCallback(
		async (kind: 'queue' | 'steer' | 'stash') => {
			if (
				!userDraftHasPayload(
					composerFieldsPayload(args.draftText, args.pendingFiles, args.pendingVoice),
				)
			) {
				return;
			}
			args.setIssues([]);
			try {
				const draft = await encodeComposerDraft({
					text: args.draftText,
					pendingFiles: args.pendingFiles,
					pendingVoice: args.pendingVoice,
				});
				const message = createComposerPendingMessage({ kind, draft });
				args.setPendingMessages((prev) => orderComposerPendingMessages([...prev, message]));
				args.clearComposer();

				if (kind !== 'steer') return;
				const turnId = args.turnIdRef.current;
				if (!turnId) {
					steerAfterTurnEnded(args, message.id);
					return;
				}
				const inject = userDraftToSteerInject(draft);
				if (inject.length === 0) return;
				await args.transport.steer({ turnId, id: message.id, inject });
			} catch (err) {
				args.setFailure(clientFailure(err, args.iface?.lexicon));
			}
		},
		[args],
	);

	const handlePendingRestore = useCallback(
		async (id: string) => {
			const message = args.pendingRef.current.find((m) => m.id === id);
			if (!message) return;
			const currentDraft = composerFieldsPayload(
				args.draftText,
				args.pendingFiles,
				args.pendingVoice,
			);
			try {
				let nextPending = removeComposerPendingMessage(args.pendingRef.current, id);
				if (userDraftHasPayload(currentDraft)) {
					const stashDraft = await encodeComposerDraft({
						text: args.draftText,
						pendingFiles: args.pendingFiles,
						pendingVoice: args.pendingVoice,
					});
					const stash = createComposerPendingMessage({ kind: 'stash', draft: stashDraft });
					nextPending = orderComposerPendingMessages([...nextPending, stash]);
				}
				const restored = composerFieldsFromDraft(message.draft);
				args.setPendingMessages(nextPending);
				args.setDraftText(restored.text);
				args.setPendingFiles(restored.files);
				args.setPendingVoice(restored.voice);
				args.setIssues([]);
			} catch (err) {
				args.setFailure(clientFailure(err, args.iface?.lexicon));
			}
		},
		[args],
	);

	return { enqueuePending, handlePendingRestore };
}

/** Answer the gate the session waits on: a decision, or a sign-in. */
function useGateActions(args: TheoremChatActionArgs) {
	const resumeGatedTool = useCallback(
		async (resolution: ToolGateResolution) => {
			const composer = args.iface;
			if (!composer) return;
			await args.runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					transport: args.transport,
					session: args.sessionRef.current,
					resolution,
					onStream,
				}),
			);
		},
		[args],
	);

	const handleToolDecision = useCallback(
		async (_index: number, action: ToolDecisionAction) => {
			await resumeGatedTool({ action });
		},
		[resumeGatedTool],
	);

	const handleAuthenticated = useCallback(
		async (_index: number, secret?: string) => {
			await resumeGatedTool({ action: 'auth', ...(secret === undefined ? {} : { secret }) });
		},
		[resumeGatedTool],
	);

	return { handleToolDecision, handleAuthenticated };
}

export function useTheoremChatActions(args: TheoremChatActionArgs) {
	const { startTurnFromFields, startTurnFromDraft } = useTurnStarters(args);
	const { enqueuePending, handlePendingRestore } = usePendingActions(args);
	const { handleToolDecision, handleAuthenticated } = useGateActions(args);

	const handleStop = useCallback(() => {
		args.abortRef.current?.abort();
	}, [args]);

	const handleSubmit = useCallback(async () => {
		if (args.phase === 'streaming' || args.phase === 'gated') {
			await enqueuePending('queue');
			return;
		}
		if (args.gated) return;
		args.setIssues([]);
		await startTurnFromFields({
			text: args.draftText,
			files: [...args.pendingFiles],
			voice: [...args.pendingVoice],
		});
	}, [args, enqueuePending, startTurnFromFields]);

	/** The queued message's draft, or the composer's when it holds something to send. */
	const draftToSend = useCallback(
		async (draftSource?: ComposerPendingMessage): Promise<UserTurnDraft | undefined> => {
			if (draftSource) return draftSource.draft;
			const draft = await encodeComposerDraft({
				text: args.draftText,
				pendingFiles: args.pendingFiles,
				pendingVoice: args.pendingVoice,
			});
			return userDraftHasPayload(draft) ? draft : undefined;
		},
		[args],
	);

	/** The sent message leaves the queue, or the composer it came from. */
	const releaseDraft = useCallback(
		(draftSource?: ComposerPendingMessage) => {
			if (!draftSource) {
				args.clearComposer();
				return;
			}
			const pendingId = draftSource.id;
			args.setPendingMessages((prev) => removeComposerPendingMessage(prev, pendingId));
		},
		[args],
	);

	const handleSendNow = useCallback(
		async (draftSource?: ComposerPendingMessage) => {
			if (!args.iface) return;

			const draft = await draftToSend(draftSource);
			if (!draft) return;

			if (args.busyRef.current) {
				args.abortRef.current?.abort();
				await args.runPromiseRef.current;
			}

			args.setPendingMessages((prev) => convertSteersToFrontQueued(prev));
			args.allowQueueDrainRef.current = false;
			// Sent while the reply waits on gates, the message walks away from them in its own request.
			await startTurnFromDraft(draft, {
				walkAway: args.sessionRef.current.gatedTool !== null,
				// The message leaves the composer (or the queue) once it posts.
				onPosted: () => releaseDraft(draftSource),
			});
		},
		[args, draftToSend, releaseDraft, startTurnFromDraft],
	);

	const handleMenuAction = useCallback(
		(action: ComposerMenuAction) => {
			if (action === 'queue' || action === 'steer' || action === 'stash') {
				void enqueuePending(action);
				return;
			}
			if (action === 'send_now') void handleSendNow();
		},
		[enqueuePending, handleSendNow],
	);

	return {
		startTurnFromDraft,
		handleStop,
		handleSubmit,
		handleSendNow,
		handleMenuAction,
		handleToolDecision,
		handleAuthenticated,
		handlePendingRestore,
		enqueuePending,
	};
}
