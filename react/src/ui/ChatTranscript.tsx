import { Banner } from '@astryxdesign/core/Banner';
import {
	ChatMessage,
	ChatMessageBubble,
	ChatMessageList,
	ChatMessageMetadata,
	type ChatToolCallItem,
	ChatToolCalls,
} from '@astryxdesign/core/Chat';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { type LightboxMedia, useLightbox } from '@astryxdesign/core/Lightbox';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconCheck, IconCopy, IconGitBranch } from '@tabler/icons-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { ToolCredential } from '../../../src/kernel/mod.ts';
import { chipsFromBlock } from '../client/source-chips';
import {
	assistantTurnCopyText,
	composeAssistantTurn,
	groupTranscriptBlocks,
	type TraceItem,
	workStatusLabel,
} from '../client/transcript-groups';
import { transcriptBlockCopyText } from '../client/transcript-block-text';
import { ApprovalCard, AuthChallengeCard, type ToolDecision } from './ToolGateCard';

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

export type ChatTranscriptProps = {
	blocks: readonly TranscriptBlock[];
	/** Assistant display name (profile handle). */
	handle: string;
	streaming?: boolean;
	onBranch?: (index: number) => void;
	onToolDecision?: (index: number, action: ToolDecision, interactiveValue?: unknown) => void;
	onAuthCredential?: (index: number, slot: string, credential: ToolCredential) => void;
	emptyState?: ReactNode;
};

type BlockHandlers = {
	indexOf: (block: TranscriptBlock) => number;
	onToolDecision?: ChatTranscriptProps['onToolDecision'];
	onAuthCredential?: ChatTranscriptProps['onAuthCredential'];
};

/** First-seen time per block id, so timestamps don't jump while streaming. */
function useBlockTimes(blocks: readonly TranscriptBlock[]): (id: string) => number {
	const times = useRef(new Map<string, number>());
	const now = Date.now();
	for (const block of blocks) {
		if (!times.current.has(block.id)) times.current.set(block.id, now);
	}
	return (id) => times.current.get(id) ?? now;
}

/** `Date.now()`, refreshed every second while `isActive`. */
function useSecondTicker(isActive: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!isActive) return;
		setNow(Date.now());
		const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
		return () => globalThis.clearInterval(timer);
	}, [isActive]);
	return now;
}

/**
 * When each turn finished, keyed by the user group that started it. The
 * assistant group is re-keyed when the stream is committed, so it can't carry
 * the timing itself; the user group is stable.
 */
function useTurnEndTimes(streaming: boolean, lastUserKey: string | undefined): ReadonlyMap<string, number> {
	const ends = useRef(new Map<string, number>());
	const wasStreaming = useRef(streaming);
	if (wasStreaming.current && !streaming && lastUserKey && !ends.current.has(lastUserKey)) {
		ends.current.set(lastUserKey, Date.now());
	}
	wasStreaming.current = streaming;
	return ends.current;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	if (!text.trim()) return null;
	return (
		<IconButton
			label={copied ? 'Copied' : 'Copy'}
			tooltip={copied ? 'Copied' : 'Copy'}
			size="sm"
			variant="ghost"
			icon={<Icon icon={copied ? IconCheck : IconCopy} size="xsm" color="secondary" />}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					globalThis.setTimeout(() => setCopied(false), 1500);
				});
			}}
		/>
	);
}

const MINUTE_MS = 60_000;

/**
 * Astryx's relative time, counted in minutes: "now" for the first minute, then
 * "1m ago", "5m ago", … (its own formatter shows "15s ago" in between).
 */
function MessageTime({ at }: { at: number }) {
	const [isFresh, setIsFresh] = useState(() => Date.now() - at < MINUTE_MS);
	useEffect(() => {
		if (!isFresh) return;
		const timer = globalThis.setTimeout(() => setIsFresh(false), Math.max(0, at + MINUTE_MS - Date.now()));
		return () => globalThis.clearTimeout(timer);
	}, [isFresh, at]);
	if (isFresh) {
		return (
			<Text type="supporting" color="secondary">
				now
			</Text>
		);
	}
	return <Timestamp value={at} format="relative_short" isLive />;
}

