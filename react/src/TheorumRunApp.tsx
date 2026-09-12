import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineProfile } from 'theorum';
import {
	branchInterfaceTurnSession,
	type ComposerMenuAction,
	type ComposerPendingMessage,
	type ComposerRunPhase,
	consumeNextComposerQueue,
	convertSteersToFrontQueued,
	createComposerPendingMessage,
	defaultInterfaceEffort,
	defaultInterfaceModel,
	emptyInterfaceTurnSession,
	type InterfaceTurnSession,
	interfaceFromProfile,
	moveComposerPendingWithinKind,
	orderComposerPendingMessages,
	promoteComposerPendingKind,
	removeComposerPendingMessage,
	type TranscriptBlock,
	userDraftHasPayload,
	userDraftToSteerInject,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import {
	applyTurnResultToTranscript,
	abandonGatedInterfaceTool,
	composerFieldsFromDraft,
	encodeComposerDraft,
	loadPlaygroundRunPayload,
	type PlaygroundRunPayload,
	postPlaygroundSteer,
	readPlaygroundRunIdFromUrl,
	resumeInterfaceTool,
	streamInterfaceDraftTurn,
	streamInterfaceTurn,
	type ToolDecisionAction,
} from './client/index';
import { InterfaceRunner } from './components/InterfaceRunner';
import { LiveRunner } from './components/live/LiveRunner';

export type TheorumRunAppProps = {
	/** Where to send the user when no payload is present. */
	missingPayloadHref?: string;
	/** Back-link to the authoring playground. */
	playgroundHref?: string;
	/** Override run-id resolution (tests / product hosts). Default: `?run=` from the URL. */
	readRunId?: () => string | null;
	/** Override payload load (tests / product hosts). Default: localStorage handoff by run id. */
	loadPayload?: (runId: string) => PlaygroundRunPayload | null;
};

type TurnOk = {
	ok: true;
	session: InterfaceTurnSession;
	userBlocks?: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
};

type TurnFail = { ok: false; error: string; errorInternal?: string; issues?: string[]; aborted?: boolean };

function newTurnId(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `turn-${Date.now()}`;
}

export function TheorumRunApp({
	missingPayloadHref = '/#playground',
	playgroundHref = '/#playground',
	readRunId = readPlaygroundRunIdFromUrl,
	loadPayload = loadPlaygroundRunPayload,
}: TheorumRunAppProps) {
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

	useEffect(() => {
		const runId = readRunId();
		if (!runId) {
			window.location.href = missingPayloadHref;
			return;
		}
		const loaded = loadPayload(runId);
		if (!loaded) {
			window.location.href = missingPayloadHref;
			return;
		}
		setPayload(loaded);
		setReady(true);
	}, [loadPayload, missingPayloadHref, readRunId]);

	const iface = useMemo(() => {
		if (!payload || payload.profile.type === 'live') return null;
		return interfaceFromProfile(defineProfile(payload.profile));
	}, [payload]);

	const liveIface = useMemo(() => {
		if (payload?.profile.type !== 'live') return null;
		return interfaceFromProfile(defineProfile(payload.profile));
	}, [payload]);

	const titleHandle = useMemo(() => {
		if (!payload) return 'Run';
		return interfaceFromProfile(defineProfile(payload.profile)).identity.handle;
	}, [payload]);

	const gated = (session.gatedTool ?? session.pausedTool) !== null;
	const phase: ComposerRunPhase = busy ? 'streaming' : gated ? 'gated' : 'idle';

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
	}, [iface, session.selectedEffort, session.selectedModel]);

	const handleGenerationChange = useCallback(
		(next: { modelId: string; effort?: string }) => {
			const effort =
				next.effort ?? (iface ? defaultInterfaceEffort(iface, next.modelId) : undefined);
			setSession((prev) => ({
				...prev,
				selectedModel: next.modelId,
				...(effort ? { selectedEffort: effort } : { selectedEffort: undefined }),
			}));
		},
		[iface],
	);

	const clearComposer = useCallback(() => {
		setDraftText('');
		setPendingFiles([]);
		setPendingVoice([]);
	}, []);

	const onRunEnded = useCallback((nextPending: ComposerPendingMessage[], drain: boolean) => {
		const converted = convertSteersToFrontQueued(nextPending);
		setPendingMessages(orderComposerPendingMessages(converted));
		allowQueueDrainRef.current = drain;
		return converted;
	}, []);

	const runTurnStream = useCallback(
		async (
			run: (onStream: (partial: TranscriptBlock[]) => void) => Promise<TurnOk | TurnFail>,
			options: { userBlocksAlreadyApplied?: boolean } = {},
		) => {
			if (!iface || !payload || busyRef.current) return;
			setError('');
			setErrorInternal('');
			busyRef.current = true;
			setBusy(true);
			setStreaming(true);
			allowQueueDrainRef.current = false;

			const work = (async () => {
				let latestStream: TranscriptBlock[] = [];
				const result = await run((partial) => {
					latestStream = partial;
					scheduleStreamBlocks(partial);
				});

				cancelPendingStreamFrame();
				busyRef.current = false;
				setBusy(false);
				setStreaming(false);
				abortRef.current = null;
				turnIdRef.current = null;

				if (!result.ok) {
					if (!result.aborted) {
						setError(result.error);
						setErrorInternal(result.errorInternal ?? '');
						if (result.issues) setIssues(result.issues);
					}
					setStreamBlocks([]);
					// Stop / abort: steers → queue, but do not auto-drain.
					onRunEnded(pendingRef.current, false);
					return;
				}

				const merged = applyTurnResultToTranscript({
					blocks: blocksRef.current,
					streamBlocks: latestStream,
					session: result.session,
					userBlocks: options.userBlocksAlreadyApplied ? undefined : result.userBlocks,
					assistantBlocks: result.assistantBlocks,
				});
				setBlocks(merged.blocks);
				setStreamBlocks(merged.streamBlocks);
				setSession(merged.session);

				if ((merged.session.gatedTool ?? merged.session.pausedTool) !== null) {
					// Same run — leave pending intents alone; do not drain queue.
					return;
				}

				onRunEnded(pendingRef.current, true);
			})();

			runPromiseRef.current = work;
			try {
				await work;
			} finally {
				if (runPromiseRef.current === work) runPromiseRef.current = null;
			}
		},
		[cancelPendingStreamFrame, iface, onRunEnded, payload, scheduleStreamBlocks],
	);

	const startTurnFromFields = useCallback(
		async (args: {
			text: string;
			files: File[];
			voice: File[];
		}) => {
			const composer = iface;
			const runPayload = payload;
			if (!composer || !runPayload) return;

			const controller = new AbortController();
			abortRef.current = controller;
			const turnId = newTurnId();
			turnIdRef.current = turnId;

			await runTurnStream(
				(onStream) =>
					streamInterfaceTurn({
						iface: composer,
						payload: runPayload,
						session: sessionRef.current,
						text: args.text,
						pendingFiles: args.files,
						pendingVoice: args.voice,
						signal: controller.signal,
						turnId,
						onStream,
						onUserBlocks: (userBlocks) => {
							setBlocks((prev) => [...prev, ...userBlocks]);
							setChatStarted(true);
							clearComposer();
						},
					}),
				{ userBlocksAlreadyApplied: true },
			);
		},
		[clearComposer, iface, payload, runTurnStream],
	);

	const startTurnFromDraft = useCallback(
		async (draft: ComposerPendingMessage['draft']) => {
			const composer = iface;
			const runPayload = payload;
			if (!composer || !runPayload) return;

			const controller = new AbortController();
			abortRef.current = controller;
			const turnId = newTurnId();
			turnIdRef.current = turnId;

			await runTurnStream(
				(onStream) =>
					streamInterfaceDraftTurn({
						iface: composer,
						payload: runPayload,
						session: sessionRef.current,
						draft,
						signal: controller.signal,
						turnId,
						onStream,
						onUserBlocks: (userBlocks) => {
							setBlocks((prev) => [...prev, ...userBlocks]);
							setChatStarted(true);
						},
					}),
				{ userBlocksAlreadyApplied: true },
			);
		},
		[iface, payload, runTurnStream],
	);

	const drainQueue = useCallback(async () => {
		if (
			drainLockRef.current ||
			busyRef.current ||
			(sessionRef.current.gatedTool ?? sessionRef.current.pausedTool)
		) {
			return;
		}
		const { message, remaining } = consumeNextComposerQueue(pendingRef.current);
		if (!message) return;
		drainLockRef.current = true;
		setPendingMessages(remaining);
		try {
			await startTurnFromDraft(message.draft);
		} finally {
			drainLockRef.current = false;
		}
	}, [startTurnFromDraft]);

	useEffect(() => {
		if (phase !== 'idle' || !allowQueueDrainRef.current) return;
		if (!pendingMessages.some((m) => m.kind === 'queue')) {
			allowQueueDrainRef.current = false;
			return;
		}
		allowQueueDrainRef.current = false;
		void drainQueue();
	}, [drainQueue, pendingMessages, phase]);

	const enqueuePending = useCallback(async (kind: 'queue' | 'steer' | 'stash') => {
		if (!userDraftHasPayload({
			...(draftText.trim() ? { text: draftText } : {}),
			...(pendingFiles.length
				? {
						attachments: pendingFiles.map((f) => ({
							name: f.name,
							mimeType: f.type || 'application/octet-stream',
							sizeBytes: f.size,
						})),
					}
				: {}),
			...(pendingVoice.length
				? {
						voice: pendingVoice.map((f) => ({
							name: f.name,
							mimeType: f.type || 'application/octet-stream',
							sizeBytes: f.size,
						})),
					}
				: {}),
		})) {
			return;
		}
		setIssues([]);
		try {
			const draft = await encodeComposerDraft({
				text: draftText,
				pendingFiles,
				pendingVoice,
			});
			const message = createComposerPendingMessage({ kind, draft });
			setPendingMessages((prev) => orderComposerPendingMessages([...prev, message]));
			clearComposer();

			if (kind === 'steer') {
				const turnId = turnIdRef.current;
				if (!turnId) {
					setError('No active turn to steer.');
					setErrorInternal('');
					setPendingMessages((prev) =>
						orderComposerPendingMessages(
							convertSteersToFrontQueued(removeComposerPendingMessage(prev, message.id)),
						),
					);
					return;
				}
				const inject = userDraftToSteerInject(draft);
				if (inject.length === 0) return;
				await postPlaygroundSteer({ turnId, inject });
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setErrorInternal('');
		}
	}, [clearComposer, draftText, pendingFiles, pendingVoice]);

	const handleStop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const handleSubmit = useCallback(async () => {
		if (phase === 'streaming' || phase === 'gated' || phase === 'paused') {
			await enqueuePending('queue');
			return;
		}
		if (gated) return;
		setIssues([]);
		await startTurnFromFields({
			text: draftText,
			files: [...pendingFiles],
			voice: [...pendingVoice],
		});
	}, [draftText, enqueuePending, gated, pendingFiles, pendingVoice, phase, startTurnFromFields]);

	const handleSendNow = useCallback(
		async (draftSource?: ComposerPendingMessage) => {
			const composer = iface;
			if (!composer) return;

			let draft = draftSource?.draft;
			if (!draft) {
				draft = await encodeComposerDraft({
					text: draftText,
					pendingFiles,
					pendingVoice,
				});
				if (!userDraftHasPayload(draft)) return;
				clearComposer();
			} else {
				setPendingMessages((prev) => removeComposerPendingMessage(prev, draftSource!.id));
			}

			if (busyRef.current) {
				abortRef.current?.abort();
				await runPromiseRef.current;
			}

			if ((sessionRef.current.gatedTool ?? sessionRef.current.pausedTool) && composer) {
				const abandoned = abandonGatedInterfaceTool({
					iface: composer,
					session: sessionRef.current,
				});
				const merged = applyTurnResultToTranscript({
					blocks: blocksRef.current,
					streamBlocks: [],
					session: abandoned.session,
					assistantBlocks: abandoned.assistantBlocks,
				});
				setBlocks(merged.blocks);
				setStreamBlocks([]);
				setSession(merged.session);
				sessionRef.current = merged.session;
			}

			setPendingMessages((prev) => convertSteersToFrontQueued(prev));
			allowQueueDrainRef.current = false;
			await startTurnFromDraft(draft);
		},
		[
			clearComposer,
			draftText,
			iface,
			pendingFiles,
			pendingVoice,
			startTurnFromDraft,
		],
	);

	const handleMenuAction = useCallback(
		(action: ComposerMenuAction) => {
			if (action === 'queue' || action === 'steer' || action === 'stash') {
				void enqueuePending(action);
				return;
			}
			if (action === 'send_now') {
				void handleSendNow();
			}
		},
		[enqueuePending, handleSendNow],
	);

	const handleToolDecision = useCallback(
		async (_index: number, action: ToolDecisionAction, interactiveValue?: unknown) => {
			const composer = iface;
			const runPayload = payload;
			if (!composer || !runPayload) return;

			await runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					payload: runPayload,
					session: sessionRef.current,
					action,
					interactiveValue,
					onStream,
				}),
			);
		},
		[iface, payload, runTurnStream],
	);

	const handleAuthCredential = useCallback(
		async (_index: number, slot: string, credential: ToolCredential) => {
			const composer = iface;
			const runPayload = payload;
			if (!composer || !runPayload) return;

			await runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					payload: runPayload,
					session: sessionRef.current,
					action: 'allow',
					credentials: { [slot]: credential },
					onStream,
				}),
			);
		},
		[iface, payload, runTurnStream],
	);

	const handleBranch = useCallback(
		(index: number) => {
			const kept = [...blocks, ...streamBlocks].slice(0, index + 1);
			setBlocks(kept);
			setStreamBlocks([]);
			setStreaming(false);
			busyRef.current = false;
			setBusy(false);
			setChatStarted(kept.length > 0);
			setSession((prevSession) => branchInterfaceTurnSession(prevSession, kept));
		},
		[blocks, streamBlocks],
	);

	const handlePendingRestore = useCallback(async (id: string) => {
		const message = pendingRef.current.find((m) => m.id === id);
		if (!message) return;

		const currentDraft = {
			...(draftText.trim() ? { text: draftText } : {}),
			...(pendingFiles.length
				? {
						attachments: pendingFiles.map((f) => ({
							name: f.name,
							mimeType: f.type || 'application/octet-stream',
							sizeBytes: f.size,
						})),
					}
				: {}),
			...(pendingVoice.length
				? {
						voice: pendingVoice.map((f) => ({
							name: f.name,
							mimeType: f.type || 'application/octet-stream',
							sizeBytes: f.size,
						})),
					}
				: {}),
		};

		try {
			let nextPending = removeComposerPendingMessage(pendingRef.current, id);

			if (userDraftHasPayload(currentDraft)) {
				const stashDraft = await encodeComposerDraft({
					text: draftText,
					pendingFiles,
					pendingVoice,
				});
				const stash = createComposerPendingMessage({ kind: 'stash', draft: stashDraft });
				nextPending = orderComposerPendingMessages([...nextPending, stash]);
			}

			const restored = composerFieldsFromDraft(message.draft);
			setPendingMessages(nextPending);
			setDraftText(restored.text);
			setPendingFiles(restored.files);
			setPendingVoice(restored.voice);
			setIssues([]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setErrorInternal('');
		}
	}, [draftText, pendingFiles, pendingVoice]);

	const handlePendingQueue = useCallback(
		(id: string) => {
			const message = pendingRef.current.find((m) => m.id === id);
			if (!message || message.kind !== 'stash') return;
			if (phase === 'idle') {
				allowQueueDrainRef.current = true;
			}
			setPendingMessages((prev) => promoteComposerPendingKind(prev, id, 'queue'));
		},
		[phase],
	);

	useEffect(() => {
		document.title = `${titleHandle} · Theorum Playground`;
	}, [titleHandle]);

	return (
		<>
			<a className="iface-run-link" href={playgroundHref}>
				← Playground
			</a>

			{!ready ? (
				<p className="iface-run-loading" aria-busy="true">
					Loading…
				</p>
			) : payload?.profile.type === 'live' && liveIface ? (
				<LiveRunner iface={liveIface} payload={payload} />
			) : iface && payload ? (
				<InterfaceRunner
					blocks={blocks}
					chatStarted={chatStarted}
					draftText={draftText}
					error={error}
					errorInternal={errorInternal}
					iface={iface}
					issues={[...issues]}
					onAuthCredential={(index, slot, credential) => {
						void handleAuthCredential(index, slot, credential);
					}}
					onBranch={handleBranch}
					onDraftTextChange={setDraftText}
					onFilesSelected={(files) => {
						setPendingFiles((prev) => [...prev, ...files]);
						setIssues([]);
					}}
					onAttachmentRemove={(index) => {
						setPendingFiles((prev) => prev.filter((_, i) => i !== index));
					}}
					onVoiceStaged={(file) => {
						setPendingVoice([file]);
						setIssues([]);
					}}
					onVoiceClear={() => {
						setPendingVoice([]);
					}}
					onSubmit={() => {
						void handleSubmit();
					}}
					onStop={handleStop}
					onMenuAction={handleMenuAction}
					onPendingMove={(id, direction) => {
						setPendingMessages((prev) => moveComposerPendingWithinKind(prev, id, direction));
					}}
					onPendingQueue={handlePendingQueue}
					onPendingRemove={(id) => {
						setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
					}}
					onPendingRestore={(id) => {
						void handlePendingRestore(id);
					}}
					onPendingSendNow={(id) => {
						const message = pendingMessages.find((m) => m.id === id);
						if (message) void handleSendNow(message);
					}}
					onToolDecision={(index, action, interactiveValue) => {
						void handleToolDecision(index, action, interactiveValue);
					}}
					onGenerationChange={handleGenerationChange}
					pendingFiles={pendingFiles}
					pendingMessages={pendingMessages}
					pendingVoice={pendingVoice}
					phase={phase}
					selectedEffort={session.selectedEffort ?? ''}
					selectedModel={session.selectedModel ?? ''}
					streamBlocks={streamBlocks}
					streaming={streaming}
				/>
			) : (
				<p className="iface-run-inline-error" role="alert">
					No compiled agent in session. Return to the playground and press Run.
				</p>
			)}
		</>
	);
}
