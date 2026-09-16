import { useEffect, useRef, useState } from 'react';
import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { ToolCredential } from 'theorum/kernel';
import {
	assistantTurnCopyText,
	composeAssistantTurn,
	workStatusLabel,
} from '../client/transcript-groups';
import { MarkdownBody } from './MarkdownBody';
import { SourceChips } from './SourceChips';
import { ToolTraceDisclosure } from './ToolTraceDisclosure';
import { TranscriptBlockView } from './TranscriptBlockView';
import { TranscriptMessageShell } from './TranscriptMessageShell';

export type AssistantTurnViewProps = {
	blocks: TranscriptBlock[];
	handle: string;
	streaming?: boolean;
	at?: number;
	onBranch?: () => void;
	onToolDecision?: (
		block: TranscriptBlock,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
	onAuthCredential?: (block: TranscriptBlock, slot: string, credential: ToolCredential) => void;
	showChrome?: boolean;
};

function useStreamingElapsed(streaming: boolean): number | undefined {
	const startedAtRef = useRef<number | null>(null);
	const [elapsedMs, setElapsedMs] = useState<number | undefined>(undefined);

	useEffect(() => {
		if (streaming) {
			if (startedAtRef.current === null) {
				startedAtRef.current = Date.now();
			}
			setElapsedMs(undefined);
			return;
		}
		if (startedAtRef.current !== null) {
			setElapsedMs(Date.now() - startedAtRef.current);
		}
	}, [streaming]);

	return elapsedMs;
}

function isSimpleSingleBody(
	streaming: boolean,
	hasTrace: boolean,
	gatedToolsCount: number,
	bodyLength: number,
	statusLabel: string | undefined,
): boolean {
	if (streaming || hasTrace || statusLabel) return false;
	return gatedToolsCount === 0 && bodyLength === 1;
}

function EmbeddedTranscriptBlockView({
	block,
	handle,
	onAuthCredential,
	onToolDecision,
}: {
	block: TranscriptBlock;
	handle: string;
	onAuthCredential?: (block: TranscriptBlock, slot: string, credential: ToolCredential) => void;
	onToolDecision?: (
		block: TranscriptBlock,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
}) {
	const handleAuth = onAuthCredential
		? (slot: string, credential: ToolCredential) => {
				onAuthCredential(block, slot, credential);
			}
		: undefined;

	const handleDecision = onToolDecision
		? (action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) => {
				onToolDecision(block, action, interactiveValue);
			}
		: undefined;

	return (
		<TranscriptBlockView
			key={block.id}
			block={block}
			handle={handle}
			embedded
			showChrome={false}
			onAuthCredential={handleAuth}
			onToolDecision={handleDecision}
		/>
	);
}

function AssistantBodyBlockView({
	block,
	index,
	bodyLength,
	streaming,
	handle,
	onAuthCredential,
	onToolDecision,
}: {
	block: TranscriptBlock;
	index: number;
	bodyLength: number;
	streaming: boolean;
	handle: string;
	onAuthCredential?: (block: TranscriptBlock, slot: string, credential: ToolCredential) => void;
	onToolDecision?: (
		block: TranscriptBlock,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
}) {
	if (block.kind === 'text') {
		return (
			<MarkdownBody
				key={block.id}
				text={block.text}
				streaming={streaming && index === bodyLength - 1}
			/>
		);
	}
	if (block.kind === 'error') {
		return (
			<p key={block.id} className="iface-msg__bubble iface-msg__bubble--error">
				{block.message}
			</p>
		);
	}
	if (block.kind === 'grounding' || block.kind === 'evidence') {
		return <SourceChips key={block.id} block={block} />;
	}
	return (
		<EmbeddedTranscriptBlockView
			block={block}
			handle={handle}
			onAuthCredential={onAuthCredential}
			onToolDecision={onToolDecision}
		/>
	);
}

function SoleAssistantBlockView({
	soleBody,
	handle,
	at,
	onBranch,
	onAuthCredential,
	onToolDecision,
	showChrome,
}: {
	soleBody: TranscriptBlock;
	handle: string;
	at?: number;
	onBranch?: () => void;
	onAuthCredential?: (block: TranscriptBlock, slot: string, credential: ToolCredential) => void;
	onToolDecision?: (
		block: TranscriptBlock,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
	showChrome?: boolean;
}) {
	const handleAuth = onAuthCredential
		? (slot: string, credential: ToolCredential) => {
				onAuthCredential(soleBody, slot, credential);
			}
		: undefined;

	const handleDecision = onToolDecision
		? (action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) => {
				onToolDecision(soleBody, action, interactiveValue);
			}
		: undefined;

	return (
		<TranscriptBlockView
			block={soleBody}
			handle={handle}
			at={at}
			onBranch={onBranch}
			onAuthCredential={handleAuth}
			onToolDecision={handleDecision}
			showChrome={showChrome}
			streaming={false}
		/>
	);
}

function AssistantTurnArticle({
	handleLabel,
	statusLabel,
	traceOpen,
	setTraceOpen,
	trace,
	streaming,
	hasTrace,
	gatedTools,
	body,
	handle,
	onAuthCredential,
	onToolDecision,
}: {
	handleLabel: string;
	statusLabel?: string;
	traceOpen: boolean;
	setTraceOpen: React.Dispatch<React.SetStateAction<boolean>>;
	trace: ReturnType<typeof composeAssistantTurn>['trace'];
	streaming: boolean;
	hasTrace: boolean;
	gatedTools: TranscriptBlock[];
	body: TranscriptBlock[];
	handle: string;
	onAuthCredential?: (block: TranscriptBlock, slot: string, credential: ToolCredential) => void;
	onToolDecision?: (
		block: TranscriptBlock,
		action: 'allow' | 'allow_session' | 'deny',
		interactiveValue?: unknown,
	) => void;
}) {
	const articleClass = streaming
		? 'iface-msg iface-msg--assistant iface-msg--streaming'
		: 'iface-msg iface-msg--assistant';

	return (
		<article className={articleClass}>
			<p className="iface-msg__handle">{handleLabel}</p>

			{statusLabel ? (
				<ToolTraceDisclosure
					expanded={traceOpen}
					items={trace}
					label={statusLabel}
					streaming={streaming && hasTrace}
					onToggle={() => {
						setTraceOpen((prev) => !prev);
					}}
				/>
			) : null}

			{gatedTools.map((block) => (
				<EmbeddedTranscriptBlockView
					key={block.id}
					block={block}
					handle={handle}
					onAuthCredential={onAuthCredential}
					onToolDecision={onToolDecision}
				/>
			))}

			{body.map((block, index) => (
				<AssistantBodyBlockView
					key={block.id}
					block={block}
					index={index}
					bodyLength={body.length}
					streaming={streaming}
					handle={handle}
					onAuthCredential={onAuthCredential}
					onToolDecision={onToolDecision}
				/>
			))}
		</article>
	);
}

export function AssistantTurnView({
	blocks,
	handle,
	streaming = false,
	at,
	onBranch,
	onToolDecision,
	onAuthCredential,
	showChrome = true,
}: AssistantTurnViewProps) {
	const [traceOpen, setTraceOpen] = useState(false);
	const elapsedMs = useStreamingElapsed(streaming);

	const composed = composeAssistantTurn(blocks, { streaming });
	const { trace, gatedTools, body, hasTrace } = composed;
	const copyText = assistantTurnCopyText(body.length > 0 ? body : blocks);
	const handleLabel = `@${handle}`;
	const statusLabel = workStatusLabel({
		streaming,
		hasTrace,
		elapsedMs,
	});

	const soleBody = isSimpleSingleBody(
		streaming,
		hasTrace,
		gatedTools.length,
		body.length,
		statusLabel,
	)
		? body[0]
		: undefined;

	if (soleBody) {
		return (
			<SoleAssistantBlockView
				soleBody={soleBody}
				handle={handle}
				at={at}
				onBranch={onBranch}
				onAuthCredential={onAuthCredential}
				onToolDecision={onToolDecision}
				showChrome={showChrome}
			/>
		);
	}

	return (
		<TranscriptMessageShell
			align="assistant"
			at={at}
			copyText={copyText}
			onBranch={onBranch}
			showChrome={showChrome}
		>
			<AssistantTurnArticle
				handleLabel={handleLabel}
				statusLabel={statusLabel}
				traceOpen={traceOpen}
				setTraceOpen={setTraceOpen}
				trace={trace}
				streaming={streaming}
				hasTrace={hasTrace}
				gatedTools={gatedTools}
				body={body}
				handle={handle}
				onAuthCredential={onAuthCredential}
				onToolDecision={onToolDecision}
			/>
		</TranscriptMessageShell>
	);
}
