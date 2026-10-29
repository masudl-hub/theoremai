/**
 * An imported trace: the conversation it recorded, as the person saw it, and a replay of it through
 * the profile as it is now. A replay reaches no model and, unless Live tools is on, no tool: the
 * recording answers both. Where the profile asks for something the recording does not hold, the
 * replay stops and says why; Continue live goes on from there with the real model.
 *
 * @module
 */
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconX } from '@tabler/icons-react';
import type {
  ComposerProfileInterface,
  ProfileInterface,
  TranscriptBlock,
} from '@theoremjs/agents/interface';
import type { TraceRecord } from '@theoremjs/agents/observability';
import { useTheoremChat } from '@theoremjs/react';
import {
  ChatTranscript,
  ConsoleFrame,
  RequestCard,
  ResponseColumn,
  RunBar,
  TheoremLabelsProvider,
  TheoremThemeProvider,
  useLabels,
  useTraceInspector,
} from '@theoremjs/react/ui';
import {
  type ConversationView,
  createTraceFeed,
  recordedFeed,
  type TraceFeed,
} from '@theoremjs/web/client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBrowserStudioTransport,
  type StudioBrowserRuntime,
  startBrowserStudioConversation,
} from '../browser.ts';
import {
  createReplay,
  parseTraceFile,
  type ReplayDivergence,
  type ReplayScript,
  recordedPayload,
  recordedTranscript,
  replayScript,
  type StudioRunPayload,
  startStudioConversation,
  studioInterface,
  studioPageTools,
} from '../mod.ts';
import { pageConversationKey } from './lib/studio-conversation.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';

/** A trace file the builder imported. */
export interface OpenedTrace {
  name: string;
  records: TraceRecord[];
}

/** A live conversation started where a replay stopped: its ref, its view, and the message to send next. */
export interface LiveStart {
  conversation: string;
  view: ConversationView;
  text: string;
}

/**
 * A live conversation on `blocks`, kept where the live chat keeps its own: sealed in the page
 * when it runs there, else in this visitor's session on the server.
 */
function startLive(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime | null,
  blocks: readonly TranscriptBlock[],
) {
  return runtime
    ? startBrowserStudioConversation(payload, runtime, {
        conversationKey: pageConversationKey(),
        blocks,
      })
    : startStudioConversation(payload, blocks);
}

type ReplayStatus =
  | { kind: 'running'; turn: number }
  | { kind: 'waiting'; turn: number }
  | { kind: 'missing'; turn: number }
  | { kind: 'diverged'; divergence: ReplayDivergence }
  | { kind: 'failed'; turn: number; message: string }
  | { kind: 'stopped'; turn: number }
  | { kind: 'done' };

const ordinal = (turn: number) => `turn ${String(turn + 1)}`;

/** The console's frame, as a decision and a host have it: the trace card, then the conversation. */
function TraceFrame({
  iface,
  feed,
  trace,
  card,
  conversation,
}: {
  iface: ProfileInterface;
  feed: TraceFeed;
  trace: boolean | undefined;
  card: ReactNode;
  conversation: ReactNode;
}) {
  const inspector = useTraceInspector(iface, feed, trace);
  return (
    <ConsoleFrame inspector={inspector} maxWidth="960px" requestLabel="Trace">
      {card}
      {conversation}
    </ConsoleFrame>
  );
}

/** The conversation's card: where the replay stands, then the transcript. */
function Conversation({
  iface,
  blocks,
  banner,
  chat,
}: {
  iface: ProfileInterface;
  blocks: readonly TranscriptBlock[];
  banner?: ReactNode;
  chat?: ReturnType<typeof useTheoremChat>;
}) {
  const t = useLabels();
  return (
    <ResponseColumn label="Conversation">
      {banner}
      <ChatTranscript
        blocks={blocks}
        handle={t('@theorem.agent.handle', { handle: iface.identity.handle })}
        labels={iface.labels}
        streaming={chat?.streaming}
        delivery={chat?.delivery}
        answering={chat?.answering}
        onToolDecision={
          chat &&
          ((index, action) => {
            void chat.handleToolDecision(index, action);
          })
        }
        onAuthenticated={
          chat &&
          ((index, secret) => {
            void chat.handleAuthenticated(index, secret);
          })
        }
      />
    </ResponseColumn>
  );
}

