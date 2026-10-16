import type { TurnEvent } from '@theoremjs/agents';
import {
  branchInterfaceTurnSession,
  type ComposerPendingMessage,
  type ComposerProfileInterface,
  type ComposerRunPhase,
  consumeNextComposerQueue,
  convertSteersToFrontQueued,
  defaultInterfaceEffort,
  type InterfaceTurnSession,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  removeLandedSteers,
  type TranscriptBlock,
} from '@theoremjs/agents/interface';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientFailure, type TurnFailure, turnFailure } from '../client/failure.ts';
import { followGenerationDefaults } from '../client/generation-selection.ts';
import type { PageTools } from '../client/live/live-page-tool.ts';
import { withPageToolDispatch } from '../client/page-dispatch.ts';
import { sessionAfter, stampWorked } from '../client/run-commit.ts';
import { keepsConversation, type RunOutcome, type StreamView } from '../client/run-session.ts';
import type { ToolGateResolution } from '../client/tool-resume.ts';
import type {
  ChatLine,
  ChatLineSink,
  ConversationView,
  TheoremTransport,
  TheoremTurnRequest,
  TurnEventSink,
} from '../client/transport.ts';
import { foldAssistantTurn } from '../client/turn-client.ts';
import { usePageToolWarnings } from './use-page-tool-warnings.ts';
import { type RunTurnStream, useTheoremChatActions } from './use-theorem-chat-actions.ts';
import {
  type MessageDelivery,
  type SetSession,
  useTheoremChatState,
} from './use-theorem-chat-state.ts';

export type UseTheoremChatOptions = {
  transport: TheoremTransport;
  /** Composer interface for the host profile — see `useTheoremInterface`. `null` while loading. */
  iface: ComposerProfileInterface | null;
  /**
   * The ref of a conversation to resume, as `onConversationChange` reported it. Read once, when
   * the chat mounts: the chat draws the conversation as the host keeps it. A stateless profile
   * keeps no conversation, so it has no ref.
   */
  conversation?: string;
  /**
   * The conversation under `conversation` as the host showed it with the ref, as
   * `startConversation` returns it. Read once, when the chat mounts: the chat draws it at once,
   * and does not read it from the host again.
   */
  conversationView?: ConversationView;
  /** The text the composer starts with. Read once, when the chat mounts. */
  initialText?: string;
  /**
   * Each new ref the host issues for the conversation: once the message posts, and again as the
   * reply's runs are saved. Keep the latest to resume the chat later.
   */
  onConversationChange?: (ref: string) => void;
  /**
   * The value chosen for each of the profile's `inputs.slots`. Sent with every turn. A slot you
   * name here is fixed to that value; one you leave out is chosen in the composer, starting at
   * its first allowed value.
   */
  slots?: Record<string, string>;
  /** Told each time the visitor chooses a slot in the composer, with every slot's value. */
  onSlotsChange?: (slots: Record<string, string>) => void;
  /** What the page wants the agent to know: any JSON. The latest value goes with every turn. */
  context?: unknown;
  /** The page's tools, by name: each answers a tool the profile declares with `answeredBy: 'page'`. */
  pageTools?: PageTools;
  /**
   * Every event of every turn, as it arrives and before the transcript takes it: the ones the
   * transcript shows, and the ones it does not (a stage, a session, a guardrail decision).
   */
  onTurnEvent?: TurnEventSink;
};

/**
 * The slots the profile declares and the value of each: the page's where it names one, else what
 * the visitor chose, else the first allowed value.
 */
