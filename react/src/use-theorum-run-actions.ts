import { useCallback, type MutableRefObject } from 'react';
import type {
	ComposerMenuAction,
	ComposerPendingMessage,
	ComposerProfileInterface,
	ComposerRunPhase,
	InterfaceTurnSession,
	TranscriptBlock,
} from 'theorum/interface';
import {
	convertSteersToFrontQueued,
	createComposerPendingMessage,
	orderComposerPendingMessages,
	removeComposerPendingMessage,
	userDraftHasPayload,
	userDraftToSteerInject,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import {
	abandonGatedInterfaceTool,
	applyTurnResultToTranscript,
	composerFieldsFromDraft,
	encodeComposerDraft,
	type PlaygroundRunPayload,
	postPlaygroundSteer,
	resumeInterfaceTool,
	streamInterfaceDraftTurn,
	streamInterfaceTurn,
	type ToolDecisionAction,
} from './client/index';

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

type RunTurnStream = (
	run: (onStream: (blocks: TranscriptBlock[]) => void) => Promise<
		| {
				ok: true;
				session: InterfaceTurnSession;
				userBlocks?: TranscriptBlock[];
				assistantBlocks: TranscriptBlock[];
		  }
		| { ok: false; error: string; errorInternal?: string; issues?: string[]; aborted?: boolean }
	>,
	options?: { userBlocksAlreadyApplied?: boolean },
) => Promise<void>;

export type { RunTurnStream };

function reportCaughtError(
	setError: (value: string) => void,
	setErrorInternal: (value: string) => void,
	err: unknown,
): void {
	setError(err instanceof Error ? err.message : String(err));
	setErrorInternal('');
}

function beginAbortableTurn(args: {
	iface: ComposerProfileInterface | null;
	payload: PlaygroundRunPayload | null;
	abortRef: MutableRefObject<AbortController | null>;
	turnIdRef: MutableRefObject<string | null>;
}): {
	composer: ComposerProfileInterface;
	runPayload: PlaygroundRunPayload;
	turnId: string;
	signal: AbortSignal;
} | null {
	if (!args.iface || !args.payload) return null;
	const controller = new AbortController();
	args.abortRef.current = controller;
	const turnId = newTurnId();
	args.turnIdRef.current = turnId;
	return {
		composer: args.iface,
		runPayload: args.payload,
		turnId,
		signal: controller.signal,
	};
}

export function useTheorumRunActions(args: {
	iface: ComposerProfileInterface | null;
	payload: PlaygroundRunPayload | null;
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
	setPendingMessages: (
		value:
			| ComposerPendingMessage[]
			| ((prev: ComposerPendingMessage[]) => ComposerPendingMessage[]),
	) => void;
	setDraftText: (value: string) => void;
	setPendingFiles: (value: File[]) => void;
	setPendingVoice: (value: File[]) => void;
	setIssues: (value: string[]) => void;
	setError: (value: string) => void;
	setErrorInternal: (value: string) => void;
	pendingRef: MutableRefObject<ComposerPendingMessage[]>;
}) {
	const startTurnFromFields = useCallback(
		async (fields: { text: string; files: File[]; voice: File[] }) => {
			const started = beginAbortableTurn(args);
			if (!started) return;

			await args.runTurnStream(
				(onStream) =>
					streamInterfaceTurn({
						iface: started.composer,
						payload: started.runPayload,
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
						payload: started.runPayload,
						session: args.sessionRef.current,
						draft,
						signal: started.signal,
						turnId: started.turnId,
						onStream,
						onUserBlocks: (userBlocks) => {
							args.setBlocks((prev) => [...prev, ...userBlocks]);
							args.setChatStarted(true);
						},
					}),
				{ userBlocksAlreadyApplied: true },
			);
		},
		[args],
	);

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
					args.setError('No active turn to steer.');
					args.setErrorInternal('');
					args.setPendingMessages((prev) =>
						orderComposerPendingMessages(
							convertSteersToFrontQueued(removeComposerPendingMessage(prev, message.id)),
						),
					);
					return;
				}
				const inject = userDraftToSteerInject(draft);
				if (inject.length === 0) return;
				await postPlaygroundSteer({ turnId, inject });
			} catch (err) {
				reportCaughtError(args.setError, args.setErrorInternal, err);
			}
		},
		[args],
	);

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

	const abandonGatedIfNeeded = useCallback(async () => {
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

	const resumeWithPayload = useCallback(
		async (
			action: ToolDecisionAction,
			extra?: { interactiveValue?: unknown; credentials?: Record<string, ToolCredential> },
		) => {
			const composer = args.iface;
			const runPayload = args.payload;
			if (!composer || !runPayload) return;
			await args.runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					payload: runPayload,
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
			await resumeWithPayload(action, { interactiveValue });
		},
		[resumeWithPayload],
	);

	const handleAuthCredential = useCallback(
		async (_index: number, slot: string, credential: ToolCredential) => {
			await resumeWithPayload('allow', { credentials: { [slot]: credential } });
		},
		[resumeWithPayload],
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
				reportCaughtError(args.setError, args.setErrorInternal, err);
			}
		},
		[args],
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
