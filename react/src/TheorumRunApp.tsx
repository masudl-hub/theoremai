import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineProfile } from 'theorum';
import {
	branchInterfaceTurnSession,
	defaultInterfaceEffort,
	defaultInterfaceModel,
	emptyInterfaceTurnSession,
	type InterfaceTurnSession,
	interfaceFromProfile,
	type TranscriptBlock,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import {
	applyTurnResultToTranscript,
	clearPlaygroundRunPayload,
	loadPlaygroundRunPayload,
	type PlaygroundRunPayload,
	resumeInterfaceTool,
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
	/** Override payload load (tests / product hosts). Default: localStorage handoff. */
	loadPayload?: () => PlaygroundRunPayload | null;
	/** Called after a successful default load; default clears localStorage handoff. */
	onPayloadConsumed?: () => void;
};

type TurnOk = {
	ok: true;
	session: InterfaceTurnSession;
	userBlocks?: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
};

type TurnFail = { ok: false; error: string; issues?: string[] };

export function TheorumRunApp({
	missingPayloadHref = '/#playground',
	playgroundHref = '/#playground',
	loadPayload = loadPlaygroundRunPayload,
	onPayloadConsumed = clearPlaygroundRunPayload,
}: TheorumRunAppProps) {
	const [payload, setPayload] = useState<PlaygroundRunPayload | null>(null);
	const [ready, setReady] = useState(false);
	const [blocks, setBlocks] = useState<TranscriptBlock[]>([]);
	const [streamBlocks, setStreamBlocks] = useState<TranscriptBlock[]>([]);
	const [draftText, setDraftText] = useState('');
	const [pendingFiles, setPendingFiles] = useState<File[]>([]);
	const [pendingVoice, setPendingVoice] = useState<File[]>([]);
	const [issues, setIssues] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [chatStarted, setChatStarted] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [session, setSession] = useState<InterfaceTurnSession>(emptyInterfaceTurnSession());
	const streamRafRef = useRef<number | null>(null);
	const pendingStreamRef = useRef<TranscriptBlock[] | null>(null);
	const blocksRef = useRef(blocks);
	blocksRef.current = blocks;

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
		const loaded = loadPayload();
		if (!loaded) {
			window.location.href = missingPayloadHref;
			return;
		}
		onPayloadConsumed();
		setPayload(loaded);
		setReady(true);
	}, [loadPayload, missingPayloadHref, onPayloadConsumed]);

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

	const paused = session.pausedTool !== null;

	const canSubmit = Boolean(
		!busy &&
			!paused &&
			iface &&
			((iface.inputs.text && draftText.trim().length > 0) ||
				(iface.inputs.attachments && pendingFiles.length > 0) ||
				(iface.inputs.voice && pendingVoice.length > 0)),
	);

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

	const runTurnStream = useCallback(
		async (
			run: (onStream: (partial: TranscriptBlock[]) => void) => Promise<TurnOk | TurnFail>,
			options: { userBlocksAlreadyApplied?: boolean } = {},
		) => {
			if (!iface || !payload || busy) return;
			setError('');
			setBusy(true);
			setStreaming(true);

			let latestStream: TranscriptBlock[] = [];
			const result = await run((partial) => {
				latestStream = partial;
				scheduleStreamBlocks(partial);
			});

			cancelPendingStreamFrame();
			setBusy(false);
			setStreaming(false);

			if (!result.ok) {
				setError(result.error);
				if (result.issues) setIssues(result.issues);
				setStreamBlocks([]);
				return;
			}

			const merged = applyTurnResultToTranscript({
				blocks: blocksRef.current,
				streamBlocks: latestStream,
				session: result.session,
				userBlocks: options.userBlocksAlreadyApplied ? undefined : result.userBlocks,
				assistantBlocks: result.assistantBlocks,
			});
			// Same tick — avoid a frame where committed blocks + streamBlocks duplicate.
			setBlocks(merged.blocks);
			setStreamBlocks(merged.streamBlocks);
			setSession(merged.session);
		},
		[busy, cancelPendingStreamFrame, iface, payload, scheduleStreamBlocks],
	);

	const handleSubmit = useCallback(async () => {
		const composer = iface;
		const runPayload = payload;
		if (!composer || !runPayload || paused) return;
		setIssues([]);

		const textSnapshot = draftText;
		const pendingSnapshot = [...pendingFiles];
		const voiceSnapshot = [...pendingVoice];

		await runTurnStream(
			(onStream) =>
				streamInterfaceTurn({
					iface: composer,
					payload: runPayload,
					session,
					text: textSnapshot,
					pendingFiles: pendingSnapshot,
					pendingVoice: voiceSnapshot,
					onStream,
					onUserBlocks: (userBlocks) => {
						setBlocks((prev) => [...prev, ...userBlocks]);
						setChatStarted(true);
						setDraftText('');
						setPendingFiles([]);
						setPendingVoice([]);
					},
				}),
			{ userBlocksAlreadyApplied: true },
		);
	}, [draftText, iface, payload, paused, pendingFiles, pendingVoice, runTurnStream, session]);

	const handleToolDecision = useCallback(
		async (_index: number, action: ToolDecisionAction, interactiveValue?: unknown) => {
			const composer = iface;
			const runPayload = payload;
			if (!composer || !runPayload) return;

			await runTurnStream((onStream) =>
				resumeInterfaceTool({
					iface: composer,
					payload: runPayload,
					session,
					action,
					interactiveValue,
					onStream,
				}),
			);
		},
		[iface, payload, runTurnStream, session],
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
					session,
					action: 'allow',
					credentials: { [slot]: credential },
					onStream,
				}),
			);
		},
		[iface, payload, runTurnStream, session],
	);

	const handleBranch = useCallback(
		(index: number) => {
			const kept = [...blocks, ...streamBlocks].slice(0, index + 1);
			setBlocks(kept);
			setStreamBlocks([]);
			setStreaming(false);
			setBusy(false);
			setChatStarted(kept.length > 0);
			setSession((prevSession) => branchInterfaceTurnSession(prevSession, kept));
		},
		[blocks, streamBlocks],
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
					busy={busy}
					canSubmit={canSubmit}
					chatStarted={chatStarted}
					draftText={draftText}
					error={error || (paused ? 'Waiting for tool approval before you can continue.' : '')}
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
					onToolDecision={(index, action, interactiveValue) => {
						void handleToolDecision(index, action, interactiveValue);
					}}
					onGenerationChange={handleGenerationChange}
					pendingFiles={pendingFiles}
					pendingVoice={pendingVoice}
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