/** A trace file to import, and why the last one did not import. */
function TraceFileInput({ onImport }: { onImport: (trace: OpenedTrace) => void }) {
  const [problem, setProblem] = useState<string>();
  const [reading, setReading] = useState(false);
  const changeAction = async (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] : files;
    if (!file) return;
    setReading(true);
    try {
      const records = parseTraceFile(await file.text());
      // why: a file the replay cannot read is refused here, where the card can say why.
      replayScript(records);
      onImport({ name: file.name, records });
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
    }
  };
  return (
    <VStack gap={2}>
      <FileInput
        label="Trace file"
        isLabelHidden
        mode="dropzone"
        accept="application/json,.json,.jsonl"
        isLoading={reading}
        placeholder="Drop a trace (.json or .jsonl) or choose a file"
        value={null}
        changeAction={changeAction}
        onChange={() => undefined}
      />
      {problem ? <Banner status="error" title={problem} /> : null}
    </VStack>
  );
}

type Shown = 'recorded' | 'replayed';

/** A replay of one file through one agent: how many times it ran, and which run is shown. */
interface ReplayRun {
  of: OpenedTrace;
  agent: string;
  attempt: number;
  shown: Shown;
}

/** What the trace card holds besides its file: the imported trace, and how its replay runs. */
interface TraceControls {
  opened: OpenedTrace;
  script: ReplayScript;
  payload: StudioRunPayload;
  shown: Shown | null;
  onShown: (next: Shown) => void;
  liveTools: boolean;
  onLiveTools: (next: boolean) => void;
  isRunning: boolean;
  onReplay: () => void;
  onStop: () => void;
  onClear: () => void;
}

const recordedAt = (script: ReplayScript) =>
  script.recordedAt === undefined
    ? undefined
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        script.recordedAt,
      );

/** Recorded / Replayed: which run the conversation and the inspector show. */
function ShownControl({ shown, onShown }: { shown: Shown; onShown: (next: Shown) => void }) {
  return (
    <SegmentedControl
      label="Show"
      size="sm"
      value={shown}
      onChange={(next) => {
        onShown(next === 'replayed' ? 'replayed' : 'recorded');
      }}
    >
      <SegmentedControlItem value="recorded" label="Recorded" />
      <SegmentedControlItem value="replayed" label="Replayed" />
    </SegmentedControl>
  );
}

/** What the imported file recorded, and how a replay answers its tools. */
function TraceFacts({ controls }: { controls: TraceControls }) {
  const { script, payload } = controls;
  const turns = script.turns.length;
  const facts = [
    script.agent || 'No agent',
    `${String(turns)} ${turns === 1 ? 'turn' : 'turns'}`,
    recordedAt(script),
  ];
  return (
    <>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <VStack gap={0}>
            <Text type="label" maxLines={1}>
              {controls.opened.name}
            </Text>
            <Text type="supporting" color="secondary" maxLines={1}>
              {facts.filter(Boolean).join(' · ')}
            </Text>
          </VStack>
        </StackItem>
        <IconButton
          label="Clear trace"
          variant="ghost"
          size="sm"
          icon={<Icon icon={IconX} size="sm" />}
          isDisabled={controls.isRunning}
          onClick={controls.onClear}
        />
      </HStack>
      {script.agent && script.agent !== payload.profile.id ? (
        <Banner
          status="info"
          title={`Recorded with ${script.agent}; a replay runs through ${payload.profile.id}.`}
        />
      ) : null}
      {turns === 0 ? (
        <Banner status="info" title="This trace holds no conversation to replay." />
      ) : null}
      <Switch
        label="Live tools"
        description="Run the profile's tools instead of answering them from the recording."
        value={controls.liveTools}
        onChange={controls.onLiveTools}
      />
    </>
  );
}