function useSlotChoices(
  iface: ComposerProfileInterface | null,
  fixed: Record<string, string> | undefined,
  onSlotsChange: ((slots: Record<string, string>) => void) | undefined,
) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const declared = iface?.inputs.slots;
  const values = useMemo(() => {
    const out: Record<string, string> = { ...fixed };
    for (const [name, allowed] of Object.entries(declared ?? {})) {
      const value = fixed?.[name] ?? picked[name] ?? allowed[0];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }, [declared, fixed, picked]);
  const choose = useCallback(
    (name: string, value: string) => {
      setPicked((prev) => ({ ...prev, [name]: value }));
      onSlotsChange?.({ ...values, [name]: value });
    },
    [values, onSlotsChange],
  );
  const isChosen = declared !== undefined && Object.keys(declared).length > 0;
  return {
    values: isChosen || fixed ? values : undefined,
    choices: isChosen ? { declared, values, onChange: choose } : undefined,
  };
}

/** What the page sends with each turn besides the message. */
type TurnValues = Pick<UseTheoremChatOptions, 'slots' | 'context'>;

/**
 * Settles legacy page gates as unanswered. Browser callbacks require an active dispatch grant.
 */
function usePageAnswers(
  gated: InterfaceTurnSession['gatedTool'],
  pageTools: PageTools | undefined,
  answer: (resolution: ToolGateResolution) => Promise<void>,
) {
  const answered = useRef<string | null>(null);
  const latest = useRef({ pageTools, answer });
  latest.current = { pageTools, answer };
  const waiting = gated?.gateKind === 'page' ? gated : null;
  useEffect(() => {
    if (!waiting?.operationId || answered.current === waiting.operationId) return;
    const operationId = waiting.operationId;
    answered.current = operationId;
    // invariant: A restored page gate cannot authorize callback execution. Only active dispatch grants do.
    void latest.current.answer({ action: 'page', page: { unanswered: true } });
  }, [waiting]);
}

/** The page's side of a chat: answers the calls that wait on it, and warns of a tool it cannot answer. */
function usePageTools(
  iface: UseTheoremChatOptions['iface'],
  waitingOn: InterfaceTurnSession['gatedTool'],
  pageTools: PageTools | undefined,
  answer: (resolution: ToolGateResolution) => Promise<void>,
) {
  usePageAnswers(waitingOn, pageTools, answer);
  usePageToolWarnings(iface && 'tools' in iface ? iface.tools.page : undefined, pageTools);
}

/** What `sendText` hands back: the blocks the turn added, its user message and the reply. */
export type SentTurn = { blocks: TranscriptBlock[] };

/**
 * Seed the session with the profile's default model / effort once the interface loads, and keep
 * it valid as the interface changes: a pick still on the old defaults follows the new ones, and a
 * pick the profile no longer has falls back to them (see `followGenerationDefaults`).
 */
function useDefaultGeneration(
  iface: ComposerProfileInterface | null,
  session: InterfaceTurnSession,
  setSession: SetSession,
): void {
  const previous = useRef<ComposerProfileInterface | undefined>(undefined);
  useEffect(() => {
    if (!iface) return;
    const next = followGenerationDefaults(
      iface,
      { model: session.selectedModel, effort: session.selectedEffort },
      previous.current,
    );
    previous.current = iface;
    if (next.model === session.selectedModel && next.effort === session.selectedEffort) return;
    setSession((prev) => ({ ...prev, selectedModel: next.model, selectedEffort: next.effort }));
  }, [session.selectedEffort, session.selectedModel, setSession, iface]);
}

type ChatState = ReturnType<typeof useTheoremChatState>;

/** The ref of the conversation the chat continues, adopted as each run's stream carries it. */
type ConversationRef = {
  ref: MutableRefObject<string | undefined>;
  adopt(ref: string): void;
};

function useConversationRef(
  initial: string | undefined,
  onChange: ((ref: string) => void) | undefined,
): ConversationRef {
  const ref = useRef(initial);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const adopt = useCallback((next: string) => {
    if (ref.current === next) return;
    ref.current = next;
    onChangeRef.current?.(next);
  }, []);
  return useMemo(() => ({ ref, adopt }), [adopt]);
}

