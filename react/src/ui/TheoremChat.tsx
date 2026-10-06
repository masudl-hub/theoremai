import { Banner } from '@astryxdesign/core/Banner';
import { Center } from '@astryxdesign/core/Center';
import { type ChatComposerInputHandle, ChatLayout } from '@astryxdesign/core/Chat';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import {
  type ComposerProfileInterface,
  moveComposerPendingWithinKind,
  removeComposerPendingMessage,
} from '@theoremjs/agents/interface';
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { parseAspectRatio } from '../client/image-output.ts';
import {
  createHttpTransport,
  type HttpTransportOptions,
  type TheoremTransport,
} from '../client/transport.ts';
import { type ChatSnapshot, type SentTurn, useTheoremChat } from '../hooks/use-theorem-chat.ts';
import { useTheoremInterface } from '../hooks/use-theorem-interface.ts';
import { ChatComposerBar } from './ChatComposerBar.tsx';
import { ChatTranscript } from './ChatTranscript.tsx';
import type { TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { SidePanelHeader } from './SidePanel.tsx';
import { useTraceInspector, WithTrace } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type TheoremChatProps = {
  /** Where `createTheoremHandler` is mounted. Default `/api/theorem`. Ignored when `transport` is set. */
  endpoint?: string;
  /** Extra fetch options for the default HTTP transport (auth headers, custom fetch). */
  http?: Omit<HttpTransportOptions, 'endpoint'>;
  /** Bring your own transport (tests, playgrounds, non-HTTP hosts). */
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
   * Show the trace in place of the chat, from the host's own control; the
   * built-in trace toggle then hides. Omit to keep the toggle. Needs a profile
   * that records traces.
   */
  trace?: boolean;
  /**
   * Show what was used, as tokens and cost: each reply's total under it, and
   * on an agent tool's call row what the agent it ran used. Off by default.
   */
  usage?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /** A conversation to resume, as `onChatChange` reported it. Read once, when the chat mounts. */
  initialChat?: ChatSnapshot;
  /** The text the composer starts with, for the user to send or change. Read once, when the chat mounts. */
  initialText?: string;
  /**
   * Called with the conversation each time it comes to rest: a turn finished, or a message was
   * added or removed; never while a reply streams. Keep it to resume the chat later.
   */
  onChatChange?: (snapshot: ChatSnapshot) => void;
  /** Lets the host send a message as the composer would; see {@link TheoremChatHandle}. */
  chatRef?: Ref<TheoremChatHandle>;
};

/** What a host can do to a mounted {@link TheoremChat}. */
export type TheoremChatHandle = {
  /**
   * Sends `text` as the user, and resolves with the blocks the turn added once the reply is done;
   * `null` when the chat can't take a message now (a reply is streaming, or waits on a gate).
   */
  send: (text: string) => Promise<SentTurn | null>;
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

/** Reads an Astryx duration token ("410ms" / "0.4s") as milliseconds. */
function tokenMs(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return value.trim().endsWith('ms') ? n : n * 1_000;
}

/**
 * The composer is centred until the first message, then lives in ChatLayout's
 * dock. Astryx has no layout-transition helper, so this eases the jump (FLIP)
 * with Astryx's `--duration-medium` / `--ease-standard` tokens and keeps focus.
 */
function useComposerGlide(landing: boolean, inputRef: RefObject<ChatComposerInputHandle | null>) {
  const columnRef = useRef<HTMLElement | null>(null);
  const landingTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    if (landing) {
      landingTop.current = el.getBoundingClientRect().top;
      return;
    }
    const from = landingTop.current;
    if (from === null) return;
    landingTop.current = null;
    inputRef.current?.focus();
    const delta = from - el.getBoundingClientRect().top;
    if (delta === 0 || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const tokens = getComputedStyle(el);
    el.animate([{ transform: `translateY(${String(delta)}px)` }, { transform: 'none' }], {
      duration: tokenMs(tokens.getPropertyValue('--duration-medium'), 410),
      easing: tokens.getPropertyValue('--ease-standard').trim() || 'ease-out',
    });
  });
  return columnRef;
}

type ChatBodyProps = Omit<
  TheoremChatProps,
  'endpoint' | 'http' | 'transport' | 'theme' | 'mode' | 'labels'
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
  initialChat,
  initialText,
  onChatChange,
  chatRef,
}: ChatBodyProps) {
  const t = useLabels();
  const chat = useTheoremChat({
    transport,
    iface,
    initial: initialChat,
    initialText,
    onChange: onChatChange,
  });
  const sendText = chat.sendText;
  useImperativeHandle(chatRef, () => ({ send: sendText }), [sendText]);
  const blocks = useMemo(
    () => [...chat.blocks, ...chat.streamBlocks],
    [chat.blocks, chat.streamBlocks],
  );
  const handle = t('@theorem.agent.handle', { handle: iface.identity.handle });
  const landing = blocks.length === 0;
  const inputRef = useRef<ChatComposerInputHandle | null>(null);
  const composerRef = useComposerGlide(landing, inputRef);
  const inspector = useTraceInspector(iface, transport.traces, trace);
  const header = <SidePanelHeader>{inspector.toggle}</SidePanelHeader>;

  const composer = (
    <ChatComposerForChat chat={chat} iface={iface} placeholder={placeholder} inputRef={inputRef} />
  );

  // why: paddingInline={3} matches the dock's inset so the
  // composer keeps its width when it moves.
  if (landing) {
    return (
      <WithTrace inspector={inspector}>
        <Layout
          height="fill"
          className={className}
          style={style}
          header={header}
          content={
            <LayoutContent padding={0}>
              <VStack minHeight="100%" vAlign="center" gap={8} paddingInline={3}>
                <ChatColumn maxWidth={maxWidth}>
                  {emptyState ?? (
                    <VStack gap={1}>
                      <Text type="large" as="h2">
                        {handle}
                      </Text>
                      <Text type="display-2" as="h1">
                        {t('@theorem.chat.greeting')}
                      </Text>
                    </VStack>
                  )}
                </ChatColumn>
                <ChatColumn ref={composerRef} maxWidth={maxWidth}>
                  {composer}
                </ChatColumn>
              </VStack>
            </LayoutContent>
          }
        />
      </WithTrace>
    );
  }

  // why: with the composer in ChatLayout's own dock. The dock leaves 12px under the
  // composer; paddingBlockEnd={3} adds 12px more for a 24px bottom margin.
  return (
    <WithTrace inspector={inspector}>
      <Layout
        height="fill"
        className={className}
        style={style}
        header={header}
        content={
          <LayoutContent padding={0}>
            <VStack height="100%">
              <ChatLayout
                density={density}
                scrollRef={scrollRef}
                composer={
                  <VStack paddingBlockEnd={3}>
                    <ChatColumn ref={composerRef} maxWidth={maxWidth}>
                      {composer}
                    </ChatColumn>
                  </VStack>
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
          </LayoutContent>
        }
      />
    </WithTrace>
  );
}

function ChatForTransport(
  props: Omit<TheoremChatProps, 'endpoint' | 'http' | 'theme' | 'mode' | 'labels'> & {
    transport: TheoremTransport;
  },
) {
  const t = useLabels();
  const described = useTheoremInterface(props.transport);
  if (described.status === 'loading')
    return <Spinner size="lg" label={t('@theorem.chat.loading')} />;
  if (described.status === 'error') {
    return <Banner status="error" title={described.failure.error} />;
  }
  if (described.iface.type === 'live') {
    return (
      <Banner
        status="warning"
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
        <ChatForTransport {...rest} transport={resolved} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