const idle = () => undefined;

/** The trace card: the file, what it recorded, and Replay. */
function TraceCard({
  onImport,
  controls,
}: {
  onImport: (trace: OpenedTrace) => void;
  controls?: TraceControls;
}) {
  const replay = controls?.onReplay ?? idle;
  return (
    <RequestCard
      title="Trace"
      onRun={replay}
      actions={
        controls?.shown ? <ShownControl shown={controls.shown} onShown={controls.onShown} /> : null
      }
    >
      <TraceFileInput onImport={onImport} />
      {controls ? <TraceFacts controls={controls} /> : null}
      <RunBar
        note={controls ? 'Answers each model call from the recording, so it needs no keys.' : null}
        isReady={(controls?.script.turns.length ?? 0) > 0}
        isRunning={controls?.isRunning ?? false}
        runLabel={controls?.shown ? 'Replay again' : 'Replay'}
        runningLabel="Replaying"
        stopLabel="Stop"
        onRun={replay}
        onStop={controls?.onStop ?? idle}
      />
    </RequestCard>
  );
}

/** What the replay is doing, or where and why it stopped, with the way on. */
function StatusBanner({
  status,
  turns,
  onContinue,
  onLive,
}: {
  status: ReplayStatus;
  turns: number;
  onContinue: (turn: number) => void;
  onLive: (turn: number) => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  const live = (turn: number) => (
    <Button
      label="Continue live"
      variant="secondary"
      size="sm"
      isLoading={starting}
      onClick={async () => {
        setStarting(true);
        setProblem(undefined);
        try {
          await onLive(turn);
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error));
          setStarting(false);
        }
      }}
    />
  );
  const banner = (() => {
    switch (status.kind) {
      case 'running':
        return (
          <Banner status="info" title={`Replaying ${ordinal(status.turn)} of ${String(turns)}`} />
        );
      case 'waiting':
        return (
          <Banner
            status="info"
            title={`${ordinal(status.turn - 1)} waits on you`}
            description="Answer it in the conversation, then continue the replay."
            endContent={
              <Button
                label="Continue replay"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onContinue(status.turn);
                }}
              />
            }
          />
        );
      case 'missing':
        return (
          <Banner
            status="warning"
            title={`Replay stopped before ${ordinal(status.turn)}`}
            description="It was sent with files, and a trace never holds a file's bytes. Continue live to send it again with yours."
            endContent={live(status.turn)}
          />
        );
      case 'diverged': {
        const divergence = status.divergence;
        const at =
          'tool' in divergence
            ? `the ${divergence.tool} tool`
            : `${divergence.agent}'s model call ${String(divergence.call)}`;
        return (
          <Banner
            status="warning"
            title={`Replay stopped at ${ordinal(divergence.turn)}, ${at}`}
            description={divergence.reason}
            endContent={live(divergence.turn)}
          />
        );
      }
      case 'stopped':
        return (
          <Banner
            status="info"
            title={`Replay stopped at ${ordinal(status.turn)}`}
            description="You stopped it. Continue live to go on from here with the profile's model."
            endContent={live(status.turn)}
          />
        );
      case 'failed':
        return (
          <Banner
            status="error"
            title={`Replay stopped at ${ordinal(status.turn)}`}
            description={status.message}
            endContent={live(status.turn)}
          />
        );
      case 'done':
        return (
          <Banner
            status="success"
            title={`Replayed ${String(turns)} ${turns === 1 ? 'turn' : 'turns'}`}
            description="Every model call this profile made was one the recording answered."
          />
        );
    }
  })();
  return (
    <VStack gap={1}>
      {banner}
      {problem ? <Banner status="error" title={problem} /> : null}
    </VStack>
  );
}

