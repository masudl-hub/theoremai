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
import { Citation } from '@astryxdesign/core/Citation';
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
import { citationsFromBlock, type SourceCitationBlock } from '../client/source-citations';
import {
	assistantTurnCopyText,
	assistantTurnTiming,
	composeAssistantTurn,
	groupTranscriptBlocks,
	pendingPromptOf,
	promptReplyKey,
	replyKey,
	type TraceItem,
	type TurnSpan,
	workStatus,
} from '../client/transcript-groups';
import { type LabelText, workStatusLabel } from './labels';
import { TheoremLabelsProvider, useLabels } from './labels-provider';
import { transcriptBlockCopyText } from './transcript-copy-text';
import { ApprovalCard, AuthChallengeCard, type ToolDecision } from './ToolGateCard';
import { VoiceNote } from './VoiceNote';

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

export type ChatTranscriptProps = {
	blocks: readonly TranscriptBlock[];
	/** Assistant display name (profile handle). */
	handle: string;
	streaming?: boolean;
	onToolDecision?: (index: number, action: ToolDecision, interactiveValue?: unknown) => void;
	/** Signed in at a gate: `secret` is a key the user typed; after an OAuth callback there is none. */
	onAuthenticated?: (index: number, secret?: string) => void;
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
	onAuthenticated?: ChatTranscriptProps['onAuthenticated'];
};

