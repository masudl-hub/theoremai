import type { TranscriptBlock } from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
import { transcriptBlockCopyText } from '../client/transcript-block-text';
import { ApprovalCard } from './ApprovalCard';
import { AuthChallengeCard } from './AuthChallengeCard';
import { MarkdownBody } from './MarkdownBody';
import { SourceChips } from './SourceChips';
import { TranscriptMessageShell } from './TranscriptMessageShell';
import { VoiceNotePill } from './VoiceNotePill';

export type TranscriptBlockViewProps = {
	block: TranscriptBlock;
	handle: string;
	streaming?: boolean;
	at?: number;
	onBranch?: () => void;
	onToolDecision?: (action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) => void;
	onAuthCredential?: (slot: string, credential: ToolCredential) => void;
	showChrome?: boolean;
	/** Nested inside an assistant turn — no outer shell / handle. */
	embedded?: boolean;
};

export function TranscriptBlockView({
	block,
	handle,
	streaming = false,
	at,
	onBranch,
	onToolDecision,
	onAuthCredential,
	showChrome = true,
	embedded = false,
}: TranscriptBlockViewProps) {
	const handleLabel = `@${handle}`;
	const align =
		block.kind === 'user-text' || block.kind === 'user-attachment' || block.kind === 'user-voice'
			? 'user'
			: 'assistant';
	const copyText = transcriptBlockCopyText(block);

	const body = renderBody({
		block,
		handleLabel,
		streaming,
		embedded,
		onToolDecision,
		onAuthCredential,
	});

	if (embedded) return body;

	return (
		<TranscriptMessageShell
			align={align}
			at={at}
			copyText={copyText}
			onBranch={onBranch}
			showChrome={showChrome}
		>
			{body}
		</TranscriptMessageShell>
	);
}

function renderBody(args: {
	block: TranscriptBlock;
	handleLabel: string;
	streaming: boolean;
	embedded: boolean;
	onToolDecision?: (action: 'allow' | 'allow_session' | 'deny', interactiveValue?: unknown) => void;
	onAuthCredential?: (slot: string, credential: ToolCredential) => void;
}) {
	const { block, handleLabel, streaming, embedded, onToolDecision, onAuthCredential } = args;

	if (block.kind === 'user-text') {
		return (
			<article className="iface-msg iface-msg--user">
				<p className="iface-msg__bubble">{block.text}</p>
			</article>
		);
	}

	if (block.kind === 'user-attachment' || block.kind === 'user-voice') {
		return (
			<article className="iface-msg iface-msg--user">
				{block.data && block.mimeType.startsWith('image/') ? (
					<img
						className="iface-msg__image"
						alt={block.name}
						src={`data:${block.mimeType};base64,${block.data}`}
					/>
				) : block.data && block.mimeType.startsWith('audio/') ? (
					<VoiceNotePill
						label={block.name}
						mimeType={block.mimeType}
						src={`data:${block.mimeType};base64,${block.data}`}
					/>
				) : (
					<>
						<p className="iface-msg__bubble">{block.name}</p>
						<p className="iface-msg__meta">{block.mimeType}</p>
					</>
				)}
			</article>
		);
	}

	if (block.kind === 'thought') {
		return (
			<article className="iface-msg iface-msg--thought">
				<p className="iface-msg__meta">Thought</p>
				<p className="iface-msg__bubble">{block.text}</p>
			</article>
		);
	}

	if (block.kind === 'text') {
		return (
			<article
				className={
					streaming
						? 'iface-msg iface-msg--assistant iface-msg--streaming'
						: 'iface-msg iface-msg--assistant'
				}
			>
				{!embedded ? <p className="iface-msg__handle">{handleLabel}</p> : null}
				<MarkdownBody text={block.text} streaming={streaming} />
			</article>
		);
	}

	if (block.kind === 'tool') {
		return (
			<article className={embedded ? 'iface-msg' : 'iface-msg iface-msg--assistant'}>
				{!embedded ? (
					<>
						<p className="iface-msg__handle">{handleLabel}</p>
						<p className="iface-msg__meta">
							Tool · {block.tool.name} [{block.tool.phase ?? 'invoked'}]
						</p>
					</>
				) : (
					<p className="iface-msg__meta">Tool · {block.tool.name}</p>
				)}
				{block.tool.phase === 'pause' && block.tool.pause ? (
					block.tool.pause.kind === 'auth' ? (
						<AuthChallengeCard
							onSubmitCredential={onAuthCredential}
							pause={block.tool.pause}
							toolName={block.tool.name}
						/>
					) : (
						<ApprovalCard
							onDecision={onToolDecision}
							pause={block.tool.pause}
							toolName={block.tool.name}
						/>
					)
				) : block.tool.output !== undefined ? (
					<pre className="iface-msg__code">{JSON.stringify(block.tool.output, null, 2)}</pre>
				) : block.tool.failure !== undefined ? (
					<pre className="iface-msg__code iface-msg__code--error">
						{JSON.stringify(block.tool.failure, null, 2)}
					</pre>
				) : null}
			</article>
		);
	}

	if (block.kind === 'structured') {
		return (
			<article className="iface-msg iface-msg--assistant">
				{!embedded ? <p className="iface-msg__handle">{handleLabel}</p> : null}
				<pre className="iface-msg__code">{JSON.stringify(block.value, null, 2)}</pre>
			</article>
		);
	}

	if (block.kind === 'media') {
		return (
			<article className="iface-msg iface-msg--assistant">
				{!embedded ? <p className="iface-msg__handle">{handleLabel}</p> : null}
				{block.mimeType.startsWith('image/') ? (
					<img
						className="iface-msg__image"
						alt="Model output"
						src={`data:${block.mimeType};base64,${block.data}`}
					/>
				) : block.mimeType.startsWith('audio/') ? (
					<VoiceNotePill
						mimeType={block.mimeType}
						src={`data:${block.mimeType};base64,${block.data}`}
					/>
				) : (
					<p className="iface-msg__meta">{block.mimeType}</p>
				)}
			</article>
		);
	}

	if (block.kind === 'grounding' || block.kind === 'evidence') {
		return (
			<article className="iface-msg iface-msg--assistant">
				{!embedded ? <p className="iface-msg__handle">{handleLabel}</p> : null}
				<SourceChips block={block} />
			</article>
		);
	}

	if (block.kind === 'error') {
		return (
			<article className="iface-msg iface-msg--assistant iface-msg--error">
				{!embedded ? <p className="iface-msg__handle">{handleLabel}</p> : null}
				<p className="iface-msg__bubble">{block.message}</p>
			</article>
		);
	}

	return null;
}