type ConsoleProps = {
  payload: StudioRunPayload;
  iface: ComposerProfileInterface;
  trace: boolean | undefined;
  card: (controls: Pick<TraceControls, 'isRunning' | 'onStop'>) => ReactNode;
  opened: OpenedTrace;
  script: ReplayScript;
};

/** A replay of the imported trace: driven turn by turn, beside what the trace recorded. */
function ReplayConsole({
  payload,
  iface,
  trace,
  card,
  opened,
  script,
  shown,
  liveTools,
  runtime,
  onLive,
}: ConsoleProps & {
  shown: Shown;
  liveTools: boolean;
  runtime: StudioBrowserRuntime | null;
  onLive: (start: LiveStart) => void;
}) {
  const diverged = useRef<ReplayDivergence>(undefined);
  const [status, setStatus] = useState<ReplayStatus>({ kind: 'running', turn: 0 });
  const [traces] = useState(createTraceFeed);
  const recorded = useMemo(() => recordedFeed(opened.records), [opened.records]);
  const replay = useMemo(
    () =>
      createReplay(script, payload.profile.id, (divergence) => {
        diverged.current ??= divergence;
      }),
    [script, payload.profile.id],
  );
  const transport = useMemo(
    () =>
      createBrowserStudioTransport(
        liveTools ? payload : recordedPayload(payload),
        {
          mode: 'byok',
          provider: replay.provider,
          ...(liveTools ? {} : { toolHandlers: replay.toolHandlers }),
        },
        { conversationKey: pageConversationKey(), traces },
      ),
    [payload, replay, liveTools, traces],
  );
  const pageTools = useMemo(
    () => (liveTools ? studioPageTools(payload) : undefined),
    [liveTools, payload],
  );
  const chat = useTheoremChat({ transport, iface, pageTools });
  const { sendText, handleStop } = chat;
  const phase = useRef(chat.phase);
  phase.current = chat.phase;
  const [from, setFrom] = useState(0);
  /** The builder pressed Stop: the replay sends no further turn. */
  const halted = useRef(false);
  // invariant: only leaving the replay stops its reply; Continue replay restarts the loop while a resumed reply streams.
  const stopReply = useRef(handleStop);
  stopReply.current = handleStop;
  useEffect(() => () => stopReply.current(), []);
  useEffect(() => {
    let stopped = false;
    /** Until a reply still streaming (one a stop is ending) has ended. */
    const settled = async () => {
      while (!stopped && phase.current === 'streaming')
        await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    void (async () => {
      for (let turn = from; turn < script.turns.length; turn += 1) {
        await settled();
        if (stopped || halted.current) return;
        if (phase.current === 'gated') {
          // The turn before waits on a gate: its reply goes on with the calls it has left.
          replay.startTurn(turn - 1);
          return setStatus({ kind: 'waiting', turn });
        }
        const { text, attachments } = script.turns[turn];
        if (attachments > 0) return setStatus({ kind: 'missing', turn });
        replay.startTurn(turn);
        setStatus({ kind: 'running', turn });
        try {
          const sent = await sendText(text);
          if (stopped || halted.current) return;
          if (diverged.current)
            return setStatus({ kind: 'diverged', divergence: diverged.current });
          // The chat took nothing: it was not idle yet. Settle, then send this turn again.
          if (!sent) turn -= 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return setStatus({ kind: 'failed', turn, message });
        }
      }
      setStatus({ kind: 'done' });
    })();
    return () => {
      stopped = true;
    };
  }, [from, replay, script, sendText]);
  const live = async (turn: number) => {
    const blocks = script.turns.slice(0, turn).flatMap((each) => each.blocks);
    const started = await startLive(payload, runtime, blocks);
    onLive({ ...started, text: script.turns[turn]?.text ?? '' });
  };
  const replayed = shown === 'replayed';
  return (
    <TraceFrame
      iface={iface}
      feed={replayed ? traces : recorded}
      trace={trace}
      card={card({
        isRunning: status.kind === 'running',
        onStop: () => {
          halted.current = true;
          handleStop();
          setStatus((now) => (now.kind === 'running' ? { kind: 'stopped', turn: now.turn } : now));
        },
      })}
      conversation={
        <Conversation
          iface={iface}
          blocks={replayed ? [...chat.blocks, ...chat.streamBlocks] : recordedTranscript(script)}
          chat={replayed ? chat : undefined}
          banner={
            replayed ? (
              <StatusBanner
                status={status}
                turns={script.turns.length}
                onContinue={setFrom}
                onLive={live}
              />
            ) : undefined
          }
        />
      }
    />
  );
}

export type TraceReplayProps = {
  payload: StudioRunPayload;
  trace: boolean | undefined;
  runtime: StudioBrowserRuntime | null;
  onLive: (start: LiveStart) => void;
  /** The imported file, held by the page so closing the console does not lose it. */
  opened: OpenedTrace | undefined;
  onOpened: (trace: OpenedTrace) => void;
  /** Lets go of the imported file. */
  onClear: () => void;
};

/**
 * The trace console, in the frame a decision and a host use: the trace card, then the
 * conversation it recorded or its replay through the profile as it is now.
 */
export function TraceReplay(props: TraceReplayProps) {
  return (
    <TheoremThemeProvider>
      <TheoremLabelsProvider labels={STUDIO_LABELS}>
        <TraceConsole {...props} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}

function TraceConsole({
  payload,
  trace,
  runtime,
  onLive,
  opened,
  onOpened,
  onClear,
}: TraceReplayProps) {
  const iface = useMemo(() => studioInterface(payload), [payload]);
  const script = useMemo(() => opened && replayScript(opened.records), [opened]);
  const recorded = useMemo(() => recordedFeed(opened?.records ?? []), [opened]);
  const [ran, setRan] = useState<ReplayRun>();
  const [liveTools, setLiveTools] = useState(false);
  // invariant: a replay belongs to the file and the agent it ran; another of either shows the recording.
  const run = ran?.of === opened && ran?.agent === payload.profile.id ? ran : undefined;
  const attempt = run?.attempt ?? 0;
  const shown = run?.shown ?? 'recorded';
  const setShown = (next: Shown) => {
    if (run) setRan({ ...run, shown: next });
  };
  const replayOnce = () => {
    if (opened)
      setRan({ of: opened, agent: payload.profile.id, attempt: attempt + 1, shown: 'replayed' });
  };
  // invariant: the header offers an import only for a type whose conversation a trace holds.
  if (iface.type === 'live') return null;
  if (!opened || !script)
    return (
      <TraceFrame
        iface={iface}
        feed={recorded}
        trace={trace}
        card={<TraceCard onImport={onOpened} />}
        conversation={null}
      />
    );
  const card = ({ isRunning, onStop }: Pick<TraceControls, 'isRunning' | 'onStop'>) => (
    <TraceCard
      onImport={onOpened}
      controls={{
        opened,
        script,
        payload,
        shown: attempt > 0 ? shown : null,
        onShown: setShown,
        liveTools,
        onLiveTools: (next) => {
          setLiveTools(next);
          if (attempt > 0) replayOnce();
        },
        isRunning,
        onReplay: replayOnce,
        onStop,
        onClear,
      }}
    />
  );
  if (attempt === 0)
    return (
      <TraceFrame
        iface={iface}
        feed={recorded}
        trace={trace}
        card={card({ isRunning: false, onStop: () => undefined })}
        conversation={<Conversation iface={iface} blocks={recordedTranscript(script)} />}
      />
    );
  return (
    <ReplayConsole
      key={attempt}
      payload={payload}
      iface={iface}
      trace={trace}
      card={card}
      opened={opened}
      script={script}
      shown={shown}
      liveTools={liveTools}
      runtime={runtime}
      onLive={onLive}
    />
  );
}
