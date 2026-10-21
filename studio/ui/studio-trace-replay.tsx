/**
 * An opened trace: the conversation it recorded, as the person saw it, and a replay of it through
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
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconFileImport, IconPlayerPlay, IconX } from '@tabler/icons-react';
import type { TranscriptBlock } from '@theoremjs/agents/interface';
import type { TraceRecord } from '@theoremjs/agents/observability';
import { PaneState, TheoremChat, type TheoremChatHandle } from '@theoremjs/react/ui';
import {
  type ConversationView,
  createTraceFeed,
  type TheoremTransport,
  type TraceFeed,
} from '@theoremjs/web/client';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { sendWhenReady } from './lib/send-when-ready.ts';
import { pageConversationKey } from './lib/studio-conversation.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';

/** A trace file the builder opened. */
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
  | { kind: 'done' };

const ordinal = (turn: number) => `turn ${String(turn + 1)}`;

/** A chat that only shows: the conversation a trace recorded, and its records beside it. */
function recordedTransport(
  payload: StudioRunPayload,
  transcript: TranscriptBlock[],
  traces: TraceFeed,
) {
  const refused = () =>
    Promise.reject(
      new Error('A recorded conversation cannot change. Replay it, then continue live.'),
    );
  return {
    describe: () => Promise.resolve(studioInterface(payload)),
    turn: refused,
    invoke: refused,
    steer: refused,
    rewind: refused,
    conversation: () => Promise.resolve({ transcript }),
    traces,
  } satisfies TheoremTransport;
}

/** The pane to open a trace in: a place to drop it, and why the last one did not open. */
function OpenTrace({ onOpen }: { onOpen: (trace: OpenedTrace) => void }) {
  const [problem, setProblem] = useState<string>();
  const [reading, setReading] = useState(false);
  const changeAction = async (files: File | File[] | null) => {
    const file = Array.isArray(files) ? files[0] : files;
    if (!file) return;
    setReading(true);
    try {
      onOpen({ name: file.name, records: parseTraceFile(await file.text()) });
      setProblem(undefined);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
    }
  };
  return (
    <PaneState
      icon={<Icon icon={IconFileImport} size="lg" color="secondary" />}
      title="Open a trace"
      description="See how a conversation went, then replay it through this profile as it is now. A replay answers from the recording, so it needs no keys."
    >
      <VStack gap={2}>
        <FileInput
          label="Trace file"
          isLabelHidden
          mode="dropzone"
          accept="application/json,.json"
          isLoading={reading}
          placeholder="Drop a trace (.json) or choose a file"
          value={null}
          changeAction={changeAction}
          onChange={() => undefined}
        />
        {problem ? <Banner status="error" title={problem} /> : null}
      </VStack>
    </PaneState>
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
        const { turn, call, reason } = status.divergence;
        return (
          <Banner
            status="warning"
            title={`Replay stopped at ${ordinal(turn)}, model call ${String(call)}`}
            description={reason}
            endContent={live(turn)}
          />
        );
      }
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

/** The replay of `script`: the chat it runs in, driven turn by turn, and where it stands. */
function ReplayRun({
  payload,
  script,
  liveTools,
  trace,
  runtime,
  onLive,
}: {
  payload: StudioRunPayload;
  script: ReplayScript;
  liveTools: boolean;
  trace: boolean | undefined;
  runtime: StudioBrowserRuntime | null;
  onLive: (start: LiveStart) => void;
}) {
  const chatRef = useRef<TheoremChatHandle | null>(null);
  const diverged = useRef<ReplayDivergence>(undefined);
  const [status, setStatus] = useState<ReplayStatus>({ kind: 'running', turn: 0 });
  const [traces] = useState(createTraceFeed);
  const replay = useMemo(
    () =>
      createReplay(script, payload.profile.id, (divergence) => {
        diverged.current ??= divergence;
      }),
    [script, payload.profile.id],
  );
  const ran = useMemo(() => (liveTools ? payload : recordedPayload(payload)), [liveTools, payload]);
  const pageTools = useMemo(
    () => (liveTools ? studioPageTools(payload) : undefined),
    [liveTools, payload],
  );
  const transport = useMemo(
    () =>
      createBrowserStudioTransport(
        ran,
        {
          mode: 'byok',
          provider: replay.provider,
          ...(liveTools ? {} : { toolHandlers: replay.toolHandlers }),
        },
        { conversationKey: pageConversationKey(), traces },
      ),
    [ran, replay, liveTools, traces],
  );
  const [from, setFrom] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      for (let turn = from; turn < script.turns.length; turn += 1) {
        if (signal.aborted) return;
        const { text, attachments } = script.turns[turn];
        if (attachments > 0) return setStatus({ kind: 'missing', turn });
        replay.startTurn(turn);
        setStatus({ kind: 'running', turn });
        try {
          // why: The chat takes nothing until it has described its agent; later turns find it ready.
          const sent =
            turn === 0
              ? await sendWhenReady(chatRef, text, signal)
              : ((await chatRef.current?.send(text)) ?? null);
          if (signal.aborted) return;
          if (diverged.current)
            return setStatus({ kind: 'diverged', divergence: diverged.current });
          if (!sent) {
            // The turn before waits on a gate: its reply goes on with the calls it has left.
            replay.startTurn(turn - 1);
            return setStatus({ kind: 'waiting', turn });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return setStatus({ kind: 'failed', turn, message });
        }
      }
      setStatus({ kind: 'done' });
    })();
    return () => {
      controller.abort();
      chatRef.current?.stop();
    };
  }, [from, replay, script]);
  const live = async (turn: number) => {
    const blocks = script.turns.slice(0, turn).flatMap((each) => each.blocks);
    const started = await startLive(payload, runtime, blocks);
    onLive({ ...started, text: script.turns[turn]?.text ?? '' });
  };
  return (
    <VStack height="100%">
      <Section variant="transparent" paddingInline={3} paddingBlock={2}>
        <StatusBanner
          status={status}
          turns={script.turns.length}
          onContinue={setFrom}
          onLive={live}
        />
      </Section>
      <StackItem size="fill">
        <TheoremChat
          detectCodeLanguage
          labels={STUDIO_LABELS}
          transport={transport}
          trace={trace}
          composer={false}
          chatRef={chatRef}
          pageTools={pageTools}
        />
      </StackItem>
    </VStack>
  );
}

