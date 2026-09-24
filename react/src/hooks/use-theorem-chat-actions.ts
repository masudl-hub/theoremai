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
} from '../../../src/interface/mod.ts';
import {
	convertSteersToFrontQueued,
	createComposerPendingMessage,
	orderComposerPendingMessages,
	removeComposerPendingMessage,
	userDraftHasPayload,
	userDraftToSteerInject,
} from '../../../src/interface/mod.ts';
import type { ToolCredential } from '../../../src/kernel/mod.ts';
import {
	abandonGatedInterfaceTool,
	applyTurnResultToTranscript,
	composerFieldsFromDraft,
	encodeComposerDraft,
	resumeInterfaceTool,
	streamInterfaceDraftTurn,
	streamInterfaceTurn,
	type ToolDecisionAction,
} from '../client/index';
import { type ClientFailure, clientFailure, type TurnFailure } from '../client/failure';
import type { TheoremTransport } from '../client/transport';

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
	run: (onStream: (blocks: TranscriptBlock[]) => void) => Promise<
		| {
				ok: true;
				session: InterfaceTurnSession;
				userBlocks?: TranscriptBlock[];
				assistantBlocks: TranscriptBlock[];
		  }
		| TurnFailure
	>,
	options?: { userBlocksAlreadyApplied?: boolean },
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
		async (draft: ComposerPendingMessage['draft']) => {
			const started = beginAbortableTurn(args);
			if (!started) return;

			await args.runTurnStream(
				(onStream) =>
					streamInterfaceDraftTurn({
						iface: started.composer,
						transport: args.transport,
						session: args.sessionRef.current,
						draft,
						signal: started.signal,
						turnId: started.turnId,
						onStream,
						onUserBlocks: (userBlocks) => {
							args.setBlocks((prev) => [...prev, ...userBlocks]);
							args.setChatStarted(true);
							args.setStreaming(true);
						},
					}),
				{ userBlocksAlreadyApplied: true },
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
				await args.transport.steer({ turnId, inject });
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

/** Resume a gated tool with an approval decision or a credential. */
function useGateActions(args: TheoremChatActionArgs) {
	const resumeGatedTool = useCallback(
		async (
			action: ToolDecisionAction,
			extra?: { interactiveValue?: unknown; credentials?: Record<string, ToolCredential> },
		) => {
			const composer = args.iface;
			if (!composer) return;
			await args.runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					transport: args.transport,
					session: args.sessionRef.current,
					action,
					interactiveValue: extra?.interactiveValue,
					credentials: extra?.credentials,
					onStream,
				}),
			);
		},
		[args],
	);

	const handleToolDecision = useCallback(
		async (_index: number, action: ToolDecisionAction, interactiveValue?: unknown) => {
			await resumeGatedTool(action, { interactiveValue });
		},
		[resumeGatedTool],
	);

	const handleAuthCredential = useCallback(
		async (_index: number, slot: string, credential: ToolCredential) => {
			await resumeGatedTool('allow', { credentials: { [slot]: credential } });
		},
		[resumeGatedTool],
	);

	return { handleToolDecision, handleAuthCredential };
}

export function useTheoremChatActions(args: TheoremChatActionArgs) {
	const { startTurnFromFields, startTurnFromDraft } = useTurnStarters(args);
	const { enqueuePending, handlePendingRestore } = usePendingActions(args);
	const { handleToolDecision, handleAuthCredential } = useGateActions(args);

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

	const abandonGatedIfNeeded = useCallback(() => {
		const composer = args.iface;
		if (!composer || !args.sessionRef.current.gatedTool) return;
		const abandoned = abandonGatedInterfaceTool({
			iface: composer,
			session: args.sessionRef.current,
		});
		const merged = applyTurnResultToTranscript({
			blocks: args.blocksRef.current,
			streamBlocks: [],
			session: abandoned.session,
			assistantBlocks: abandoned.assistantBlocks,
		});
		args.setBlocks(merged.blocks);
		args.setStreamBlocks([]);
		args.setSession(merged.session);
		args.sessionRef.current = merged.session;
	}, [args]);

	const handleSendNow = useCallback(
		async (draftSource?: ComposerPendingMessage) => {
			if (!args.iface) return;

			let draft = draftSource?.draft;
			if (!draft) {
				draft = await encodeComposerDraft({
					text: args.draftText,
					pendingFiles: args.pendingFiles,
					pendingVoice: args.pendingVoice,
				});
				if (!userDraftHasPayload(draft)) return;
				args.clearComposer();
			} else if (draftSource) {
				const pendingId = draftSource.id;
				args.setPendingMessages((prev) => removeComposerPendingMessage(prev, pendingId));
			}

			if (args.busyRef.current) {
				args.abortRef.current?.abort();
				await args.runPromiseRef.current;
			}

			await abandonGatedIfNeeded();
			args.setPendingMessages((prev) => convertSteersToFrontQueued(prev));
			args.allowQueueDrainRef.current = false;
			await startTurnFromDraft(draft);
		},
		[abandonGatedIfNeeded, args, startTurnFromDraft],
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
		handleAuthCredential,
		handlePendingRestore,
		enqueuePending,
	};
}
