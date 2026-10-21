import { Banner } from '@astryxdesign/core/Banner';
import { Center } from '@astryxdesign/core/Center';
import { type ChatComposerInputHandle, ChatLayout } from '@astryxdesign/core/Chat';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import {
  type ComposerPendingMessage,
  type ComposerProfileInterface,
  moveComposerPendingWithinKind,
  removeComposerPendingMessage,
} from '@theoremjs/agents/interface';
import type { PageTools } from '@theoremjs/web/client';
import {
  type ConversationView,
  createHttpTransport,
  type HttpTransportOptions,
  type TheoremTransport,
} from '@theoremjs/web/client';
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { parseAspectRatio } from '../client/image-output.ts';
import {
  type SentTurn,
  type UseTheoremChatOptions,
  useTheoremChat,
} from '../hooks/use-theorem-chat.ts';
import { useTheoremInterface } from '../hooks/use-theorem-interface.ts';
import { ChatComposerBar } from './ChatComposerBar.tsx';
import { ChatTranscript } from './ChatTranscript.tsx';
import { useGlide } from './glide.ts';
import type { TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { MarkdownPluginsProvider } from './markdown-plugins.tsx';
import { PaneFailure, PaneLoading } from './PaneState.tsx';
import { SidePanelHeader } from './SidePanel.tsx';
import { useTraceInspector, WithTrace } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremChatProps = {
  /** Where `createTheoremHandler` is mounted. Default `/api/theorem`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
  http?: Omit<HttpTransportOptions, 'endpoint'>;
  /** Bring your own transport (tests, studios, non-HTTP hosts). */
  transport?: TheoremTransport;
  /** Astryx theme. Omit to inherit the host's `<Theme>` or use `theoremTheme`. */
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /**
   * Replacement lines by locale, for any `@theorem.*` key in
   * `THEOREM_UI_CATALOG` or any of Astryx's `@astryx.*` keys. The locale is
   * the host's Astryx `InternationalizationProvider` locale (default `en`).
   */
  labels?: TheoremLabels;
  /**
   * Colour code the reply left untagged: a fence with no language is read and, when it is plainly
   * one of JavaScript, TypeScript, Python, shell, JSON, CSS, HTML, XML, YAML, or Markdown, shown as it.
   * A fence with a language is never changed. Off by default.
   */
  detectCodeLanguage?: boolean;
  /**
   * The value chosen for each of the profile's `inputs.slots`, sent with every turn. A slot you
   * name is fixed to that value; one you leave out gets a selector in the composer bar, beside
   * the model's, starting at its first allowed value.
   */
  slots?: Record<string, string>;
  /** Told each time the visitor chooses a slot in the composer, with every slot's value. */
  onSlotsChange?: (slots: Record<string, string>) => void;
  /**
   * What the page wants the agent to know: any JSON. The latest value goes with every
   * turn, and the profile's `inputs.context.from` must list `client`.
   */
  context?: unknown;
  /**
   * The page's tools, by name: each answers a tool the profile declares with
   * `answeredBy: 'page'`. The reply waits while the page answers; no one is asked.
   */
  pageTools?: PageTools;
  /** Every event of every turn, as it arrives: also the ones the chat shows nothing for. */
  onTurnEvent?: UseTheoremChatOptions['onTurnEvent'];
  placeholder?: string;
  /** Shown above the centred composer before the first message. Default: the agent's handle and a prompt. */
  emptyState?: ReactNode;
  density?: 'compact' | 'balanced' | 'spacious';
  /**
   * Widest the transcript and composer may grow, as a CSS length. Default
   * {@link DEFAULT_CHAT_MAX_WIDTH}: 50% of the chat, or full width on narrow screens.
   */
  maxWidth?: string;
  /** Page scroller when the chat is not its own scroll container (e.g. `document.documentElement`). */
  scrollRef?: React.RefObject<HTMLElement | null>;
  /**
   * Drive the trace from the host's own control. The built-in toggle hides.
   * The open trace takes the chat's place, unless this page is inside
   * `TracePlacement value="panel"`, where it docks. Omit to keep the toggle.
   * Needs a profile that records traces.
   */
  trace?: boolean;
  /**
   * Show what was used, as tokens and cost: each reply's total under it, and
   * on an agent tool's call row what the agent it ran used. Off by default.
   */
  usage?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /**
   * The ref of a conversation to resume, as `onConversationChange` reported it. Read once, when
   * the chat mounts: the chat draws the conversation as the host keeps it.
   */
  conversation?: string;
  /**
   * The conversation under `conversation` as the host showed it with the ref, as
   * `startConversation` returns it. Read once, when the chat mounts: the chat draws it at once,
   * and does not read it from the host again.
   */
  conversationView?: ConversationView;
  /** The text the composer starts with, for the user to send or change. Read once, when the chat mounts. */
  initialText?: string;
  /** The files the composer starts with, staged to send. Read once, when the chat mounts. */
  initialFiles?: readonly File[];
  /**
   * The messages the composer starts with set aside: queued, stashed or steering, as
   * `createComposerPendingMessage` makes them. Read once, when the chat mounts.
   */
  initialPending?: readonly ComposerPendingMessage[];
  /**
   * Called with each new ref the host issues for the conversation: once the message posts, and
   * again as the reply's runs are saved. Keep the latest to resume the chat later. `undefined`
   * when the host can no longer open the ref the chat resumed: the chat starts a new one, so
   * forget it.
   */
  onConversationChange?: (ref: string | undefined) => void;
  /** Lets the host send a message as the composer would; see {@link TheoremChatHandle}. */
  chatRef?: Ref<TheoremChatHandle>;
  /**
   * `false` leaves the composer out: the chat is the transcript alone, and your own control sends
   * through `chatRef`. Gates are still answered in the transcript. Default `true`.
   */
  composer?: boolean;
};

/** What a host can do to a mounted {@link TheoremChat}. */
export type TheoremChatHandle = {
  /**
   * Sends `text` and optional `files` as the user, and resolves with the blocks the turn added once the reply is done;
   * `null` when the chat can't take a message now (a reply is streaming, or waits on a gate).
   */
  send: (text: string, files?: readonly File[]) => Promise<SentTurn | null>;
  /** Stops the reply that is streaming, as the composer's stop button does. */
  stop: () => void;
};

/**
 * 50% of the chat's width, but never narrower than 640px (or the full width,
 * whichever is smaller) — so phones and narrow panes get 100%.
 */
export const DEFAULT_CHAT_MAX_WIDTH = 'max(50%, min(100%, 640px))';

/** Centres content in a column no wider than `maxWidth`, using Astryx layout props. */
function ChatColumn({
  maxWidth,
  ref,
  children,
}: {
  maxWidth: string;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <Center axis="horizontal" width="100%">
      <VStack ref={ref} width="100%" maxWidth={maxWidth}>
        {children}
      </VStack>
    </Center>
  );
}

type ChatBodyProps = Omit<
  TheoremChatProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels' | 'detectCodeLanguage'
> & {
  transport: TheoremTransport;
  iface: ComposerProfileInterface;
};

/** The composer bar wired to a `useTheoremChat` model. */
function ChatComposerForChat({
  chat,
  iface,
  placeholder,
  inputRef,
}: {
  chat: ReturnType<typeof useTheoremChat>;
  iface: ComposerProfileInterface;
  placeholder?: string;
  inputRef: RefObject<ChatComposerInputHandle | null>;
}) {
  return (
    <ChatComposerBar
      iface={iface}
      draftText={chat.draftText}
      pendingFiles={chat.pendingFiles}
      pendingVoice={chat.pendingVoice}
      pendingMessages={chat.pendingMessages}
      issues={chat.issues}
      phase={chat.phase}
      failure={chat.failure}
      selectedModel={chat.session.selectedModel}
      selectedEffort={chat.session.selectedEffort}
      placeholder={placeholder}
      inputRef={inputRef}
      onDraftTextChange={chat.setDraftText}
      onFilesSelected={(files) => {
        chat.setPendingFiles((prev) => [...prev, ...files]);
        chat.setIssues([]);
      }}
      onAttachmentRemove={(index) => {
        chat.setPendingFiles((prev) => prev.filter((_, i) => i !== index));
      }}
      onVoiceStaged={(file) => {
        chat.setPendingVoice([file]);
        chat.setIssues([]);
      }}
      onVoiceClear={() => chat.setPendingVoice([])}
      onSubmit={() => {
        void chat.handleSubmit();
      }}
      onStop={chat.handleStop}
      onMenuAction={chat.handleMenuAction}
      onGenerationChange={chat.handleGenerationChange}
      slotChoices={chat.slotChoices}
      onPendingMove={(id, direction) => {
        chat.setPendingMessages((prev) => moveComposerPendingWithinKind(prev, id, direction));
      }}
      onPendingRemove={(id) => {
        chat.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
      }}
      onPendingQueue={chat.handlePendingQueue}
      onPendingRestore={(id) => {
        void chat.handlePendingRestore(id);
      }}
      onPendingSendNow={(id) => {
        const message = chat.pendingMessages.find((m) => m.id === id);
        if (message) void chat.handleSendNow(message);
      }}
    />
  );
}

function ChatBody({
  transport,
  iface,
  placeholder,
  emptyState,
  density,
  maxWidth = DEFAULT_CHAT_MAX_WIDTH,
  scrollRef,
  trace,
  usage,
  className,
  style,
  conversation,
  conversationView,
  initialText,
  initialFiles,
  initialPending,
  onConversationChange,
  chatRef,
  composer: hasComposer = true,
  slots,
  onSlotsChange,
  context,
  pageTools,
  onTurnEvent,
}: ChatBodyProps) {
  const t = useLabels();
  const chat = useTheoremChat({
    transport,
    iface,
    conversation,
    conversationView,
    initialText,
    initialFiles,
    initialPending,
    onConversationChange,
    slots,
    onSlotsChange,
    context,
    pageTools,
    onTurnEvent,
  });
  const { sendText, handleStop } = chat;
  useImperativeHandle(chatRef, () => ({ send: sendText, stop: handleStop }), [
    sendText,
    handleStop,
  ]);
  const blocks = useMemo(
    () => [...chat.blocks, ...chat.streamBlocks],
    [chat.blocks, chat.streamBlocks],
  );
  const handle = t('@theorem.agent.handle', { handle: iface.identity.handle });
  const landing = blocks.length === 0;
  const inputRef = useRef<ChatComposerInputHandle | null>(null);
  const composerRef = useGlide<HTMLElement>(landing, () => inputRef.current?.focus());
  const inspector = useTraceInspector(iface, transport.traces, trace);
  const header = <SidePanelHeader floating>{inspector.toggle}</SidePanelHeader>;

  // why: the composer says when a turn failed. Without one, the chat says it where the composer was.
  const composer = hasComposer ? (
    <ChatComposerForChat chat={chat} iface={iface} placeholder={placeholder} inputRef={inputRef} />
  ) : (
    chat.failure && <Banner status="error" role="alert" title={chat.failure.error} />
  );

  const docked = { composer, composerRef, maxWidth };
  return (
    <WithTrace inspector={inspector}>
      <Layout
        height="fill"
        className={className}
        style={{ position: 'relative', ...style }}
        header={header}
        content={
          // why: Once there are messages ChatLayout is the scroller; a second one around it moved the docked composer.
          <LayoutContent padding={0} isScrollable={landing}>
            {landing ? (
              <ChatLanding {...docked} handle={handle} emptyState={emptyState} />
            ) : (
              <ChatThread
                {...docked}
                chat={chat}
                iface={iface}
                blocks={blocks}
                handle={handle}
                density={density}
                scrollRef={scrollRef}
                usage={usage}
              />
            )}
          </LayoutContent>
        }
      />
    </WithTrace>
  );
}

const CHAT_SCROLL = { overscrollBehavior: 'none' } as const;

/** Where the composer sits, and how wide the chat's column is. */
type DockedComposer = {
  composer: ReactNode;
  composerRef: RefObject<HTMLElement | null>;
  maxWidth: string;
};

/**
 * The chat before its first message: the greeting, and the composer under it.
 * why: paddingInline={3} matches the dock's inset so the composer keeps its width when it moves.
 */
function ChatLanding({
  composer,
  composerRef,
  maxWidth,
  handle,
  emptyState,
}: DockedComposer & { handle: string; emptyState: ChatBodyProps['emptyState'] }) {
  const t = useLabels();
  return (
    <VStack minHeight="100%" vAlign="center" gap={8} paddingInline={3}>
      <ChatColumn maxWidth={maxWidth}>
        {emptyState ?? (
          <VStack gap={1}>
            <Text type="supporting" as="h2">
              {handle}
            </Text>
            <Text type="display-2" as="h1">
              {t('@theorem.chat.greeting')}
            </Text>
          </VStack>
        )}
      </ChatColumn>
      {composer && (
        <ChatColumn ref={composerRef} maxWidth={maxWidth}>
          {composer}
        </ChatColumn>
      )}
    </VStack>
  );
}

/**
 * The chat once it has messages: the transcript, with the composer in ChatLayout's own dock.
 * why: the dock leaves 12px under the composer; paddingBlockEnd={3} adds 12px more for a 24px
 * bottom margin.
 */
function ChatThread({
  composer,
  composerRef,
  maxWidth,
  chat,
  iface,
  blocks,
  handle,
  density,
  scrollRef,
  usage,
}: DockedComposer &
  Pick<ChatBodyProps, 'density' | 'scrollRef' | 'usage'> & {
    chat: ReturnType<typeof useTheoremChat>;
    iface: ComposerProfileInterface;
    blocks: ReturnType<typeof useTheoremChat>['blocks'];
    handle: string;
  }) {
  return (
    <VStack height="100%">
      <ChatLayout
        density={density}
        scrollRef={scrollRef}
        // why: Scrolling past either end does not bounce the transcript and its docked composer.
        style={CHAT_SCROLL}
        composer={
          composer && (
            <VStack paddingBlockEnd={3}>
              <ChatColumn ref={composerRef} maxWidth={maxWidth}>
                {composer}
              </ChatColumn>
            </VStack>
          )
        }
      >
        <ChatColumn maxWidth={maxWidth}>
          <ChatTranscript
            blocks={blocks}
            handle={handle}
            streaming={chat.streaming}
            delivery={chat.delivery}
            answering={chat.answering}
            usage={usage}
            labels={iface.labels}
            imageOutput={
              iface.type === 'image'
                ? { ratio: parseAspectRatio(iface.image.aspectRatio) }
                : undefined
            }
            onToolDecision={(index, action) => {
              void chat.handleToolDecision(index, action);
            }}
            onAuthenticated={(index, secret) => {
              void chat.handleAuthenticated(index, secret);
            }}
          />
        </ChatColumn>
      </ChatLayout>
    </VStack>
  );
}

function ChatForTransport(
  props: Omit<
    TheoremChatProps,
    'endpoint' | 'http' | 'theme' | 'mode' | 'labels' | 'detectCodeLanguage'
  > & {
    transport: TheoremTransport;
  },
) {
  const t = useLabels();
  const described = useTheoremInterface(props.transport);
  if (described.status === 'loading') return <PaneLoading label={t('@theorem.chat.loading')} />;
  if (described.status === 'error') return <PaneFailure title={described.failure.error} />;
  if (described.iface.type === 'live') {
    return (
      <PaneFailure
        title={t('@theorem.chat.live_unsupported.title')}
        description={t('@theorem.chat.live_unsupported.description')}
      />
    );
  }
  return <ChatBody {...props} transport={props.transport} iface={described.iface} />;
}

/**
 * Drop-in chat for a profile served by `createTheoremHandler`:
 *
 * ```tsx
 * <TheoremChat endpoint="/api/theorem" />
 * ```
 */
export function TheoremChat({
  endpoint,
  http,
  transport,
  theme,
  mode,
  labels,
  detectCodeLanguage,
  ...rest
}: TheoremChatProps) {
  const httpRef = useRef(http);
  httpRef.current = http;
  const resolved = useMemo(
    () => transport ?? createHttpTransport({ ...httpRef.current, endpoint }),
    [transport, endpoint],
  );
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <MarkdownPluginsProvider detectCodeLanguage={detectCodeLanguage}>
          <ChatForTransport {...rest} transport={resolved} />
        </MarkdownPluginsProvider>
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