const recordedAt = (script: ReplayScript) =>
  script.recordedAt === undefined
    ? undefined
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        script.recordedAt,
      );

/** An opened trace: its recorded conversation, or a replay of it, and the controls between them. */
function OpenedTraceView({
  payload,
  opened,
  trace,
  runtime,
  onClose,
  onLive,
}: {
  payload: StudioRunPayload;
  opened: OpenedTrace;
  trace: boolean | undefined;
  onClose: () => void;
  runtime: StudioBrowserRuntime | null;
  onLive: (start: LiveStart) => void;
}) {
  const script = useMemo(() => replayScript(opened.records), [opened.records]);
  const [view, setView] = useState<'recorded' | 'replayed'>('recorded');
  const [attempt, setAttempt] = useState(0);
  const [liveTools, setLiveTools] = useState(false);
  const recorded = useMemo(() => {
    const traces = createTraceFeed();
    for (const record of opened.records) traces.push(record);
    return recordedTransport(payload, recordedTranscript(script), traces);
  }, [payload, opened.records, script]);
  const turns = script.turns.length;
  const facts = [
    script.agent || 'No agent',
    `${String(turns)} ${turns === 1 ? 'turn' : 'turns'}`,
    recordedAt(script),
  ].filter(Boolean);
  const replayOnce = () => {
    setAttempt((count) => count + 1);
    setView('replayed');
  };
  return (
    <VStack height="100%">
      <Section variant="transparent" paddingInline={3} paddingBlock={2}>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <VStack gap={0}>
                <Text type="label" maxLines={1}>
                  {opened.name}
                </Text>
                <Text type="supporting" color="secondary" maxLines={1}>
                  {facts.join(' · ')}
                </Text>
              </VStack>
            </StackItem>
            {attempt > 0 ? (
              <SegmentedControl
                label="Show"
                size="sm"
                value={view}
                onChange={(next) => {
                  setView(next === 'replayed' ? 'replayed' : 'recorded');
                }}
              >
                <SegmentedControlItem value="recorded" label="Recorded" />
                <SegmentedControlItem value="replayed" label="Replayed" />
              </SegmentedControl>
            ) : null}
            <Switch
              label="Live tools"
              size="sm"
              value={liveTools}
              onChange={(next) => {
                setLiveTools(next);
                if (attempt > 0) replayOnce();
              }}
            />
            <Button
              label={attempt > 0 ? 'Replay again' : 'Replay'}
              variant="primary"
              size="sm"
              icon={<Icon icon={IconPlayerPlay} size="sm" />}
              isDisabled={turns === 0}
              onClick={replayOnce}
            />
            <IconButton
              label="Close trace"
              variant="ghost"
              tooltip="Close trace"
              icon={<Icon icon={IconX} size="sm" />}
              onClick={onClose}
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
        </VStack>
      </Section>
      <StackItem size="fill">
        {view === 'replayed' && attempt > 0 ? (
          <ReplayRun
            key={attempt}
            payload={payload}
            script={script}
            liveTools={liveTools}
            trace={trace}
            runtime={runtime}
            onLive={onLive}
          />
        ) : (
          <TheoremChat
            key={opened.name}
            detectCodeLanguage
            labels={STUDIO_LABELS}
            transport={recorded}
            trace={trace}
            composer={false}
            conversation="recorded"
            conversationView={{ transcript: recordedTranscript(script) }}
          />
        )}
      </StackItem>
    </VStack>
  );
}

/** The trace pane: a place to open one, then what it recorded and its replay. */
export function TraceReplay({
  payload,
  trace,
  runtime,
  onClose,
  onLive,
}: {
  payload: StudioRunPayload;
  trace: boolean | undefined;
  onClose: () => void;
  runtime: StudioBrowserRuntime | null;
  onLive: (start: LiveStart) => void;
}) {
  const [opened, setOpened] = useState<OpenedTrace>();
  return opened ? (
    <OpenedTraceView
      payload={payload}
      opened={opened}
      trace={trace}
      runtime={runtime}
      onClose={onClose}
      onLive={onLive}
    />
  ) : (
    <OpenTrace onOpen={setOpened} />
  );
}
