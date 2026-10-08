import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  type ChatMessageStatus,
  ChatSystemMessage,
  type ChatToolCallItem,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import { Citation } from '@astryxdesign/core/Citation';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { useStreamingText } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { useLocale } from '@astryxdesign/core/i18n';
import { type LightboxMedia, useLightbox } from '@astryxdesign/core/Lightbox';
import { Markdown, type MarkdownComponents } from '@astryxdesign/core/Markdown';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { citationsFromBlock, type SourceCitationBlock } from '../client/source-citations.ts';
import type { AnsweringGate } from '../client/tool-resume.ts';
import {
  assistantTurnCopyText,
  assistantTurnTiming,
  composeAssistantTurn,
  groupTranscriptBlocks,
  pendingPromptOf,
  promptReplyKey,
  promptTime,
  replyKey,
  type TraceItem,
  type TranscriptTurnGroup,
  type TurnSpan,
  type TurnUsage,
  toolCallLabel,
  workStatus,
} from '../client/transcript-groups.ts';
import { useSecondTicker } from '../hooks/use-second-ticker.ts';
import { useDisclosureMotion } from './disclosure-motion.ts';
import { type LabelText, usageLine, workDuration, workStatusLabel } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { useMarkdownPlugins } from './markdown-plugins.tsx';
import { keyedByContent } from './row-keys.ts';
import { ShapedData } from './ShapedData.tsx';
import { ApprovalCard, AuthChallengeCard, type ToolDecision } from './ToolGateCard.tsx';
import { transcriptBlockCopyText } from './transcript-copy-text.ts';
import { VoiceNote } from './VoiceNote.tsx';

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

export type ChatTranscriptProps = {
  blocks: readonly TranscriptBlock[];
  /** Assistant display name (profile handle). */
  handle: string;
  streaming?: boolean;
  /** How far the latest message has got; shown on it unless its turn failed. */
  delivery?: Exclude<ChatMessageStatus, 'error'> | null;
  onToolDecision?: (index: number, action: ToolDecision) => void;
  /** The answer on its way to a gate (`useTheoremChat().answering`). */
  answering?: AnsweringGate | null;
  /** Signed in at a gate: `secret` is a key the user typed; after an OAuth callback there is none. */
  onAuthenticated?: (index: number, secret?: string) => void;
  emptyState?: ReactNode;
  /**
   * Labelled dividers, keyed by block id: each is drawn above the turn that
   * starts at its block, and that block always starts a turn of its own.
   */
  dividers?: Readonly<Record<string, string>>;
  /**
   * Set for image profiles: generated images show large, framed to their own
   * aspect ratio, with a matching skeleton while one generates.
   */
  imageOutput?: ImageOutput;
  /**
   * Show what was used, as tokens and cost: each reply's total under it, and
   * on an agent tool's call row what the agent it ran used. Off by default.
   */
  usage?: boolean;
};

/** Whether the transcript shows usage (`ChatTranscriptProps.usage`). */
const ShowUsage = createContext(false);

/** Image-profile display: `ratio` is the profile's pinned aspect ratio, if any. */
export type ImageOutput = { ratio?: number };

/** Largest a generated image renders in the transcript. */
const GENERATED_IMAGE_MAX_WIDTH = 512;