/** Draws the conversation as the host shows it: its transcript, and the reply that waits on gates. */
function drawConversation(
  state: ChatState,
  view: ConversationView,
  session: InterfaceTurnSession,
  events: readonly TurnEvent[],
): void {
  state.setBlocks(view.transcript);
  state.setStreamBlocks(view.paused?.blocks ?? []);
  // why: A reply at rest leaves the run's own events (tokens, an ask); a paused one, the host's.
  state.setSession(sessionAfter(session, view.paused?.events ?? events));
  state.setChatStarted(view.transcript.length > 0 || view.paused !== undefined);
}

/** The streamed blocks, ending on the turn's error unless the stream already carried it. */
function withTurnError(blocks: TranscriptBlock[], error: string): TranscriptBlock[] {
  if (blocks.some((block) => block.kind === 'error')) return blocks;
  return [...blocks, { id: crypto.randomUUID(), kind: 'error', message: error }];
}

/** A failure the composer shows: none when the person stopped the run. */
function showComposerFailure(state: ChatState, failure: TurnFailure | undefined): void {
  if (!failure || failure.aborted) return;
  const { error, errorKind, errorInternal } = failure;
  state.setFailure({ error, errorKind, ...(errorInternal ? { errorInternal } : {}) });
  if (failure.issues) state.setIssues(failure.issues);
}

/**
 * The run begins: busy, and streaming unless its message goes live when it
 * posts (onUserBlocks), so the previous reply never renders as streaming in
 * between. Returns the delivery before it, which a new message replaces.
 */
function beginRun(state: ChatState, message: boolean): ChatState['deliveryRef']['current'] {
  state.setFailure(null);
  const priorDelivery = state.deliveryRef.current;
  state.busyRef.current = true;
  state.setBusy(true);
  if (!message) state.setStreaming(true);
  state.allowQueueDrainRef.current = false;
  return priorDelivery;
}

/** The run is over: nothing streams, and nothing can stop or steer it. */
function endRun(state: ChatState): void {
  state.cancelPendingStreamFrame();
  state.busyRef.current = false;
  state.setBusy(false);
  state.setStreaming(false);
  state.abortRef.current = null;
  state.turnIdRef.current = null;
}

/** Where the chat stood when a run began. */
type RunStart = { blocks: TranscriptBlock[]; streamBlocks: TranscriptBlock[] };

/** A message that never reached the conversation leaves the transcript and goes back in the composer. */
async function takeBackMessage(
  state: ChatState,
  start: RunStart,
  restore: () => Promise<void>,
): Promise<void> {
  state.setBlocks(start.blocks);
  state.setStreamBlocks(start.streamBlocks);
  state.setChatStarted(start.blocks.length > 0 || start.streamBlocks.length > 0);
  state.setDelivery(null);
  await restore();
}

/**
 * A host that keeps the conversation is the truth: the chat draws it again
 * from its ref, even after a message that never posted (a walk can settle
 * calls before it fails). A failure shows in the composer unless the host's
 * transcript closed on it. Returns whether the reply waits on gates.
 */
async function settleHosted(
  state: ChatState,
  transport: TheoremTransport,
  conversation: string | undefined,
  outcome: RunOutcome,
  start: RunStart,
): Promise<boolean> {
  const { failure } = outcome;
  if (failure) state.setDelivery(null);
  if (conversation === undefined) {
    state.setStreamBlocks(start.streamBlocks);
    showComposerFailure(state, failure);
    return state.sessionRef.current.gatedTool !== null;
  }
  const view = await transport.conversation({ conversation });
  drawConversation(state, view, outcome.session, outcome.events);
  if (!view.transcript.slice(start.blocks.length).some((b) => b.kind === 'error')) {
    showComposerFailure(state, failure);
  }
  return view.paused !== undefined;
}

/**
 * A stateless chat keeps the reply as the run streamed it: in the transcript
 * once it ends (closed by its failure, or by the person's stop), or beside it
 * while it waits on a gate. Returns whether it waits.
 */