function MessageChrome(props: { at: number; copyText: string; onBranch?: () => void }) {
	return (
		<ChatMessageMetadata
			timestamp={<MessageTime at={props.at} />}
			footer={
				<HStack gap={0.5}>
					<CopyButton text={props.copyText} />
					{props.onBranch ? (
						<IconButton
							label="Branch from here"
							tooltip="Branch from here"
							size="sm"
							variant="ghost"
							icon={<Icon icon={IconGitBranch} size="xsm" color="secondary" />}
							onClick={props.onBranch}
						/>
					) : null}
				</HStack>
			}
		/>
	);
}

function dataUrl(mimeType: string, data?: string): string | undefined {
	return data === undefined ? undefined : `data:${mimeType};base64,${data}`;
}

function ImageAttachment({ src, name }: { src: string; name: string }) {
	const lightbox = useLightbox({ media: { src, alt: name, caption: name }, hasZoom: true });
	return (
		<>
			<Thumbnail src={src} alt={name} label={name} onClick={() => lightbox.open()} />
			{lightbox.element}
		</>
	);
}

function UserBlock({ block, metadata }: { block: TranscriptBlock; metadata?: ReactNode }) {
	if (block.kind === 'user-text') return <ChatMessageBubble metadata={metadata}>{block.text}</ChatMessageBubble>;
	if (block.kind !== 'user-attachment' && block.kind !== 'user-voice') return null;
	const src = dataUrl(block.mimeType, block.data);
	if (src && block.mimeType.startsWith('image/')) {
		return <ImageAttachment src={src} name={block.name} />;
	}
	if (src && block.mimeType.startsWith('audio/')) {
		// biome-ignore lint/a11y/useMediaCaption: user voice note
		return <audio controls preload="metadata" src={src} aria-label={block.name} />;
	}
	return <Token label={block.name} description={block.mimeType} />;
}

function mediaSrc(block: Extract<TranscriptBlock, { kind: 'media' }>): string | undefined {
	return block.url ?? dataUrl(block.mimeType, block.data);
}

function lightboxMedia(src: string, mimeType: string): LightboxMedia | undefined {
	if (mimeType.startsWith('image/')) return { src, alt: 'Generated image', type: 'image' };
	if (mimeType.startsWith('video/')) return { src, alt: 'Generated video', type: 'video' };
	return undefined;
}

/** Generated image or video as an Astryx Thumbnail that opens the Lightbox. */
function VisualMedia({ media }: { media: LightboxMedia }) {
	const lightbox = useLightbox({ media, hasZoom: media.type === 'image' });
	return (
		<>
			<Thumbnail
				src={media.type === 'image' ? media.src : undefined}
				alt={media.alt}
				label={media.alt}
				onClick={() => lightbox.open()}
			/>
			{lightbox.element}
		</>
	);
}

function MediaBlock({ block }: { block: Extract<TranscriptBlock, { kind: 'media' }> }) {
	const src = mediaSrc(block);
	if (!src) return <Text color="secondary">{block.mimeType}</Text>;
	const visual = lightboxMedia(src, block.mimeType);
	if (visual) return <VisualMedia media={visual} />;
	if (block.mimeType.startsWith('audio/')) {
		// biome-ignore lint/a11y/useMediaCaption: model audio output
		return <audio controls preload="metadata" src={src} />;
	}
	return <Text color="secondary">{block.mimeType}</Text>;
}

function Sources({ block }: { block: Extract<TranscriptBlock, { kind: 'grounding' | 'evidence' }> }) {
	const chips = chipsFromBlock(block);
	if (chips.length === 0) return null;
	return (
		<HStack gap={1} wrap="wrap" aria-label="Sources">
			{chips.map((chip) => (
				<Token key={chip.key} label={chip.label} description={chip.kind} href={chip.href} size="sm" />
			))}
		</HStack>
	);
}

