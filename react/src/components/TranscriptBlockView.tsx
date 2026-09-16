import type { ReactNode } from 'react';
import type { TranscriptBlock } from '../../../src/interface/mod.ts';
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

type BodyArgs = {
	handleLabel: string;
	streaming: boolean;
	embedded: boolean;
	onToolDecision?: TranscriptBlockViewProps['onToolDecision'];
	onAuthCredential?: TranscriptBlockViewProps['onAuthCredential'];
};

function userAlign(block: TranscriptBlock): boolean {
	return (
		block.kind === 'user-text' || block.kind === 'user-attachment' || block.kind === 'user-voice'
	);
}

function Handle(props: { show: boolean; label: string }) {
	return props.show ? <p className="iface-msg__handle">{props.label}</p> : null;
}

function UserTextBody(block: Extract<TranscriptBlock, { kind: 'user-text' }>) {
	return (
		<article className="iface-msg iface-msg--user">
			<p className="iface-msg__bubble">{block.text}</p>
		</article>
	);
}

function UserMediaBody(
	block: Extract<TranscriptBlock, { kind: 'user-attachment' | 'user-voice' }>,
) {
	const dataUrl =
		block.data !== undefined ? `data:${block.mimeType};base64,${block.data}` : undefined;
	let content: ReactNode;
	if (dataUrl && block.mimeType.startsWith('image/')) {
		content = <img className="iface-msg__image" alt={block.name} src={dataUrl} />;
	} else if (dataUrl && block.mimeType.startsWith('audio/')) {
		content = <VoiceNotePill label={block.name} mimeType={block.mimeType} src={dataUrl} />;
	} else {
		content = (
			<>
				<p className="iface-msg__bubble">{block.name}</p>
				<p className="iface-msg__meta">{block.mimeType}</p>
			</>
		);
	}
	return <article className="iface-msg iface-msg--user">{content}</article>;
}

function ThoughtBody(block: Extract<TranscriptBlock, { kind: 'thought' }>) {
	return (
		<article className="iface-msg iface-msg--thought">
			<p className="iface-msg__meta">Thought</p>
			<p className="iface-msg__bubble">{block.text}</p>
		</article>
	);
}

function TextBody(block: Extract<TranscriptBlock, { kind: 'text' }>, args: BodyArgs) {
	return (
		<article
			className={
				args.streaming
					? 'iface-msg iface-msg--assistant iface-msg--streaming'
					: 'iface-msg iface-msg--assistant'
			}
		>
			<Handle show={!args.embedded} label={args.handleLabel} />
			<MarkdownBody text={block.text} streaming={args.streaming} />
		</article>
	);
}

function ToolGateBody(args: {
	tool: Extract<TranscriptBlock, { kind: 'tool' }>['tool'];
	onToolDecision?: BodyArgs['onToolDecision'];
	onAuthCredential?: BodyArgs['onAuthCredential'];
}) {
	const { tool, onToolDecision, onAuthCredential } = args;
	if (tool.phase !== 'gate' || !tool.gate) {
		if (tool.output !== undefined) {
			return <pre className="iface-msg__code">{JSON.stringify(tool.output, null, 2)}</pre>;
		}
		if (tool.failure !== undefined) {
			return (
				<pre className="iface-msg__code iface-msg__code--error">
					{JSON.stringify(tool.failure, null, 2)}
				</pre>
			);
		}
		return null;
	}
	if (tool.gate.kind === 'auth') {
		return (
			<AuthChallengeCard
				onSubmitCredential={onAuthCredential}
				gate={tool.gate}
				toolName={tool.name}
			/>
		);
	}
	return (
		<ApprovalCard
			onDecision={onToolDecision}
			gate={tool.gate}
			toolName={tool.name}
			input={tool.arguments}
		/>
	);
}

function ToolBody(block: Extract<TranscriptBlock, { kind: 'tool' }>, args: BodyArgs) {
	return (
		<article className={args.embedded ? 'iface-msg' : 'iface-msg iface-msg--assistant'}>
			{args.embedded ? (
				<p className="iface-msg__meta">Tool · {block.tool.name}</p>
			) : (
				<>
					<p className="iface-msg__handle">{args.handleLabel}</p>
					<p className="iface-msg__meta">
						Tool · {block.tool.name} [{block.tool.phase ?? 'invoked'}]
					</p>
				</>
			)}
			<ToolGateBody
				tool={block.tool}
				onToolDecision={args.onToolDecision}
				onAuthCredential={args.onAuthCredential}
			/>
		</article>
	);
}