function settleLocal(
  state: ChatState,
  iface: ComposerProfileInterface,
  outcome: RunOutcome,
  worked: { workedMs: number; endedAt: number },
): boolean {
  const session = sessionAfter(outcome.session, outcome.events);
  const { failure } = outcome;
  const reply = stampWorked(foldAssistantTurn(iface, outcome.events), worked);
  state.setSession(session);
  if (session.gatedTool !== null) {
    state.setStreamBlocks(reply);
    showComposerFailure(state, failure);
    return true;
  }
  state.setStreamBlocks([]);
  if (!failure) {
    state.setBlocks((prev) => [...prev, ...reply]);
    return false;
  }
  state.setDelivery(null);
  const closing: TranscriptBlock[] = failure.aborted
    ? [{ id: crypto.randomUUID(), kind: 'turn-done', stop: { kind: 'cancelled' } }]
    : withTurnError(reply, failure.error);
  state.setBlocks((prev) => [...prev, ...closing]);
  if (failure.issues) state.setIssues(failure.issues);
  return false;
}

/**
 * Draws the conversation the chat resumes, once the interface says the host
 * keeps one. A run that starts first draws it itself.
 */
function useResumedConversation(
  iface: ComposerProfileInterface | null,
  transport: TheoremTransport,
  state: ChatState,
  conversation: ConversationRef,
  shown: ConversationView | undefined,
): void {
  const loaded = useRef(false);
  const shownRef = useRef(shown);
  useEffect(() => {
    if (!iface || loaded.current) return;
    loaded.current = true;
    const ref = conversation.ref.current;
    if (ref === undefined || !keepsConversation(iface)) return;
    if (shownRef.current) {
      drawConversation(state, shownRef.current, state.sessionRef.current, []);
      return;
    }
    void (async () => {
      const before = state.blocksRef.current;
      try {
        const view = await transport.conversation({ conversation: ref });
        // why: A message sent while it loaded posted onto the host's conversation; its run draws it.
        if (state.blocksRef.current !== before || state.busyRef.current) return;
        drawConversation(state, view, state.sessionRef.current, []);
      } catch (err) {
        showComposerFailure(state, turnFailure(err, iface.labels));
      }
    })();
  }, [conversation, iface, state, transport]);
}

/**
 * Runs one turn's stream into the transcript: live partials while it streams,
 * then what the run left (or its failure) and the pending queue's next step.
 */
function useRunTurnStream(
  iface: ComposerProfileInterface | null,
  transport: TheoremTransport,
  state: ChatState,
  conversation: ConversationRef,
): RunTurnStream {
  // why: A stateless reply's work across its runs: a gate splits a reply into runs, and the wait between doesn't count.
  const replyWorkedMs = useRef(0);
  // why: Steers the reply never took wait at the front of the queue.
  const onRunEnded = useCallback(
    (drain: boolean) => {
      state.setPendingMessages((prev) =>
        orderComposerPendingMessages(convertSteersToFrontQueued(prev)),
      );
      state.allowQueueDrainRef.current = drain;
    },
    [state],
  );

  return useCallback(
    async (run, options = {}) => {
      if (!iface || state.busyRef.current) return;
      const { message } = options;
      const priorDelivery = beginRun(state, message !== undefined);
      const start: RunStart = {
        blocks: state.blocksRef.current,
        streamBlocks: state.streamBlocksRef.current,
      };
      // why: A run that answers a gate continues its reply; any other starts one.
      if (!state.sessionRef.current.gatedTool) replyWorkedMs.current = 0;
      const runStartedAt = Date.now();

      const work = (async () => {
        const view: StreamView = {
          blocks: (partial) => state.scheduleStreamBlocks(partial),
          // why: The reply goes on; the composer names what it left out.
          skipped: (error) => state.setFailure(clientFailure(error, iface.labels)),
        };
        const outcome = await run(view);
        const endedAt = Date.now();
        replyWorkedMs.current += endedAt - runStartedAt;
        endRun(state);

        const unposted = message !== undefined && !outcome.posted;
        // why: A message that posts itself (onUserBlocks) gets a fresh delivery.
        if (unposted && state.deliveryRef.current !== priorDelivery) {
          await takeBackMessage(state, start, message.restore);
        }
        let waits: boolean;
        if (keepsConversation(iface)) {
          waits = await settleHosted(state, transport, conversation.ref.current, outcome, start);
        } else if (unposted) {
          showComposerFailure(state, outcome.failure);
          waits = state.sessionRef.current.gatedTool !== null;
        } else {
          waits = settleLocal(state, iface, outcome, { workedMs: replyWorkedMs.current, endedAt });
        }
        onRunEnded(!outcome.failure && !waits);
      })();

      state.runPromiseRef.current = work;
      try {
        await work;
      } catch (err) {
        // why: The run left no view to draw; the composer says so, and the chat stays as it stood.
        showComposerFailure(state, turnFailure(err, iface.labels));
        onRunEnded(false);
      } finally {
        if (state.runPromiseRef.current === work) state.runPromiseRef.current = null;
      }
    },
    [conversation, iface, onRunEnded, state, transport],
  );
}

