import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { Banner } from '@astryxdesign/core/Banner';
import {
	ChatMessage,
	ChatMessageBubble,
	ChatMessageList,
	ChatMessageMetadata,
	type ChatToolCallItem,
	ChatToolCalls,
} from '@astryxdesign/core/Chat';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { type LightboxMedia, useLightbox } from '@astryxdesign/core/Lightbox';
import { useStreamingText } from '@astryxdesign/core/hooks';
import { Markdown, type MarkdownComponents } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconCheck, IconCopy } from '@tabler/icons-react';
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
import { VoiceNote } from './VoiceNote';

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

export type ChatTranscriptProps = {
	blocks: readonly TranscriptBlock[];
	/** Assistant display name (profile handle). */
	handle: string;
	streaming?: boolean;
	onToolDecision?: (index: number, action: ToolDecision, interactiveValue?: unknown) => void;
	onAuthCredential?: (index: number, slot: string, credential: ToolCredential) => void;
	emptyState?: ReactNode;
	/**
	 * Set for image profiles: generated images show large, framed to their own
	 * aspect ratio, with a matching skeleton while one generates.
	 */
	imageOutput?: ImageOutput;
};

/** Image-profile display: `ratio` is the profile's pinned aspect ratio, if any. */
export type ImageOutput = { ratio?: number };

/** Largest a generated image renders in the transcript. */
const GENERATED_IMAGE_MAX_WIDTH = 512;

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

