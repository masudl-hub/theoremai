import { useEffect, useRef, useState } from 'react';
import type { TranscriptBlock } from 'theorum/interface';
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

	const composed = composeAssistantTurn(blocks, { streaming });
	const { trace, gatedTools, body, hasTrace } = composed;
	const copyText = assistantTurnCopyText(body.length > 0 ? body : blocks);
	const handleLabel = `@${handle}`;
	const statusLabel = workStatusLabel({
		streaming,
		hasTrace,
		elapsedMs,
	});

	// Prefer the composed shell whenever we have status/trace; only skip for a
	// lone completed body block with nothing else to show.
	const simpleSingle =
		!streaming && !hasTrace && gatedTools.length === 0 && body.length === 1 && !statusLabel;
	const soleBody = simpleSingle ? body[0] : undefined;

	if (soleBody) {
		return (
			<TranscriptBlockView
				block={soleBody}
				handle={handle}
				at={at}
				onBranch={onBranch}
				onAuthCredential={
					onAuthCredential
						? (slot, credential) => {
								onAuthCredential(soleBody, slot, credential);
							}
						: undefined
				}
				onToolDecision={
					onToolDecision
						? (action, interactiveValue) => {
								onToolDecision(soleBody, action, interactiveValue);
							}
						: undefined
				}
				showChrome={showChrome}
				streaming={false}
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
			<article
				className={
					streaming
						? 'iface-msg iface-msg--assistant iface-msg--streaming'
						: 'iface-msg iface-msg--assistant'
				}
			>
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
					<TranscriptBlockView
						key={block.id}
						block={block}
						handle={handle}
						embedded
						showChrome={false}
						onAuthCredential={
							onAuthCredential
								? (slot, credential) => {
										onAuthCredential(block, slot, credential);
									}
								: undefined
						}
						onToolDecision={
							onToolDecision
								? (action, interactiveValue) => {
										onToolDecision(block, action, interactiveValue);
									}
								: undefined
						}
					/>
				))}

				{body.map((block, index) => {
					if (block.kind === 'text') {
						return (
							<MarkdownBody
								key={block.id}
								text={block.text}
								streaming={streaming && index === body.length - 1}
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
						<TranscriptBlockView
							key={block.id}
							block={block}
							handle={handle}
							embedded
							showChrome={false}
							onAuthCredential={
								onAuthCredential
									? (slot, credential) => {
											onAuthCredential(block, slot, credential);
										}
									: undefined
							}
							onToolDecision={
								onToolDecision
									? (action, interactiveValue) => {
											onToolDecision(block, action, interactiveValue);
										}
									: undefined
							}
						/>
					);
				})}
			</article>
		</TranscriptMessageShell>
	);
}