type BlockHandlers = {
  indexOf: (block: TranscriptBlock) => number;
  answering: AnsweringGate | null;
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

/**
 * Each turn's span, keyed by the user group that started it. A turn stops at
 * a gate and streams again under the same prompt once it's answered; the wait
 * in between counts as paused, not worked.
 */
function useTurnSpans(
  streaming: boolean,
  lastUserKey: string | undefined,
): ReadonlyMap<string, TurnSpan> {
  const spans = useRef(new Map<string, TurnSpan>());
  // why: The first send mounts the transcript already streaming; that's the start.
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
    const timer = globalThis.setTimeout(
      () => setIsFresh(false),
      Math.max(0, at + MINUTE_MS - Date.now()),
    );
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

/** What a reply or a called agent used, in the viewer's locale. */
function Usage({ tokens }: { tokens: TurnUsage }) {
  return usageLine(useLabels(), useLocale(), tokens);
}

/** A stopped message's status, drawn as the delivery statuses are. */
function Interrupted() {
  const label = useLabels()('@theorem.transcript.interrupted');
  return (
    <HStack gap={1} vAlign="center">
      <Icon icon="stop" size="xsm" color="inherit" />
      <span>{label}</span>
    </HStack>
  );
}

/** A failed message's status, drawn as Astryx draws its error status; the reason shows on hover. */
function Failed({ reason }: { reason: string }) {
  const label = useLabels()('@theorem.transcript.failed');
  return (
    <HoverTip content={reason}>
      <HStack gap={1} vAlign="center" style={{ color: 'var(--color-error)' }}>
        <Icon icon="error" size="xsm" color="inherit" />
        <span>{label}</span>
      </HStack>
    </HoverTip>
  );
}

/** A message's copy button and time, the button on the outside: right for the person, left for the agent. */
function CopyAndTime(props: { sender: 'user' | 'assistant'; at: number; copyText: string }) {
  const copy = <CopyButton text={props.copyText} />;
  const time = <MessageTime at={props.at} />;
  return (
    <HStack gap={1} vAlign="center">
      {props.sender === 'user' ? time : copy}
      {props.sender === 'user' ? copy : time}
    </HStack>
  );
}

/** A message's copy button (outermost), time and status; a failure says why on hovering its status. */
function MessageChrome(props: {
  sender: 'user' | 'assistant';
  at: number;
  copyText: string;
  status?: ChatMessageStatus;
  /** The person stopped its turn: it says so where its status goes. */
  interrupted?: boolean;
  error?: string;
  /** What the reply used, when the transcript shows usage. */
  usage?: TurnUsage;
}) {
  const usage = props.usage ? <Usage tokens={props.usage} /> : undefined;
  const aside =
    props.error !== undefined ? (
      <Failed reason={props.error} />
    ) : props.interrupted ? (
      <Interrupted />
    ) : (
      usage
    );
  return (
    <ChatMessageMetadata
      // why: The row's first slot is the one nearest the margin.
      timestamp={<CopyAndTime sender={props.sender} at={props.at} copyText={props.copyText} />}
      // why: Astryx's statuses are a closed set, so these ride the footer.
      footer={aside}
      status={props.error !== undefined || props.interrupted ? undefined : props.status}
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

type UserFileBlock = Extract<TranscriptBlock, { kind: 'user-attachment' | 'user-voice' }>;

function UserBlock({ block, metadata }: { block: TranscriptBlock; metadata?: ReactNode }) {
  if (block.kind === 'user-text')
    return <ChatMessageBubble metadata={metadata}>{block.text}</ChatMessageBubble>;
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
  if (mimeType.startsWith('image/'))
    return { src, alt: t('@theorem.transcript.generated_image'), type: 'image' };
  if (mimeType.startsWith('video/'))
    return { src, alt: t('@theorem.transcript.generated_video'), type: 'video' };
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
    <ClickableCard
      label={t('@theorem.transcript.open_generated_image')}
      onClick={props.onOpen}
      padding={0}
      width="100%"
      maxWidth={GENERATED_IMAGE_MAX_WIDTH}
    >
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
          <GeneratedImage
            key={item.media.src}
            item={item}
            ratio={ratio}
            onOpen={() => lightbox.open(i)}
          />
        ) : (
          <Thumbnail
            key={item.media.src}
            alt={item.media.alt}
            label={item.media.alt}
            onClick={() => lightbox.open(i)}
          />
        ),
      )}
      {lightbox.element}
    </VStack>
  );
}

/** An image takes seconds: a slow, smooth breath rather than the Skeleton's quick stepped blink. */
const GENERATING_PULSE = {
  animationDuration: '1.8s',
  animationTimingFunction: 'ease-in-out',
} as const;