/** First-seen time per group key, so timestamps don't jump while streaming. */
function useFirstSeen(keys: readonly string[]): (key: string) => number {
	const times = useRef(new Map<string, number>());
	const now = Date.now();
	for (const key of keys) {
		if (!times.current.has(key)) times.current.set(key, now);
	}
	return (key) => times.current.get(key) ?? now;
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
 * Each turn's span, keyed by the user group that started it. A turn stops at
 * a gate and streams again under the same prompt once it's answered; the wait
 * in between counts as paused, not worked.
 */
function useTurnSpans(streaming: boolean, lastUserKey: string | undefined): ReadonlyMap<string, TurnSpan> {
	const spans = useRef(new Map<string, TurnSpan>());
	// The first send mounts the transcript already streaming; that's the start.
	const wasStreaming = useRef(false);
	if (lastUserKey && streaming !== wasStreaming.current) {
		const now = Date.now();
		const span = spans.current.get(lastUserKey);
		if (streaming) {
			const pausedMs = span?.endedAt === undefined ? 0 : span.pausedMs + now - span.endedAt;
			spans.current.set(lastUserKey, { pausedMs });
		} else if (span) {
			spans.current.set(lastUserKey, { ...span, endedAt: now });
		}
	}
	wasStreaming.current = streaming;
	return spans.current;
}

function CopyButton({ text }: { text: string }) {
	const t = useLabels();
	const [copied, setCopied] = useState(false);
	if (!text.trim()) return null;
	const label = t(copied ? '@theorem.transcript.copied' : '@theorem.transcript.copy');
	return (
		<IconButton
			label={label}
			tooltip={label}
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
	const t = useLabels();
	const [isFresh, setIsFresh] = useState(() => Date.now() - at < MINUTE_MS);
	useEffect(() => {
		if (!isFresh) return;
		const timer = globalThis.setTimeout(() => setIsFresh(false), Math.max(0, at + MINUTE_MS - Date.now()));
		return () => globalThis.clearTimeout(timer);
	}, [isFresh, at]);
	if (isFresh) {
		return (
			<Text type="supporting" color="secondary">
				{t('@theorem.transcript.now')}
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

type UserFileBlock = Extract<TranscriptBlock, { kind: 'user-attachment' | 'user-voice' }>;

function UserBlock({ block, metadata }: { block: TranscriptBlock; metadata?: ReactNode }) {
	if (block.kind === 'user-text') return <ChatMessageBubble metadata={metadata}>{block.text}</ChatMessageBubble>;
	if (block.kind !== 'user-attachment' && block.kind !== 'user-voice') return null;
	return <UserFile block={block} />;
}

/** An attached image or voice note inline; any other file as a Token. */
function UserFile({ block }: { block: UserFileBlock }) {
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

function lightboxMedia(t: LabelText, src: string, mimeType: string): LightboxMedia | undefined {
	if (mimeType.startsWith('image/')) return { src, alt: t('@theorem.transcript.generated_image'), type: 'image' };
	if (mimeType.startsWith('video/')) return { src, alt: t('@theorem.transcript.generated_video'), type: 'video' };
	return undefined;
}

type MediaTranscriptBlock = Extract<TranscriptBlock, { kind: 'media' }>;

/** Full-size media for the Lightbox, and the smaller copy (if any) for its Thumbnail. */
type GalleryItem = { media: LightboxMedia; preview: string };

/** Image or video media: shown as Thumbnails in a gallery row, not as its own body row. */
function galleryItemOf(t: LabelText, block: TranscriptBlock): GalleryItem | undefined {
	if (block.kind !== 'media') return undefined;
	const src = mediaSrc(block);
	const media = src ? lightboxMedia(t, src, block.mimeType) : undefined;
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
	const t = useLabels();
	const [natural, setNatural] = useState<number>();
	return (
		<ClickableCard label={t('@theorem.transcript.open_generated_image')} onClick={props.onOpen} padding={0} width="100%" maxWidth={GENERATED_IMAGE_MAX_WIDTH}>
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
	const t = useLabels();
	return (
		<VStack width="100%" maxWidth={GENERATED_IMAGE_MAX_WIDTH}>
			<AspectRatio ratio={ratio ?? 1}>
				<Skeleton width="100%" height="100%" radius={3} aria-label={t('@theorem.transcript.generating_image')} />
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
function bodyRows(t: LabelText, body: readonly TranscriptBlock[]): BodyRow[] {
	const rows: BodyRow[] = [];
	for (const block of body) {
		const item = galleryItemOf(t, block);
		const last = rows.at(-1);
		if (item && last?.kind === 'gallery') last.items.push(item);
		else if (item) rows.push({ kind: 'gallery', items: [item] });
		else rows.push({ kind: 'block', block });
	}
	return rows;
}

function Sources({ block }: { block: SourceCitationBlock }) {
	const t = useLabels();
	const citations = citationsFromBlock(block);
	if (citations.length === 0) return null;
	return (
		<HStack gap={1} wrap="wrap" aria-label={t('@theorem.transcript.sources')}>
			{citations.map((citation, i) => (
				<Citation
					key={citation.key}
					source={{ title: citation.title, url: citation.href, src: citation.icon }}
					number={i + 1}
				/>
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
	if (block.kind === 'text') return <StreamedMarkdown text={block.text} streaming={streaming} />;
	if (block.kind === 'tool') return <ToolCall tool={block.tool} />;
	return <ResultBlock block={block} />;
}

/** Non-streaming answer rows: errors, sources, structured output and media. */
function ResultBlock({ block }: { block: TranscriptBlock }) {
	switch (block.kind) {
		case 'error':
			return <Banner status="error" title={block.message} />;
		case 'citation':
			return <Sources block={block} />;
		case 'structured':
			return <CodeBlock code={JSON.stringify(block.value, null, 2)} language="json" size="sm" />;
		case 'media':
			return <MediaBlock block={block} />;
		default:
			return null;
	}
}

function toolDetail(detail: unknown): ReactNode {
	return <CodeBlock code={JSON.stringify(detail, null, 2)} language="json" size="sm" />;
}

function toolCallItem(id: string, tool: ToolBlock['tool']): ChatToolCallItem {
	const base = { key: id, name: tool.name };
	const { state } = tool;
	switch (state?.phase) {
		case 'error':
			return {
				...base,
				status: 'error',
				errorMessage: JSON.stringify(state.failure),
				resultDetail: toolDetail(state.failure),
			};
		case 'complete':
			return {
				...base,
				status: 'complete',
				...(state.output !== undefined ? { resultDetail: toolDetail(state.output) } : {}),
			};
		case 'running':
			return { ...base, status: 'running' };
		default:
			return { ...base, status: 'pending' };
	}
}

function ToolCall({ tool }: { tool: ToolBlock['tool'] }) {
	return <ChatToolCalls calls={[toolCallItem(tool.name, tool)]} />;
}

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
	if (tool.state?.phase !== 'gate') return null;
	const { gate } = tool.state;
	const index = handlers.indexOf(block);
	if (gate.kind === 'auth') {
		return (
			<AuthChallengeCard
				gate={gate}
				toolName={tool.name}
				onAuthenticated={(secret) => handlers.onAuthenticated?.(index, secret)}
			/>
		);
	}
	return (
		<ApprovalCard
			gate={gate}
			toolName={tool.name}
			input={tool.arguments}
			onDecision={(action) => handlers.onToolDecision?.(index, action)}
		/>
	);
}

/** Live elapsed time while the turn streams; its final duration once it ends. */
function useTurnElapsed(streaming: boolean, startedAt?: number, endedAt?: number): number | undefined {
	const now = useSecondTicker(streaming && startedAt !== undefined);
	const end = streaming ? now : endedAt;
	return startedAt !== undefined && end !== undefined ? end - startedAt : undefined;
}

/**
 * The turn's work status; with a trace, a Collapsible over its thinking and
 * tool calls, open while the turn runs so they can be followed, folded away
 * when it ends.
 */
function TurnStatus(props: { status: string; trace: readonly TraceItem[]; hasTrace: boolean; streaming: boolean }) {
	const { status, streaming } = props;
	const [traceOpen, setTraceOpen] = useState(streaming);
	const [wasStreaming, setWasStreaming] = useState(streaming);
	if (wasStreaming !== streaming) {
		setWasStreaming(streaming);
		setTraceOpen(streaming);
	}
	if (!status) return null;
	const label = (
		<Text size="sm" color="secondary">
			{status}
		</Text>
	);
	if (!props.hasTrace) return label;
	return (
		<Collapsible trigger={label} isOpen={traceOpen} onOpenChange={setTraceOpen}>
			<TraceList items={props.trace} streaming={streaming} />
		</Collapsible>
	);
}

function BodyRowView({ row, streaming, imageOutput }: { row: BodyRow; streaming: boolean; imageOutput?: ImageOutput }) {
	if (row.kind === 'block') return <BodyBlock block={row.block} streaming={streaming} />;
	if (imageOutput) return <GeneratedGallery items={row.items} ratio={imageOutput.ratio} />;
	return <MediaGallery items={row.items} />;
}

/** An image profile's placeholder until the turn's first image arrives. */
function PendingImage(props: { imageOutput?: ImageOutput; streaming: boolean; rows: readonly BodyRow[] }) {
	if (!props.imageOutput || !props.streaming || props.rows.some((row) => row.kind === 'gallery')) return null;
	return <GeneratingImage ratio={props.imageOutput.ratio} />;
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
	const t = useLabels();
	const elapsedMs = useTurnElapsed(props.streaming, props.startedAt, props.endedAt);
	const { trace, gatedTools, body, hasTrace } = composeAssistantTurn(props.blocks);
	const rows = bodyRows(t, body);
	const status = workStatusLabel(t, workStatus({ streaming: props.streaming, hasTrace, elapsedMs }));
	const copyText = assistantTurnCopyText(body.length > 0 ? body : props.blocks);

	return (
		<ChatMessage
			sender="assistant"
			name={props.handle}
			metadata={props.streaming ? undefined : <MessageChrome at={props.at} copyText={copyText} />}
		>
			<VStack gap={3} width="100%">
				<TurnStatus status={status} trace={trace} hasTrace={hasTrace} streaming={props.streaming} />
				{gatedTools.map((block) => (
					<GateCard key={block.id} block={block} handlers={props.handlers} />
				))}
				{rows.map((row, i) => (
					<BodyRowView
						// By position: the committed turn re-mints block ids, and a
						// remount would cut the text reveal short.
						key={i}
						row={row}
						streaming={props.streaming && i === rows.length - 1}
						imageOutput={props.imageOutput}
					/>
				))}
				<PendingImage imageOutput={props.imageOutput} streaming={props.streaming} rows={rows} />
			</VStack>
		</ChatMessage>
	);
}

function UserTurn(props: { blocks: TranscriptBlock[]; at: number }) {
	const t = useLabels();
	const copyText = props.blocks
		.map((block) => transcriptBlockCopyText(t, block))
		.filter(Boolean)
		.join('\n\n');
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
export function ChatTranscript(props: ChatTranscriptProps) {
	return (
		<TheoremLabelsProvider>
			<ChatTranscriptBody {...props} />
		</TheoremLabelsProvider>
	);
}

function ChatTranscriptBody({
	blocks,
	handle,
	streaming = false,
	onToolDecision,
	onAuthenticated,
	emptyState,
	imageOutput,
}: ChatTranscriptProps) {
	const groups = useMemo(() => groupTranscriptBlocks(blocks), [blocks]);
	const timeOf = useFirstSeen(
		groups.map((group, index) => (group.kind === 'user' ? group.key : replyKey(groups, index))),
	);
	const spans = useTurnSpans(streaming, groups.findLast((group) => group.kind === 'user')?.key);
	const pendingPrompt = streaming ? pendingPromptOf(groups) : undefined;
	const handlers: BlockHandlers = {
		indexOf: (block) => blocks.findIndex((entry) => entry.id === block.id),
		onToolDecision,
		onAuthenticated,
	};
	const turn = { handle, handlers, imageOutput };

	const turns = groups.map((group, index) => {
		if (group.kind === 'user') return <UserTurn key={group.key} blocks={group.blocks} at={timeOf(group.key)} />;
		const { key, live, ...timing } = assistantTurnTiming({ groups, index, streaming, timeOf, spans });
		// A reply is dated when it last stopped: a reply that just finished reads "now".
		const at = timing.endedAt ?? timeOf(key);
		return <AssistantTurn key={key} {...turn} {...timing} blocks={group.blocks} streaming={live} at={at} />;
	});
	// Nothing streamed back yet: show the reply's "Working…" status right away.
	// It sits in the same keyed list as the streamed reply, so the reply stays
	// one message; a remount would read to the layout as a new message.
	if (pendingPrompt) {
		turns.push(
			<AssistantTurn
				key={promptReplyKey(pendingPrompt)}
				{...turn}
				blocks={[]}
				streaming
				at={timeOf(pendingPrompt.key)}
				startedAt={timeOf(pendingPrompt.key)}
			/>,
		);
	}

	return (
		<ChatMessageList isStreaming={streaming} emptyState={emptyState}>
			{turns}
		</ChatMessageList>
	);
}