/** Start the next queued message once the run goes idle, when the run that ended allows it. */
function useQueueDrain(
  phase: ComposerRunPhase,
  state: ChatState,
  startTurnFromDraft: (
    draft: ComposerPendingMessage['draft'],
    options: { onPosted(): void },
  ) => Promise<void>,
): void {
  const drainQueue = useCallback(async () => {
    if (state.drainLockRef.current || state.busyRef.current || state.sessionRef.current.gatedTool) {
      return;
    }
    const { message } = consumeNextComposerQueue(state.pendingRef.current);
    if (!message) return;
    state.drainLockRef.current = true;
    try {
      // why: The message leaves the queue once it posts; one that never starts stays queued.
      await startTurnFromDraft(message.draft, {
        onPosted: () =>
          state.setPendingMessages((prev) => removeComposerPendingMessage(prev, message.id)),
      });
    } finally {
      state.drainLockRef.current = false;
    }
  }, [startTurnFromDraft, state]);

  useEffect(() => {
    if (phase !== 'idle' || !state.allowQueueDrainRef.current) return;
    if (!state.pendingMessages.some((m) => m.kind === 'queue')) {
      state.allowQueueDrainRef.current = false;
      return;
    }
    state.allowQueueDrainRef.current = false;
    void drainQueue();
  }, [drainQueue, phase, state]);
}

const DELIVERY_ORDER: readonly MessageDelivery[] = ['sending', 'sent', 'delivered', 'read'];

/** The server's own reports (bookkeeping, a failure, the end), which say nothing of the model having the message. */
const SERVER_EVENTS = new Set(['stage', 'guardrail', 'session', 'error', 'done']);
/** The reply itself (its thinking and tool calls come before it). */
const REPLY_EVENTS = new Set(['text', 'structured', 'media']);

/**
 * How far a line shows the message got: the host saving it, or any event,
 * means the server took it; one from the model (thinking, a tool call) means
 * the model has it, and the reply means it was read. A save without the
 * message (a walk settling calls) says nothing of it.
 */
function deliveryOf(line: ChatLine): MessageDelivery | undefined {
  if (line.type === 'conversation') return line.posted ? 'sent' : undefined;
  if (REPLY_EVENTS.has(line.type)) return 'read';
  return SERVER_EVENTS.has(line.type) ? 'sent' : 'delivered';
}

/** Moves the message's delivery on to what `line` shows it reached, never back. */
function advanceDelivery(
  deliveryRef: ChatState['deliveryRef'],
  setDelivery: ChatState['setDelivery'],
  line: ChatLine,
): void {
  const delivery = deliveryRef.current;
  const reached = deliveryOf(line);
  if (!delivery || !reached) return;
  if (DELIVERY_ORDER.indexOf(reached) > DELIVERY_ORDER.indexOf(delivery.status)) {
    setDelivery({ status: reached });
  }
}