/** Placeholder shaped like the image being generated. */
function GeneratingImage({ ratio }: { ratio?: number }) {
  const t = useLabels();
  return (
    <VStack width="100%" maxWidth={GENERATED_IMAGE_MAX_WIDTH}>
      <AspectRatio ratio={ratio ?? 1}>
        <Skeleton
          width="100%"
          height="100%"
          radius={3}
          style={GENERATING_PULSE}
          aria-label={t('@theorem.transcript.generating_image')}
        />
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

type BodyRow =
  | { kind: 'block'; block: TranscriptBlock }
  | { kind: 'gallery'; items: GalleryItem[] };

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
  const plugins = useMarkdownPlugins();
  const shown = useStreamingText(text, revealing);
  useEffect(() => {
    if (!streaming && shown.length >= text.length) setRevealing(false);
  }, [streaming, shown, text]);
  return (
    <Markdown isStreaming={revealing} density={density} components={components} plugins={plugins}>
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
      return null;
    case 'citation':
      return <Sources block={block} />;
    case 'structured':
      return <ShapedData value={block.value} />;
    case 'media':
      return <MediaBlock block={block} />;
    default:
      return null;
  }
}

// why: Astryx sets a call's name in the code font; labels are sentences, so the row takes the body
// font and the detail restores the code font kept on the wrapper.
const CODE_FONT_KEPT = {
  display: 'contents',
  '--theorem-font-code': 'var(--font-family-code)',
} as CSSProperties;
const CODE_FONT_AS_BODY = { '--font-family-code': 'var(--font-family-body)' } as CSSProperties;
const CODE_FONT_RESTORED = { '--font-family-code': 'var(--theorem-font-code)' } as CSSProperties;

function ToolCalls({ calls }: { calls: ChatToolCallItem[] }) {
  return (
    <div style={CODE_FONT_KEPT}>
      <ChatToolCalls calls={calls} style={CODE_FONT_AS_BODY} />
    </div>
  );
}

/** A call's detail: what it ran with, then what came back. */
function toolDetail(t: LabelText, tool: ToolBlock['tool'], result?: ReactNode): ReactNode {
  const input = tool.edited ? (
    <ShapedData value={tool.edited.to} title={t('@theorem.transcript.tool_input_edited')} />
  ) : (
    <ShapedData value={tool.arguments} title={t('@theorem.transcript.tool_input')} />
  );
  return (
    <VStack gap={2} style={CODE_FONT_RESTORED}>
      <Text type="code" size="sm" color="secondary">
        {tool.name}
      </Text>
      {input}
      {result}
    </VStack>
  );
}

/** How long a finished call ran, when both ends were seen. */
function toolDuration(t: LabelText, tool: ToolBlock['tool']): { duration?: string } {
  if (tool.startedAt === undefined || tool.endedAt === undefined) return {};
  return { duration: workDuration(t, tool.endedAt - tool.startedAt) };
}

type SettledTool = Extract<
  NonNullable<ToolBlock['tool']['state']>,
  { phase: 'complete' | 'error' }
>;

/** What the agent an agent tool ran used, after the call's name. Only agent tools report it. */
function toolUsageStats(state: SettledTool, showUsage: boolean): { stats?: ReactNode } {
  return showUsage && state.tokens ? { stats: <Usage tokens={state.tokens} /> } : {};
}

function toolCallItem(
  t: LabelText,
  id: string,
  tool: ToolBlock['tool'],
  showUsage: boolean,
): ChatToolCallItem {
  const base = { key: id, name: toolCallLabel(tool) };
  const { state } = tool;
  switch (state?.phase) {
    case 'error':
      return {
        ...base,
        status: 'error',
        target: state.failure.message,
        ...toolUsageStats(state, showUsage),
        errorMessage: state.failure.message,
        resultDetail: toolDetail(
          t,
          tool,
          <ShapedData value={state.failure} title={t('@theorem.transcript.tool_error')} />,
        ),
      };
    case 'complete':
      return {
        ...base,
        status: 'complete',
        ...toolDuration(t, tool),
        ...toolUsageStats(state, showUsage),
        resultDetail: toolDetail(
          t,
          tool,
          state.output === undefined ? undefined : (
            <ShapedData value={state.output} title={t('@theorem.transcript.tool_output')} />
          ),
        ),
      };
    case 'running':
      return { ...base, status: 'running', resultDetail: toolDetail(t, tool) };
    default:
      return { ...base, status: 'pending', resultDetail: toolDetail(t, tool) };
  }
}

function ToolCall({ tool }: { tool: ToolBlock['tool'] }) {
  const t = useLabels();
  const showUsage = useContext(ShowUsage);
  return <ToolCalls calls={[toolCallItem(t, tool.name, tool, showUsage)]} />;
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
  const t = useLabels();
  const showUsage = useContext(ShowUsage);
  const rows: ReactNode[] = [];
  let tools: ChatToolCallItem[] = [];
  const flush = () => {
    if (tools.length === 0) return;
    rows.push(<ToolCalls key={tools[0]?.key} calls={tools} />);
    tools = [];
  };
  for (const [i, item] of items.entries()) {
    if (item.kind === 'tool') {
      tools.push(toolCallItem(t, item.id, item.block.tool, showUsage));
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

/** The gate a person decides. The page answers a page gate, so it has none. */
function personGate(tool: ToolBlock['tool']) {
  if (tool.state?.phase !== 'gate' || tool.state.gate.kind === 'page') return null;
  return tool.state.gate;
}

function GateCard({
  block,
  handle,
  handlers,
}: {
  block: ToolBlock;
  handle: string;
  handlers: BlockHandlers;
}) {
  const { tool } = block;
  const gate = personGate(tool);
  if (!gate) return null;
  const index = handlers.indexOf(block);
  const answer = handlers.answering?.callId === tool.callId ? handlers.answering.action : null;
  if (gate.kind === 'auth') {
    return (
      <AuthChallengeCard
        gate={gate}
        toolName={tool.name}
        submitted={answer === 'auth'}
        onAuthenticated={(secret) => handlers.onAuthenticated?.(index, secret)}
      />
    );
  }
  return (
    <ApprovalCard
      gate={gate}
      toolName={tool.name}
      agent={handle}
      input={tool.arguments}
      decided={answer === 'auth' ? null : answer}
      onDecision={(action) => handlers.onToolDecision?.(index, action)}
    />
  );
}

/** Live elapsed time while the turn streams; its final duration once it ends. */
/** Live: counted from the start. Stopped: the work its blocks record. */
function useTurnElapsed(
  streaming: boolean,
  startedAt?: number,
  workedMs?: number,
): number | undefined {
  const now = useSecondTicker(streaming && startedAt !== undefined);
  if (!streaming) return workedMs;
  return startedAt !== undefined ? now - startedAt : undefined;
}

/**
 * The turn's work status; with a trace, a Collapsible over its thinking and
 * tool calls, open while the turn runs so they can be followed, folded away
 * when it ends.
 */
function TurnStatus(props: {
  status: string;
  trace: readonly TraceItem[];
  hasTrace: boolean;
  streaming: boolean;
}) {
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

function BodyRowView({
  row,
  streaming,
  imageOutput,
}: {
  row: BodyRow;
  streaming: boolean;
  imageOutput?: ImageOutput;
}) {
  if (row.kind === 'block') return <BodyBlock block={row.block} streaming={streaming} />;
  if (imageOutput) return <GeneratedGallery items={row.items} ratio={imageOutput.ratio} />;
  return <MediaGallery items={row.items} />;
}

/** An image profile's placeholder until the turn's first image arrives. */
function PendingImage(props: {
  imageOutput?: ImageOutput;
  streaming: boolean;
  rows: readonly BodyRow[];
}) {
  if (!props.imageOutput || !props.streaming || props.rows.some((row) => row.kind === 'gallery'))
    return null;
  return <GeneratingImage ratio={props.imageOutput.ratio} />;
}

function AssistantTurn(props: {
  blocks: TranscriptBlock[];
  handle: string;
  streaming: boolean;
  at: number;
  /** While live: when the reply started, its approval waits skipped. */
  startedAt?: number;
  /** Once stopped: how long it worked. */
  workedMs?: number;
  handlers: BlockHandlers;
  imageOutput?: ImageOutput;
  /** Why the turn failed, if it did. */
  error?: string;
  /** What the reply used; shown when the transcript shows usage. */
  usage?: TurnUsage;
}) {
  const t = useLabels();
  const showUsage = useContext(ShowUsage);
  const elapsedMs = useTurnElapsed(props.streaming, props.startedAt, props.workedMs);
  const { trace, gatedTools, body, hasTrace } = composeAssistantTurn(props.blocks);
  const rows = bodyRows(t, body);
  const status = workStatusLabel(
    t,
    workStatus({ streaming: props.streaming, hasTrace, elapsedMs }),
  );
  const copyText = assistantTurnCopyText(body.length > 0 ? body : props.blocks);

  return (
    <ChatMessage
      sender="assistant"
      name={props.handle}
      metadata={
        props.streaming ? undefined : (
          <MessageChrome
            sender="assistant"
            at={props.at}
            copyText={copyText}
            error={props.error}
            usage={showUsage ? props.usage : undefined}
          />
        )
      }
    >
      <VStack gap={3} width="100%">
        <TurnStatus status={status} trace={trace} hasTrace={hasTrace} streaming={props.streaming} />
        {gatedTools.map((block) => (
          <GateCard key={block.id} block={block} handle={props.handle} handlers={props.handlers} />
        ))}
        {keyedByContent(rows, (row) => (row.kind === 'gallery' ? 'gallery' : row.block.kind)).map(
          ({ item: row, index: i, key }) => (
            <BodyRowView
              // why: Not the block id: the committed turn re-mints ids, and a
              // remount would cut the text reveal short.
              key={key}
              row={row}
              streaming={props.streaming && i === rows.length - 1}
              imageOutput={props.imageOutput}
            />
          ),
        )}
        <PendingImage imageOutput={props.imageOutput} streaming={props.streaming} rows={rows} />
      </VStack>
    </ChatMessage>
  );
}

function UserTurn(props: {
  blocks: TranscriptBlock[];
  at: number;
  status?: ChatMessageStatus;
  /** The person stopped its turn before any reply. */
  interrupted?: boolean;
  /** Why the turn failed before any reply. */
  error?: string;
}) {
  const t = useLabels();
  const copyText = props.blocks
    .map((block) => transcriptBlockCopyText(t, block))
    .filter(Boolean)
    .join('\n\n');
  const chrome = (
    <MessageChrome
      sender="user"
      at={props.at}
      copyText={copyText}
      status={props.status}
      interrupted={props.interrupted}
      error={props.error}
    />
  );
  // why: Astryx: metadata goes on the last bubble, or on the message when the last
  // content is unbubbled (an attachment or voice note).
  const last = props.blocks.at(-1);
  const lastIsBubble = last?.kind === 'user-text';
  return (
    <ChatMessage sender="user" metadata={lastIsBubble ? undefined : chrome}>
      {props.blocks.map((block) => (
        <UserBlock
          key={block.id}
          block={block}
          metadata={block === last && lastIsBubble ? chrome : undefined}
        />
      ))}
    </ChatMessage>
  );
}

/** Why a turn failed: its error block's message. */
function failureOf(group: TranscriptTurnGroup | undefined): string | undefined {
  return group?.blocks.findLast((block) => block.kind === 'error')?.message;
}

/** A reply that is nothing but its failure: the turn failed before the model answered. */
function isBareFailure(group: TranscriptTurnGroup | undefined): boolean {
  return group?.kind === 'assistant' && group.blocks.every((block) => block.kind === 'error');
}

/** Theorem transcript blocks rendered as Astryx chat messages. */
export function ChatTranscript(props: ChatTranscriptProps) {
  return (
    <TheoremLabelsProvider>
      <ShowUsage.Provider value={props.usage === true}>
        <ChatTranscriptBody {...props} />
      </ShowUsage.Provider>
    </TheoremLabelsProvider>
  );
}

function ChatTranscriptBody({
  blocks,
  handle,
  streaming = false,
  delivery,
  onToolDecision,
  answering = null,
  onAuthenticated,
  emptyState,
  dividers,
  imageOutput,
}: ChatTranscriptProps) {
  const groups = useMemo(
    () => groupTranscriptBlocks(blocks, dividers && new Set(Object.keys(dividers))),
    [blocks, dividers],
  );
  const timeOf = useFirstSeen(
    groups.map((group, index) => (group.kind === 'user' ? group.key : replyKey(groups, index))),
  );
  const spans = useTurnSpans(streaming, groups.findLast((group) => group.kind === 'user')?.key);
  const pendingPrompt = streaming ? pendingPromptOf(groups) : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  useDisclosureMotion(listRef);
  const handlers: BlockHandlers = {
    indexOf: (block) => blocks.findIndex((entry) => entry.id === block.id),
    answering,
    onToolDecision,
    onAuthenticated,
  };
  const turn = { handle, handlers, imageOutput };

  const lastUser = groups.findLastIndex((group) => group.kind === 'user');

  const userTurn = (group: Extract<TranscriptTurnGroup, { kind: 'user' }>, index: number) => {
    const next = groups[index + 1];
    const error = isBareFailure(next) ? failureOf(next) : undefined;
    const status = index === lastUser ? (delivery ?? undefined) : undefined;
    return (
      <UserTurn
        key={group.key}
        blocks={group.blocks}
        at={promptTime(groups, index, timeOf)}
        status={status}
        interrupted={group.interrupted}
        error={error}
      />
    );
  };

  const turnOf = (group: TranscriptTurnGroup, index: number) => {
    if (group.kind === 'user') return userTurn(group, index);
    if (isBareFailure(group) && groups[index - 1]?.kind === 'user') return [];
    const { key, live, endedAt, ...timing } = assistantTurnTiming({
      groups,
      index,
      streaming,
      timeOf,
      spans,
    });
    // why: A reply is dated when it last stopped: a reply that just finished reads "now".
    const at = endedAt ?? timeOf(key);
    return (
      <AssistantTurn
        key={key}
        {...turn}
        {...timing}
        blocks={group.blocks}
        streaming={live}
        at={at}
        error={failureOf(group)}
        usage={group.usage}
      />
    );
  };

  const turns = groups.flatMap((group, index) => {
    const label = dividers?.[group.key];
    if (label === undefined) return turnOf(group, index);
    return [
      <ChatSystemMessage key={`divider:${group.key}`} variant="divider">
        {label}
      </ChatSystemMessage>,
      turnOf(group, index),
    ].flat();
  });
  // why: It sits in the same keyed list as the streamed reply, so the reply stays
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
    <ChatMessageList ref={listRef} isStreaming={streaming} emptyState={emptyState}>
      {turns}
    </ChatMessageList>
  );
}