function BodyBlock({ block, streaming }: { block: TranscriptBlock; streaming: boolean }) {
	switch (block.kind) {
		case 'text':
			return <Markdown isStreaming={streaming}>{block.text}</Markdown>;
		case 'error':
			return <Banner status="error" title={block.message} />;
		case 'grounding':
		case 'evidence':
			return <Sources block={block} />;
		case 'structured':
			return <CodeBlock code={JSON.stringify(block.value, null, 2)} language="json" size="sm" />;
		case 'media':
			return <MediaBlock block={block} />;
		case 'tool':
			return <ToolCall tool={block.tool} />;
		default:
			return null;
	}
}

function toolStatus(phase: string | undefined): ChatToolCallItem['status'] {
	if (phase === 'complete') return 'complete';
	if (phase === 'error') return 'error';
	if (phase === 'running' || phase === 'progress') return 'running';
	return 'pending';
}

function toolCallItem(id: string, tool: ToolBlock['tool']): ChatToolCallItem {
	const detail = tool.failure ?? tool.output;
	return {
		key: id,
		name: tool.name,
		status: toolStatus(tool.phase),
		...(tool.failure !== undefined ? { errorMessage: JSON.stringify(tool.failure) } : {}),
		...(detail !== undefined
			? {
					resultDetail: (
						<CodeBlock code={JSON.stringify(detail, null, 2)} language="json" size="sm" />
					),
				}
			: {}),
	};
}

function ToolCall({ tool }: { tool: ToolBlock['tool'] }) {
	return <ChatToolCalls calls={[toolCallItem(tool.name, tool)]} />;
}

/** Consecutive tool items collapse into one ChatToolCalls group. */
function TraceList({ items }: { items: readonly TraceItem[] }) {
	const rows: ReactNode[] = [];
	let tools: ChatToolCallItem[] = [];
	const flush = () => {
		if (tools.length === 0) return;
		rows.push(<ChatToolCalls key={tools[0]?.key} calls={tools} />);
		tools = [];
	};
	for (const item of items) {
		if (item.kind === 'tool') {
			tools.push(toolCallItem(item.id, item.block.tool));
			continue;
		}
		flush();
		rows.push(
			<Text key={item.id} size="sm" color="secondary" as="div">
				<Markdown density="compact">{item.text}</Markdown>
			</Text>,
		);
	}
	flush();
	return <VStack gap={2}>{rows}</VStack>;
}

function GateCard({ block, handlers }: { block: ToolBlock; handlers: BlockHandlers }) {
	const { tool } = block;
	if (!tool.gate) return null;
	const index = handlers.indexOf(block);
	if (tool.gate.kind === 'auth') {
		return (
			<AuthChallengeCard
				gate={tool.gate}
				toolName={tool.name}
				onSubmitCredential={(slot, credential) => handlers.onAuthCredential?.(index, slot, credential)}
			/>
		);
	}
	return (
		<ApprovalCard
			gate={tool.gate}
			toolName={tool.name}
			input={tool.arguments}
			onDecision={(action) => handlers.onToolDecision?.(index, action)}
		/>
	);
}