function StructuredBody(block: Extract<TranscriptBlock, { kind: 'structured' }>, args: BodyArgs) {
	return (
		<article className="iface-msg iface-msg--assistant">
			<Handle show={!args.embedded} label={args.handleLabel} />
			<pre className="iface-msg__code">{JSON.stringify(block.value, null, 2)}</pre>
		</article>
	);
}

function mediaSrc(block: Extract<TranscriptBlock, { kind: 'media' }>): string | undefined {
	if (block.url !== undefined) return block.url;
	if (block.data !== undefined) return `data:${block.mimeType};base64,${block.data}`;
	return undefined;
}

function mediaContent(block: Extract<TranscriptBlock, { kind: 'media' }>): ReactNode {
	const src = mediaSrc(block);
	if (!src) return <p className="iface-msg__meta">{block.mimeType}</p>;
	if (block.mimeType.startsWith('image/')) {
		return <img className="iface-msg__image" alt="Media" src={src} />;
	}
	if (block.mimeType.startsWith('video/')) {
		return (
			<video className="iface-msg__video" controls playsInline preload="metadata" src={src} />
		);
	}
	if (block.mimeType.startsWith('audio/')) {
		return <VoiceNotePill mimeType={block.mimeType} src={src} />;
	}
	return <p className="iface-msg__meta">{block.mimeType}</p>;
}

function MediaBody(block: Extract<TranscriptBlock, { kind: 'media' }>, args: BodyArgs) {
	return (
		<article className="iface-msg iface-msg--assistant">
			<Handle show={!args.embedded} label={args.handleLabel} />
			{mediaContent(block)}
		</article>
	);
}

function SourcesBody(
	block: Extract<TranscriptBlock, { kind: 'grounding' | 'evidence' }>,
	args: BodyArgs,
) {
	return (
		<article className="iface-msg iface-msg--assistant">
			<Handle show={!args.embedded} label={args.handleLabel} />
			<SourceChips block={block} />
		</article>
	);
}

function ErrorBody(block: Extract<TranscriptBlock, { kind: 'error' }>, args: BodyArgs) {
	return (
		<article className="iface-msg iface-msg--assistant iface-msg--error">
			<Handle show={!args.embedded} label={args.handleLabel} />
			<p className="iface-msg__bubble">{block.message}</p>
		</article>
	);
}

type BodyRenderer = (block: TranscriptBlock, args: BodyArgs) => ReactNode;

const BODY_RENDERERS: Partial<Record<TranscriptBlock['kind'], BodyRenderer>> = {
	'user-text': (block) => UserTextBody(block as Extract<TranscriptBlock, { kind: 'user-text' }>),
	'user-attachment': (block) =>
		UserMediaBody(block as Extract<TranscriptBlock, { kind: 'user-attachment' }>),
	'user-voice': (block) =>
		UserMediaBody(block as Extract<TranscriptBlock, { kind: 'user-voice' }>),
	thought: (block) => ThoughtBody(block as Extract<TranscriptBlock, { kind: 'thought' }>),
	text: (block, args) => TextBody(block as Extract<TranscriptBlock, { kind: 'text' }>, args),
	tool: (block, args) => ToolBody(block as Extract<TranscriptBlock, { kind: 'tool' }>, args),
	structured: (block, args) =>
		StructuredBody(block as Extract<TranscriptBlock, { kind: 'structured' }>, args),
	media: (block, args) => MediaBody(block as Extract<TranscriptBlock, { kind: 'media' }>, args),
	grounding: (block, args) =>
		SourcesBody(block as Extract<TranscriptBlock, { kind: 'grounding' }>, args),
	evidence: (block, args) =>
		SourcesBody(block as Extract<TranscriptBlock, { kind: 'evidence' }>, args),
	error: (block, args) => ErrorBody(block as Extract<TranscriptBlock, { kind: 'error' }>, args),
};

function renderBody(block: TranscriptBlock, args: BodyArgs): ReactNode {
	return BODY_RENDERERS[block.kind]?.(block, args) ?? null;
}

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
	const body = renderBody(block, {
		handleLabel,
		streaming,
		embedded,
		onToolDecision,
		onAuthCredential,
	});

	if (embedded) return body;

	return (
		<TranscriptMessageShell
			align={userAlign(block) ? 'user' : 'assistant'}
			at={at}
			copyText={transcriptBlockCopyText(block)}
			onBranch={onBranch}
			showChrome={showChrome}
		>
			{body}
		</TranscriptMessageShell>
	);
}