/**
 * The transport, with each turn's events also clearing the steers they report
 * as landed (so the run's end requeues only the steers the agent never saw),
 * and moving the posted message's delivery forward. The chat adopts each
 * conversation ref as it arrives, so a page that reloads mid-reply keeps the
 * posted message. Each turn carries the page's slots and context as they are
 * when it is sent.
 */
function useTappedTransport(
  transport: TheoremTransport,
  state: ChatState,
  conversation: ConversationRef,
  values: TurnValues,
  onTurnEvent: TurnEventSink | undefined,
): TheoremTransport {
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onTurnEventRef = useRef(onTurnEvent);
  onTurnEventRef.current = onTurnEvent;
  return useMemo(() => {
    const withValues = (request: TheoremTurnRequest): TheoremTurnRequest => {
      const { slots, context } = valuesRef.current;
      if (slots === undefined && context === undefined) return request;
      return {
        ...request,
        input: {
          ...request.input,
          ...(slots === undefined ? {} : { slots }),
          ...(context === undefined ? {} : { context }),
        },
      };
    };
    const tap =
      (onLine: ChatLineSink): ChatLineSink =>
      (line) => {
        if (line.type === 'stage' && line.injected?.length) {
          state.pendingRef.current = removeLandedSteers(state.pendingRef.current, line);
          state.setPendingMessages((prev) => removeLandedSteers(prev, line));
        }
        advanceDelivery(state.deliveryRef, state.setDelivery, line);
        if (line.type === 'conversation') conversation.adopt(line.ref);
        else onTurnEventRef.current?.(line);
        onLine(line);
      };
    return {
      ...transport,
      turn: (request, onLine, signal) => transport.turn(withValues(request), tap(onLine), signal),
      invoke: (request, onLine, signal) => transport.invoke(request, tap(onLine), signal),
    };
  }, [
    transport,
    conversation,
    state.pendingRef,
    state.setPendingMessages,
    state.deliveryRef,
    state.setDelivery,
  ]);
}

/**
 * Headless chat model: transcript, streaming, composer drafts, pending
 * queue / steer / stash, tool gates. Render it with `@theoremjs/react/ui` or
 * your own components.
 */