function AssistantTurn(props: {
	blocks: TranscriptBlock[];
	handle: string;
	streaming: boolean;
	at: number;
	/** When the user's message went out; unknown for loaded history. */
	startedAt?: number;
	/** When this reply finished streaming. */
	endedAt?: number;
	onBranch?: () => void;
	handlers: BlockHandlers;
}) {
	const [traceOpen, setTraceOpen] = useState(false);
	const now = useSecondTicker(props.streaming && props.startedAt !== undefined);
	const end = props.streaming ? now : props.endedAt;
	const elapsedMs = props.startedAt !== undefined && end !== undefined ? end - props.startedAt : undefined;
	const { trace, gatedTools, body, hasTrace } = composeAssistantTurn(props.blocks, {
		streaming: props.streaming,
	});
	const status = workStatusLabel({ streaming: props.streaming, hasTrace, elapsedMs });
	const copyText = assistantTurnCopyText(body.length > 0 ? body : props.blocks);

	return (
		<ChatMessage
			sender="assistant"
			name={props.handle}
			metadata={
				props.streaming ? undefined : (
					<MessageChrome at={props.at} copyText={copyText} onBranch={props.onBranch} />
				)
			}
		>
			<VStack gap={3} width="100%">
					{status && !hasTrace ? (
						<Text size="sm" color="secondary">
							{status}
						</Text>
					) : null}
					{status && hasTrace ? (
						<Collapsible
							trigger={
								<Text size="sm" color="secondary">
									{status}
								</Text>
							}
							isOpen={traceOpen}
							onOpenChange={setTraceOpen}
						>
							<TraceList items={trace} />
						</Collapsible>
					) : null}
					{gatedTools.map((block) => (
						<GateCard key={block.id} block={block} handlers={props.handlers} />
					))}
					{body.map((block, i) => (
						<BodyBlock
							key={block.id}
							block={block}
							streaming={props.streaming && i === body.length - 1}
						/>
					))}
			</VStack>
		</ChatMessage>
	);
}

function UserTurn(props: { blocks: TranscriptBlock[]; at: number; onBranch?: () => void }) {
	const copyText = props.blocks.map(transcriptBlockCopyText).filter(Boolean).join('\n\n');
	const chrome = <MessageChrome at={props.at} copyText={copyText} onBranch={props.onBranch} />;
	// Astryx: metadata goes on the last bubble, or on the message when the last
	// content is unbubbled (an attachment or voice note).
	const last = props.blocks.at(-1);
	const lastIsBubble = last?.kind === 'user-text';
	return (
		<ChatMessage sender="user" metadata={lastIsBubble ? undefined : chrome}>
			{props.blocks.map((block) => (
				<UserBlock key={block.id} block={block} metadata={block === last && lastIsBubble ? chrome : undefined} />
			))}
		</ChatMessage>
	);
}

/** Theorem transcript blocks rendered as Astryx chat messages. */
export function ChatTranscript({
	blocks,
	handle,
	streaming = false,
	onBranch,
	onToolDecision,
	onAuthCredential,
	emptyState,
}: ChatTranscriptProps) {
	const groups = useMemo(() => groupTranscriptBlocks(blocks), [blocks]);
	const timeOf = useBlockTimes(blocks);
	const lastUserKey = groups.findLast((group) => group.kind === 'user')?.key;
	const turnEnds = useTurnEndTimes(streaming, lastUserKey);
	const handlers: BlockHandlers = {
		indexOf: (block) => blocks.findIndex((entry) => entry.id === block.id),
		onToolDecision,
		onAuthCredential,
	};
	const branchAt = (block: TranscriptBlock | undefined) =>
		onBranch && block ? () => onBranch(handlers.indexOf(block)) : undefined;

	return (
		<ChatMessageList isStreaming={streaming} emptyState={emptyState}>
			{groups.map((group, i) => {
				const at = timeOf(group.blocks[0]?.id ?? group.key);
				const last = group.blocks.at(-1);
				if (group.kind === 'user') {
					return <UserTurn key={group.key} blocks={group.blocks} at={at} onBranch={branchAt(last)} />;
				}
				const live = streaming && i === groups.length - 1;
				const prompt = groups[i - 1];
				const endedAt = prompt?.kind === 'user' ? turnEnds.get(prompt.key) : undefined;
				// Only turns sent in this session are timed; loaded history has no end.
				const startedAt =
					prompt?.kind === 'user' && (live || endedAt !== undefined)
						? timeOf(prompt.blocks[0]?.id ?? prompt.key)
						: undefined;
				return (
					<AssistantTurn
						key={group.key}
						blocks={group.blocks}
						handle={handle}
						streaming={live}
						at={at}
						startedAt={startedAt}
						endedAt={endedAt}
						onBranch={live ? undefined : branchAt(last)}
						handlers={handlers}
					/>
				);
			})}
		</ChatMessageList>
	);
}