function MessageChrome(props: { at: number; copyText: string }) {
	return (
		<ChatMessageMetadata timestamp={<MessageTime at={props.at} />} footer={<CopyButton text={props.copyText} />} />
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
		return <VoiceNote src={src} mimeType={block.mimeType} />;
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

type MediaTranscriptBlock = Extract<TranscriptBlock, { kind: 'media' }>;

/** Full-size media for the Lightbox, and the smaller copy (if any) for its Thumbnail. */
type GalleryItem = { media: LightboxMedia; preview: string };

/** Image or video media: shown as Thumbnails in a gallery row, not as its own body row. */
function galleryItemOf(block: TranscriptBlock): GalleryItem | undefined {
	if (block.kind !== 'media') return undefined;
	const src = mediaSrc(block);
	const media = src ? lightboxMedia(src, block.mimeType) : undefined;
	return media ? { media, preview: block.previewUrl ?? media.src } : undefined;
}

/**
 * Consecutive images and videos as one wrapping row of Astryx Thumbnails that
 * share a Lightbox gallery (Astryx's `useLightbox({ media: [...] })` pattern).
 */
function MediaGallery({ items }: { items: GalleryItem[] }) {
	const lightbox = useLightbox({ media: items.map((item) => item.media), hasZoom: true });
	return (
		<HStack gap={2} wrap="wrap">
			{items.map(({ media: item, preview }, i) => (
				<Thumbnail
					key={item.src}
					src={item.type === 'image' ? preview : undefined}
					alt={item.alt}
					label={item.alt}
					onClick={() => lightbox.open(i)}
				/>
			))}
			{lightbox.element}
		</HStack>
	);
}

/** One generated image, framed to its natural ratio once loaded (the pinned ratio until then). */
function GeneratedImage(props: { item: GalleryItem; ratio?: number; onOpen: () => void }) {
	const [natural, setNatural] = useState<number>();
	return (
		<ClickableCard label="Open generated image" onClick={props.onOpen} padding={0} width="100%" maxWidth={GENERATED_IMAGE_MAX_WIDTH}>
			<AspectRatio ratio={natural ?? props.ratio ?? 1} fit="cover">
				<img
					src={props.item.preview}
					alt={props.item.media.alt}
					onLoad={(event) => {
						const { naturalWidth, naturalHeight } = event.currentTarget;
						if (naturalWidth > 0 && naturalHeight > 0) setNatural(naturalWidth / naturalHeight);
					}}
				/>
			</AspectRatio>
		</ClickableCard>
	);
}

/**
 * Image-profile gallery: images are the answer, so they show large at their
 * own ratio. Anything else (video) keeps the square Thumbnail.
 */
function GeneratedGallery({ items, ratio }: { items: GalleryItem[]; ratio?: number }) {
	const lightbox = useLightbox({ media: items.map((item) => item.media), hasZoom: true });
	return (
		<VStack gap={2} width="100%">
			{items.map((item, i) =>
				item.media.type === 'image' ? (
					<GeneratedImage key={item.media.src} item={item} ratio={ratio} onOpen={() => lightbox.open(i)} />
				) : (
					<Thumbnail key={item.media.src} alt={item.media.alt} label={item.media.alt} onClick={() => lightbox.open(i)} />
				),
			)}
			{lightbox.element}
		</VStack>
	);
}

/** Placeholder shaped like the image being generated. */
function GeneratingImage({ ratio }: { ratio?: number }) {
	return (
		<VStack width="100%" maxWidth={GENERATED_IMAGE_MAX_WIDTH}>
			<AspectRatio ratio={ratio ?? 1}>
				<Skeleton width="100%" height="100%" radius={3} aria-label="Generating image" />
			</AspectRatio>
		</VStack>
	);
}

function MediaBlock({ block }: { block: MediaTranscriptBlock }) {
	const src = mediaSrc(block);
	if (src && block.mimeType.startsWith('audio/')) {
		return <VoiceNote src={src} mimeType={block.mimeType} />;
	}
	return <Text color="secondary">{block.mimeType}</Text>;
}

type BodyRow = { kind: 'block'; block: TranscriptBlock } | { kind: 'gallery'; items: GalleryItem[] };

/** Runs of images/videos become one gallery row; everything else is a row of its own. */
function bodyRows(body: readonly TranscriptBlock[]): BodyRow[] {
	const rows: BodyRow[] = [];
	for (const block of body) {
		const item = galleryItemOf(block);
		const last = rows.at(-1);
		if (item && last?.kind === 'gallery') last.items.push(item);
		else if (item) rows.push({ kind: 'gallery', items: [item] });
		else rows.push({ kind: 'block', block });
	}
	return rows;
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

/**
 * Streamed text (the reply, or the latest thought). Guardrails release text in batches (the last one when
 * the stream closes), and Astryx's reveal snaps to the full text once
 * `isStreaming` goes false — so keep the reveal on until Astryx's own
 * `useStreamingText` has caught up with everything received.
 */
function StreamedMarkdown({
	text,
	streaming,
	density,
	components,
}: {
	text: string;
	streaming: boolean;
	density?: 'compact';
	components?: Partial<MarkdownComponents>;
}) {
	const [revealing, setRevealing] = useState(streaming);
	if (streaming && !revealing) setRevealing(true);
	const shown = useStreamingText(text, revealing);
	useEffect(() => {
		if (!streaming && shown.length >= text.length) setRevealing(false);
	}, [streaming, shown, text]);
	return (
		<Markdown isStreaming={revealing} density={density} components={components}>
			{text}
		</Markdown>
	);
}

function BodyBlock({ block, streaming }: { block: TranscriptBlock; streaming: boolean }) {
	switch (block.kind) {
		case 'text':
			return <StreamedMarkdown text={block.text} streaming={streaming} />;
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
/**
 * Thinking reads as quieter text than the reply. Astryx has no reasoning
 * component, and Markdown draws its own Text, so restyle through its
 * documented `components` seam.
 */
const THOUGHT_MARKDOWN: Partial<MarkdownComponents> = {
	paragraph: ({ children }) => (
		<Text size="sm" color="secondary" display="block" as="p">
			{children}
		</Text>
	),
	heading: ({ children }) => (
		<Text size="sm" color="secondary" weight="semibold" display="block" as="p">
			{children}
		</Text>
	),
};

function TraceList({ items, streaming }: { items: readonly TraceItem[]; streaming: boolean }) {
	const rows: ReactNode[] = [];
	let tools: ChatToolCallItem[] = [];
	const flush = () => {
		if (tools.length === 0) return;
		rows.push(<ChatToolCalls key={tools[0]?.key} calls={tools} />);
		tools = [];
	};
	for (const [i, item] of items.entries()) {
		if (item.kind === 'tool') {
			tools.push(toolCallItem(item.id, item.block.tool));
			continue;
		}
		flush();
		rows.push(
			<StreamedMarkdown
				key={item.id}
				text={item.text}
				streaming={streaming && i === items.length - 1}
				density="compact"
				components={THOUGHT_MARKDOWN}
			/>,
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
	handlers: BlockHandlers;
	imageOutput?: ImageOutput;
}) {
	// Open while the turn runs so its thinking and tool calls can be followed;
	// folds away when the turn ends.
	const [traceOpen, setTraceOpen] = useState(props.streaming);
	const [wasStreaming, setWasStreaming] = useState(props.streaming);
	if (wasStreaming !== props.streaming) {
		setWasStreaming(props.streaming);
		setTraceOpen(props.streaming);
	}
	const now = useSecondTicker(props.streaming && props.startedAt !== undefined);
	const end = props.streaming ? now : props.endedAt;
	const elapsedMs = props.startedAt !== undefined && end !== undefined ? end - props.startedAt : undefined;
	const { trace, gatedTools, body, hasTrace } = composeAssistantTurn(props.blocks);
	const rows = bodyRows(body);
	const status = workStatusLabel({ streaming: props.streaming, hasTrace, elapsedMs });
	const copyText = assistantTurnCopyText(body.length > 0 ? body : props.blocks);

	return (
		<ChatMessage
			sender="assistant"
			name={props.handle}
			metadata={
				props.streaming ? undefined : (
					<MessageChrome at={props.at} copyText={copyText} />
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
							<TraceList items={trace} streaming={props.streaming} />
						</Collapsible>
					) : null}
					{gatedTools.map((block) => (
						<GateCard key={block.id} block={block} handlers={props.handlers} />
					))}
					{rows.map((row, i) =>
						row.kind === 'gallery' && props.imageOutput ? (
							<GeneratedGallery key={i} items={row.items} ratio={props.imageOutput.ratio} />
						) : row.kind === 'gallery' ? (
							<MediaGallery key={i} items={row.items} />
						) : (
							<BodyBlock
								// By position: the committed turn re-mints block ids, and a
								// remount would cut the text reveal short.
								key={i}
								block={row.block}
								streaming={props.streaming && i === rows.length - 1}
							/>
						),
					)}
					{props.imageOutput && props.streaming && !rows.some((row) => row.kind === 'gallery') ? (
						<GeneratingImage ratio={props.imageOutput.ratio} />
					) : null}
			</VStack>
		</ChatMessage>
	);
}

function UserTurn(props: { blocks: TranscriptBlock[]; at: number }) {
	const copyText = props.blocks.map(transcriptBlockCopyText).filter(Boolean).join('\n\n');
	const chrome = <MessageChrome at={props.at} copyText={copyText} />;
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
	onToolDecision,
	onAuthCredential,
	emptyState,
	imageOutput,
}: ChatTranscriptProps) {
	const groups = useMemo(() => groupTranscriptBlocks(blocks), [blocks]);
	const timeOf = useBlockTimes(blocks);
	const lastUserKey = groups.findLast((group) => group.kind === 'user')?.key;
	const turnEnds = useTurnEndTimes(streaming, lastUserKey);
	const pendingPrompt = groups.at(-1)?.kind === 'user' ? groups.at(-1) : undefined;
	const handlers: BlockHandlers = {
		indexOf: (block) => blocks.findIndex((entry) => entry.id === block.id),
		onToolDecision,
		onAuthCredential,
	};

	return (
		<ChatMessageList isStreaming={streaming} emptyState={emptyState}>
			{groups.map((group, i) => {
				const at = timeOf(group.blocks[0]?.id ?? group.key);
				if (group.kind === 'user') {
					return <UserTurn key={group.key} blocks={group.blocks} at={at} />;
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
						// Keyed by its prompt, not its blocks: the reply stays mounted from the
						// "Working…" placeholder through streaming and commit (which re-keys blocks).
						key={prompt?.kind === 'user' ? `${prompt.key}:reply` : group.key}
						blocks={group.blocks}
						handle={handle}
						streaming={live}
						at={at}
						startedAt={startedAt}
						endedAt={endedAt}
						handlers={handlers}
						imageOutput={imageOutput}
					/>
				);
			})}
			{/* Nothing streamed back yet: show the reply's "Working…" status right away. */}
			{streaming && pendingPrompt ? (
				<AssistantTurn
					key={`${pendingPrompt.key}:reply`}
					blocks={[]}
					handle={handle}
					streaming
					at={timeOf(pendingPrompt.blocks[0]?.id ?? pendingPrompt.key)}
					startedAt={timeOf(pendingPrompt.blocks[0]?.id ?? pendingPrompt.key)}
					handlers={handlers}
					imageOutput={imageOutput}
				/>
			) : null}
		</ChatMessageList>
	);
}