export function useTheoremChat({
  transport,
  iface,
  conversation: initialConversation,
  conversationView,
  initialText,
  onConversationChange,
  slots,
  onSlotsChange,
  context,
  pageTools,
  onTurnEvent,
}: UseTheoremChatOptions) {
  const slotState = useSlotChoices(iface, slots, onSlotsChange);
  const state = useTheoremChatState(initialText);
  const conversation = useConversationRef(initialConversation, onConversationChange);
  useResumedConversation(iface, transport, state, conversation, conversationView);
  useDefaultGeneration(iface, state.session, state.setSession);

  const gated = state.session.gatedTool !== null;
  const phase: ComposerRunPhase = state.busy ? 'streaming' : gated ? 'gated' : 'idle';

  const handleGenerationChange = useCallback(
    (next: { modelId: string; effort?: string }) => {
      const effort =
        next.effort ?? (iface ? defaultInterfaceEffort(iface, next.modelId) : undefined);
      state.setSession((prev) => ({
        ...prev,
        selectedModel: next.modelId,
        ...(effort ? { selectedEffort: effort } : { selectedEffort: undefined }),
      }));
    },
    [iface, state],
  );

  const runTurnStream = useRunTurnStream(iface, transport, state, conversation);

  const pageTransport = useMemo(
    () => withPageToolDispatch(transport, pageTools),
    [transport, pageTools],
  );
  const steerTransport = useTappedTransport(
    pageTransport,
    state,
    conversation,
    { slots: slotState.values, context },
    onTurnEvent,
  );
  const actions = useTheoremChatActions({
    ...state,
    iface,
    transport: steerTransport,
    conversationRef: conversation.ref,
    phase,
    gated,
    runTurnStream,
  });

  useQueueDrain(phase, state, actions.startTurnFromDraft);
  usePageTools(
    iface,
    phase === 'gated' ? state.session.gatedTool : null,
    pageTools,
    actions.resumeGatedTool,
  );

  /** Sends `text` as the composer would, and resolves once the reply is done; `null` when it can't go now. */
  const sendText = useCallback(
    async (text: string): Promise<SentTurn | null> => {
      if (!iface || state.busyRef.current || state.sessionRef.current.gatedTool !== null)
        return null;
      const before = state.blocksRef.current.length;
      await actions.startTurnFromFields({ text, files: [], voice: [] });
      return { blocks: state.blocksRef.current.slice(before) };
    },
    [actions, iface, state],
  );

  /**
   * Cut the conversation after transcript block `index`. A host that keeps
   * the conversation cuts it (walking away from a reply that waits on gates)
   * and the chat draws what it returns; a stateless chat cuts its own.
   */
  const handleBranch = useCallback(
    async (index: number) => {
      if (!iface || state.busyRef.current) return;
      const ref = conversation.ref.current;
      if (!keepsConversation(iface) || ref === undefined) {
        const kept = [...state.blocksRef.current, ...state.streamBlocksRef.current].slice(
          0,
          index + 1,
        );
        state.setBlocks(kept);
        state.setStreamBlocks([]);
        state.setChatStarted(kept.length > 0);
        // why: The kept transcript's last message isn't the one whose delivery was tracked.
        state.setDelivery(null);
        state.setSession((prev) => branchInterfaceTurnSession(prev, kept));
        return;
      }
      state.setFailure(null);
      try {
        // why: The paused reply is not in the host's transcript; a cut inside it keeps the transcript whole.
        const at = Math.min(index, state.blocksRef.current.length - 1);
        const rewound = await transport.rewind({ conversation: ref, at });
        conversation.adopt(rewound.conversation);
        drawConversation(state, rewound.view, state.sessionRef.current, []);
        state.setDelivery(null);
      } catch (err) {
        showComposerFailure(state, turnFailure(err, iface.labels));
      }
    },
    [conversation, iface, state, transport],
  );

  const handlePendingQueue = useCallback(
    (id: string) => {
      const message = state.pendingRef.current.find((m) => m.id === id);
      if (message?.kind !== 'stash') return;
      if (phase === 'idle') {
        state.allowQueueDrainRef.current = true;
      }
      state.setPendingMessages((prev) => promoteComposerPendingKind(prev, id, 'queue'));
    },
    [phase, state],
  );

  return {
    iface,
    blocks: state.blocks,
    chatStarted: state.chatStarted,
    draftText: state.draftText,
    failure: state.failure,
    /** The answer on its way to a gate, shown on it until the answer settles or fails. */
    answering: state.answering,
    issues: state.issues,
    pendingFiles: state.pendingFiles,
    pendingMessages: state.pendingMessages,
    pendingVoice: state.pendingVoice,
    phase,
    session: state.session,
    /** The latest message's delivery; `null` before the first and once its turn failed. */
    delivery: state.delivery?.status ?? null,
    streamBlocks: state.streamBlocks,
    streaming: state.streaming,
    setDraftText: state.setDraftText,
    setPendingFiles: state.setPendingFiles,
    setPendingVoice: state.setPendingVoice,
    setPendingMessages: state.setPendingMessages,
    setIssues: state.setIssues,
    handleAuthenticated: actions.handleAuthenticated,
    handleBranch,
    handleSubmit: actions.handleSubmit,
    handleStop: actions.handleStop,
    handleMenuAction: actions.handleMenuAction,
    handlePendingQueue,
    handlePendingRestore: actions.handlePendingRestore,
    handleSendNow: actions.handleSendNow,
    handleToolDecision: actions.handleToolDecision,
    handleGenerationChange,
    slotChoices: slotState.choices,
    sendText,
  };
}
