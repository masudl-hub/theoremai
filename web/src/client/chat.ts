import { TheoremError, type TurnEvent } from '@theoremjs/agents';
import {
  type AttachmentValidationIssue,
  branchInterfaceTurnSession,
  type ComposerMenuAction,
  type ComposerPendingMessage,
  type ComposerProfileInterface,
  type ComposerRunPhase,
  consumeNextComposerQueue,
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  defaultInterfaceEffort,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  removeLandedSteers,
  type TranscriptBlock,
  type UserTurnDraft,
  userDraftHasPayload,
  userDraftToSteerInject,
} from '@theoremjs/agents/interface';
import { composerHasPayload } from './composer-primary.ts';
import { composerFieldsFromDraft } from './decode-composer-draft.ts';
import { encodeComposerDraft } from './encode-composer-draft.ts';
import { type ClientFailure, clientFailure, type TurnFailure, turnFailure } from './failure.ts';
import { followGenerationDefaults } from './generation-selection.ts';
import { type PageTools, warnPageToolMismatch } from './live/live-page-tool.ts';
import { withPageToolDispatch } from './page-dispatch.ts';
import { sessionAfter, stampWorked, stoppedReply } from './run-commit.ts';
import {
  keepsConversation,
  type RunOutcome,
  resumeInterfaceTool,
  type StreamView,
  streamInterfaceDraftTurn,
  streamInterfaceTurn,
} from './run-session.ts';
import type { AnsweringGate, ToolDecisionAction, ToolGateResolution } from './tool-resume.ts';
import {
  type ChatLine,
  type ChatLineSink,
  type ConversationView,
  isUnknownConversation,
  type TheoremTransport,
  type TheoremTurnRequest,
  type TurnEventSink,
} from './transport.ts';
import { foldAssistantTurn, issuedOperationId, type RunScope } from './turn-client.ts';

export type ChatOptions = {
  transport: TheoremTransport;
  /** The profile's composer interface, as `transport.describe()` returns it. `null` while it loads. */
  iface: ComposerProfileInterface | null;
  /**
   * The ref of a conversation to resume, as `onConversationChange` reported it. Read once, when
   * the chat is created: the chat draws the conversation as the host keeps it. A stateless profile
   * keeps no conversation, so it has no ref.
   */
  conversation?: string;
  /**
   * The conversation under `conversation` as the host showed it with the ref, as
   * `startConversation` returns it. Read once, when the chat is created: the chat draws it at
   * once, and does not read it from the host again.
   */
  conversationView?: ConversationView;
  /** The text the composer starts with. Read once, when the chat is created. */
  initialText?: string;
  /** The files the composer starts with, staged to send. Read once, when the chat is created. */
  initialFiles?: readonly File[];
  /** The voice notes the composer starts with, staged to send. Read once, when the chat is created. */
  initialVoice?: readonly File[];
  /**
   * The messages the composer starts with set aside: queued, stashed or steering. Read once, when
   * the chat is created.
   */
  initialPending?: readonly ComposerPendingMessage[];
  /**
   * Each new ref the host issues for the conversation: once the message posts, and again as the
   * reply's runs are saved. Keep the latest to resume the chat later. `undefined` when the host
   * can no longer open the ref the chat resumed: the chat starts a new one, so forget it.
   */
  onConversationChange?: (ref: string | undefined) => void;
  /**
   * The value chosen for each of the profile's `inputs.slots`. Sent with every turn. A slot you
   * name here is fixed to that value; one you leave out is the visitor's to pick (the chat's
   * `pickSlot`), starting at its first allowed value.
   */
  slots?: Record<string, string>;
  /** Told each time the visitor picks a slot, with every slot's value. */
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
 * How far the latest message has got: posted (`sending`), taken by the server
 * (`sent`), reached the model (`delivered`), answered (`read`).
 */
export type MessageDelivery = 'sending' | 'sent' | 'delivered' | 'read';

/** The slots the profile declares, and the value of each: the page's, else the picked one, else the first allowed. */
export type ChatSlots = {
  declared: Record<string, string[]>;
  values: Record<string, string>;
};

/** Everything a chat shows. A new object on each change, the same one between changes. */
export type ChatState = {
  iface: ComposerProfileInterface | null;
  /** The transcript. */
  blocks: TranscriptBlock[];
  /** The reply as it streams, or the reply that waits on a gate. */
  streamBlocks: TranscriptBlock[];
  chatStarted: boolean;
  draftText: string;
  pendingFiles: File[];
  pendingVoice: File[];
  /** Steered, queued, and stashed messages. */
  pendingMessages: ComposerPendingMessage[];
  issues: AttachmentValidationIssue[];
  /** The failure the composer shows. */
  failure: ClientFailure | null;
  /** The answer on its way to a gate, shown on it until the answer settles or fails. */
  answering: AnsweringGate | null;
  phase: ComposerRunPhase;
  session: InterfaceTurnSession;
  /** The latest message's delivery; `null` before the first and once its turn failed. */
  delivery: MessageDelivery | null;
  streaming: boolean;
  /** `undefined` when the profile declares no slots. */
  slots: ChatSlots | undefined;
};

/** What `sendText` hands back: the blocks the turn added, its user message, and the reply. */
export type SentTurn = { blocks: TranscriptBlock[] };

/** A new value, or a function of the current one. */
export type ChatUpdate<T> = T | ((prev: T) => T);

/**
 * A chat with no UI framework: transcript, streaming, the composer's draft, the pending
 * steer / queue / stash, gates, branching, and resuming a conversation. Read it with `getState`,
 * follow it with `subscribe`, and act through its methods. Every method is bound, so pass them
 * as callbacks as they are.
 */
export type ChatController = {
  getState(): ChatState;
  /**
   * Called after each change, once per batch of changes. Returns the unsubscribe. Until the first
   * subscribe or send, the chat asks nothing of the host: a conversation resumed without its
   * `conversationView` is read then, and a restored page gate answered then.
   */
  subscribe(listener: () => void): () => void;
  /** The latest options. `conversation`, `conversationView` and `initialText` are read only at creation. */
  update(options: ChatOptions): void;
  setDraftText(value: ChatUpdate<string>): void;
  setPendingFiles(value: ChatUpdate<File[]>): void;
  setPendingVoice(value: ChatUpdate<File[]>): void;
  setPendingMessages(value: ChatUpdate<ComposerPendingMessage[]>): void;
  setIssues(value: ChatUpdate<AttachmentValidationIssue[]>): void;
  /** Sends the composer's draft when idle; queues it while a reply streams or waits on a gate. */
  submit(): Promise<void>;
  /** Stops the reply that is streaming. */
  stop(): void;
  /** Steers, queues, or stashes the composer's draft. A steer goes to the running turn. */
  enqueue(kind: 'queue' | 'steer' | 'stash'): Promise<void>;
  /**
   * Sends a pending message, or the composer's draft, now: a streaming reply stops first, and a
   * reply that waits on gates is walked away from.
   */
  sendNow(source?: ComposerPendingMessage): Promise<void>;
  menuAction(action: ComposerMenuAction): void;
  /** Puts a pending message back in the composer. What the composer holds is stashed first. */
  restorePending(id: string): Promise<void>;
  /** Moves a stashed message into the queue. At idle, the queue starts sending. */
  queuePending(id: string): void;
  /** Answers the gate the reply waits on. */
  decide(action: ToolDecisionAction): Promise<void>;
  /** The visitor signed in for the gated call, or gave its secret. */
  authenticate(secret?: string): Promise<void>;
  /**
   * Cuts the conversation after transcript block `index`. A host that keeps the conversation
   * cuts it (walking away from a reply that waits on gates); a stateless chat cuts its own.
   */
  branch(index: number): Promise<void>;
  /** The model, and its effort (its default when left out), for the next turn. */
  setGeneration(next: { modelId: string; effort?: string }): void;
  pickSlot(name: string, value: string): void;
  /**
   * Sends `text` and optional files as the composer would, and resolves once the reply is done;
   * `null` when it can't go now (a reply is streaming, or waits on a gate).
   */
  sendText(text: string, files?: readonly File[]): Promise<SentTurn | null>;
};

type ComposerFields = { text: string; files: File[]; voice: File[] };

/** Where the chat stood when a run began. */
type RunStart = { blocks: TranscriptBlock[]; streamBlocks: TranscriptBlock[] };

/** What a run is handed when it starts. */
type RunContext = {
  iface: ComposerProfileInterface;
  view: StreamView;
  transport: TheoremTransport;
  scope: RunScope;
  signal?: AbortSignal;
};

type RunOptions = {
  /** The run is a turn of its own, which the visitor can stop and steer. A gate's answer is not. */
  turn?: boolean;
  /** The run sends a message: one that never posts goes back in the composer with its failure. */
  message?: { restore(): Promise<void> };
};

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

/** The streamed blocks, ending on the turn's error unless the stream already carried it. */
/**
 * `next` with the ids `shown` gave the blocks in the same places. The host mints its own ids, so a
 * redraw from it would otherwise remount every message on screen, and cut short what eases there.
 */
function keepIds(
  shown: readonly TranscriptBlock[],
  next: readonly TranscriptBlock[],
): TranscriptBlock[] {
  return next.map((block, index) => {
    const was = shown[index];
    return was && was.kind === block.kind && was.id !== block.id ? { ...block, id: was.id } : block;
  });
}

function withTurnError(blocks: TranscriptBlock[], error: string): TranscriptBlock[] {
  if (blocks.some((block) => block.kind === 'error')) return blocks;
  return [...blocks, { id: crypto.randomUUID(), kind: 'error', message: error }];
}

function slotsOf(
  iface: ComposerProfileInterface | null,
  fixed: Record<string, string> | undefined,
  picked: Record<string, string>,
): { values: Record<string, string> | undefined; slots: ChatSlots | undefined } {
  const declared = iface?.inputs.slots ?? {};
  const values: Record<string, string> = { ...fixed };
  for (const [name, allowed] of Object.entries(declared)) {
    const value = fixed?.[name] ?? picked[name] ?? allowed[0];
    if (value !== undefined) values[name] = value;
  }
  const chosen = Object.keys(declared).length > 0;
  return {
    values: chosen || fixed ? values : undefined,
    slots: chosen ? { declared, values } : undefined,
  };
}

function sameSlots(a: ChatSlots | undefined, b: ChatSlots | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a.values);
  return (
    a.declared === b.declared &&
    keys.length === Object.keys(b.values).length &&
    keys.every((key) => a.values[key] === b.values[key])
  );
}

/** One frame later in a browser; a timer's tick elsewhere. Returns the cancel. */
function nextFrame(run: () => void): () => void {
  // why: The client also runs where there are no frames (a server, a test), so it asks before it uses them.
  const frames = globalThis as {
    requestAnimationFrame?: (callback: () => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  if (frames.requestAnimationFrame && frames.cancelAnimationFrame) {
    const id = frames.requestAnimationFrame(run);
    return () => frames.cancelAnimationFrame?.(id);
  }
  const id = setTimeout(run, 16);
  return () => clearTimeout(id);
}

function newTurnId(): string {
  return crypto.randomUUID();
}

class Chat implements ChatController {
  #options: ChatOptions;
  #state: ChatState;
  #notified: ChatState;
  #listeners = new Set<() => void>();
  #flushQueued = false;

  #busy = false;
  #abort: AbortController | null = null;
  #turnId: string | null = null;
  /** The visitor stopped the run in flight, so the queue waits. */
  #stopped = false;
  /** The run in flight; it settles, never rejects. */
  #run: Promise<void> | null = null;
  // why: A stateless reply's work across its runs: a gate splits a reply into runs, and the wait between doesn't count.
  #replyWorkedMs = 0;
  /** The run that ended let the queue send its next message. */
  #drainArmed = false;
  #draining = false;
  #conversation: string | undefined;
  // why: One object per posted message, so a run can tell whether it posted one.
  #delivery: { status: MessageDelivery } | null = null;
  #picked: Record<string, string> = {};
  #resumed = false;
  // why: A chat no one uses yet (one React's strict mode builds and drops) asks nothing of the host.
  #live = false;
  #defaultsFrom: ComposerProfileInterface | undefined;
  #answeredPage: string | null = null;
  #pageToolsWarned: string | undefined;
  #frame: (() => void) | null = null;
  #frameBlocks: TranscriptBlock[] | null = null;

  constructor(options: ChatOptions) {
    this.#options = options;
    this.#conversation = options.conversation;
    this.#state = {
      iface: options.iface,
      blocks: [],
      streamBlocks: [],
      chatStarted: false,
      draftText: options.initialText ?? '',
      pendingFiles: [...(options.initialFiles ?? [])],
      pendingVoice: [...(options.initialVoice ?? [])],
      pendingMessages: orderComposerPendingMessages([...(options.initialPending ?? [])]),
      issues: [],
      failure: null,
      answering: null,
      phase: 'idle',
      session: emptyInterfaceTurnSession(),
      delivery: null,
      streaming: false,
      slots: slotsOf(options.iface, options.slots, {}).slots,
    };
    this.#notified = this.#state;
    this.#warnPageTools();
    this.#settle();
  }

  getState = (): ChatState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (!this.#live) {
      this.#live = true;
      this.#settle();
    }
    return () => this.#listeners.delete(listener);
  };

  update = (options: ChatOptions): void => {
    this.#options = options;
    this.#warnPageTools();
    const { slots } = slotsOf(options.iface, options.slots, this.#picked);
    const patch: Partial<ChatState> = {};
    if (options.iface !== this.#state.iface) patch.iface = options.iface;
    if (!sameSlots(slots, this.#state.slots)) patch.slots = slots;
    if (Object.keys(patch).length > 0) this.#set(patch);
  };

  setDraftText = (value: ChatUpdate<string>): void => this.#apply('draftText', value);
  setPendingFiles = (value: ChatUpdate<File[]>): void => this.#apply('pendingFiles', value);
  setPendingVoice = (value: ChatUpdate<File[]>): void => this.#apply('pendingVoice', value);
  setPendingMessages = (value: ChatUpdate<ComposerPendingMessage[]>): void =>
    this.#apply('pendingMessages', value);
  setIssues = (value: ChatUpdate<AttachmentValidationIssue[]>): void =>
    this.#apply('issues', value);

  submit = async (): Promise<void> => {
    const { phase, draftText, pendingFiles, pendingVoice } = this.#state;
    if (phase !== 'idle') {
      await this.enqueue('queue');
      return;
    }
    this.#set({ issues: [] });
    await this.#sendFields({ text: draftText, files: [...pendingFiles], voice: [...pendingVoice] });
  };

  stop = (): void => {
    void this.#stop();
  };

  /** Asks the host to stop the turn, so the reply it leaves comes back; a host that can't drops the stream. */
  async #stop(): Promise<void> {
    const abort = this.#abort;
    const turnId = this.#turnId;
    if (!abort) return;
    this.#stopped = true;
    if (!turnId) {
      abort.abort();
      return;
    }
    try {
      await this.#options.transport.stop({ turnId });
    } catch {
      // why: The host isn't running the turn here (it ended, or another instance runs it); the stream is dropped instead.
      abort.abort();
    }
  }

  enqueue = async (kind: 'queue' | 'steer' | 'stash'): Promise<void> => {
    const { draftText, pendingFiles, pendingVoice } = this.#state;
    if (!composerHasPayload(draftText, pendingFiles, pendingVoice)) return;
    this.#set({ issues: [] });
    try {
      const draft = await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice });
      const message = createComposerPendingMessage({ kind, draft });
      this.#set({
        pendingMessages: orderComposerPendingMessages([...this.#state.pendingMessages, message]),
        ...this.#clearedComposer(),
      });
      if (kind !== 'steer') return;
      const turnId = this.#turnId;
      if (!turnId) {
        this.#steerAfterTurnEnded();
        return;
      }
      const inject = userDraftToSteerInject(draft);
      if (inject.length === 0) return;
      await this.#options.transport.steer({ turnId, id: message.id, inject });
    } catch (err) {
      this.#set({ failure: clientFailure(err, this.#options.iface?.labels) });
    }
  };

  sendNow = async (source?: ComposerPendingMessage): Promise<void> => {
    if (!this.#options.iface) return;
    const draft = source ? source.draft : await this.#composerDraft();
    if (!draft) return;
    if (this.#busy) {
      await this.#stop();
      await this.#run;
    }
    this.#set({ pendingMessages: convertSteersToFrontQueued(this.#state.pendingMessages) });
    this.#drainArmed = false;
    // why: Sent while the reply waits on gates, the message walks away from them in its own request.
    await this.#sendDraft(draft, {
      walkAway: this.#state.session.gatedTool !== null,
      // why: The sent message leaves the queue, or the composer it came from.
      onPosted: () =>
        this.#set(
          source
            ? {
                pendingMessages: removeComposerPendingMessage(
                  this.#state.pendingMessages,
                  source.id,
                ),
              }
            : this.#clearedComposer(),
        ),
    });
  };

  menuAction = (action: ComposerMenuAction): void => {
    if (action === 'queue' || action === 'steer' || action === 'stash') {
      void this.enqueue(action);
      return;
    }
    if (action === 'send_now') void this.sendNow();
  };

  restorePending = async (id: string): Promise<void> => {
    const message = this.#state.pendingMessages.find((m) => m.id === id);
    if (!message) return;
    try {
      await this.#restore(composerFieldsFromDraft(message.draft));
      this.#set({
        pendingMessages: removeComposerPendingMessage(this.#state.pendingMessages, id),
      });
    } catch (err) {
      this.#set({ failure: clientFailure(err, this.#options.iface?.labels) });
    }
  };

  queuePending = (id: string): void => {
    const message = this.#state.pendingMessages.find((m) => m.id === id);
    if (message?.kind !== 'stash') return;
    if (this.#state.phase === 'idle') this.#drainArmed = true;
    this.#set({
      pendingMessages: promoteComposerPendingKind(this.#state.pendingMessages, id, 'queue'),
    });
  };

  decide = (action: ToolDecisionAction): Promise<void> => this.#answerGate({ action });

  authenticate = (secret?: string): Promise<void> =>
    this.#answerGate({ action: 'auth', ...(secret === undefined ? {} : { secret }) });

  branch = async (index: number): Promise<void> => {
    const { iface } = this.#options;
    if (!iface || this.#busy) return;
    const ref = this.#conversation;
    if (!keepsConversation(iface) || ref === undefined) {
      const kept = [...this.#state.blocks, ...this.#state.streamBlocks].slice(0, index + 1);
      // why: The kept transcript's last message isn't the one whose delivery was tracked.
      this.#setDelivery(null);
      this.#set({
        blocks: kept,
        streamBlocks: [],
        chatStarted: kept.length > 0,
        session: branchInterfaceTurnSession(this.#state.session, kept),
      });
      return;
    }
    this.#set({ failure: null });
    try {
      // why: The paused reply is not in the host's transcript; a cut inside it keeps the transcript whole.
      const at = Math.min(index, this.#state.blocks.length - 1);
      const rewound = await this.#options.transport.rewind({ conversation: ref, at });
      this.#adopt(rewound.conversation);
      this.#draw(rewound.view, this.#state.session, []);
      this.#setDelivery(null);
    } catch (err) {
      this.#showFailure(turnFailure(err, iface.labels));
    }
  };

  setGeneration = (next: { modelId: string; effort?: string }): void => {
    const { iface } = this.#options;
    const effort = next.effort ?? (iface ? defaultInterfaceEffort(iface, next.modelId) : undefined);
    this.#set({
      session: { ...this.#state.session, selectedModel: next.modelId, selectedEffort: effort },
    });
  };

  pickSlot = (name: string, value: string): void => {
    const before = slotsOf(this.#options.iface, this.#options.slots, this.#picked).values;
    this.#picked = { ...this.#picked, [name]: value };
    this.#set({ slots: slotsOf(this.#options.iface, this.#options.slots, this.#picked).slots });
    this.#options.onSlotsChange?.({ ...before, [name]: value });
  };

  sendText = async (text: string, files: readonly File[] = []): Promise<SentTurn | null> => {
    if (!this.#options.iface || this.#state.phase !== 'idle') return null;
    const before = this.#state.blocks.length;
    await this.#sendFields({ text, files: [...files], voice: [] });
    return { blocks: this.#state.blocks.slice(before) };
  };

  #set(patch: Partial<ChatState>): void {
    const next = { ...this.#state, ...patch };
    next.phase = this.#busy ? 'streaming' : next.session.gatedTool ? 'gated' : 'idle';
    this.#state = next;
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    // why: Changes made together reach listeners once, after the code that made them has run.
    queueMicrotask(() => this.#flush());
  }

  #apply<K extends keyof ChatState>(key: K, value: ChatUpdate<ChatState[K]>): void {
    const next =
      typeof value === 'function'
        ? (value as (prev: ChatState[K]) => ChatState[K])(this.#state[key])
        : value;
    this.#set({ [key]: next } as Partial<ChatState>);
  }

  #flush(): void {
    this.#flushQueued = false;
    this.#settle();
    if (this.#flushQueued || this.#notified === this.#state) return;
    this.#notified = this.#state;
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * What follows from the state as it now stands: the profile's default model, the conversation
   * the chat resumes, a page gate that has no answer, and the queue's next message. Each is done
   * once, so settling again changes nothing.
   */
  #settle(): void {
    const { iface } = this.#options;
    if (!iface) return;
    this.#followDefaults(iface);
    this.#resume(iface);
    this.#answerPageGate();
    this.#drain();
  }

  #clearedComposer(): Pick<ChatState, 'draftText' | 'pendingFiles' | 'pendingVoice'> {
    return { draftText: '', pendingFiles: [], pendingVoice: [] };
  }

  #setDelivery(next: { status: MessageDelivery } | null): void {
    this.#delivery = next;
    this.#set({ delivery: next?.status ?? null });
  }

  #adopt(ref: string): void {
    if (this.#conversation === ref) return;
    this.#conversation = ref;
    this.#options.onConversationChange?.(ref);
  }

  #showFailure(failure: TurnFailure | undefined): void {
    if (!failure || failure.aborted) return;
    const { error, errorKind, errorInternal } = failure;
    this.#set({
      failure: { error, errorKind, ...(errorInternal ? { errorInternal } : {}) },
      ...(failure.issues ? { issues: failure.issues } : {}),
    });
  }

  /** Draws the conversation as the host shows it: its transcript, and the reply that waits on gates. */
  #draw(view: ConversationView, session: InterfaceTurnSession, events: readonly TurnEvent[]): void {
    const shown = [...this.#state.blocks, ...this.#state.streamBlocks];
    const blocks = keepIds(shown, view.transcript);
    this.#set({
      blocks,
      streamBlocks: keepIds(shown.slice(blocks.length), view.paused?.blocks ?? []),
      // why: A reply at rest leaves the run's own events (tokens, an ask); a paused one, the host's.
      session: sessionAfter(session, view.paused?.events ?? events),
      chatStarted: view.transcript.length > 0 || view.paused !== undefined,
    });
  }

  /**
   * Keeps the model and effort valid as the interface changes: a pick still on the old defaults
   * follows the new ones, and a pick the profile no longer has falls back to them.
   */
  #followDefaults(iface: ComposerProfileInterface): void {
    const { session } = this.#state;
    const next = followGenerationDefaults(
      iface,
      { model: session.selectedModel, effort: session.selectedEffort },
      this.#defaultsFrom,
    );
    this.#defaultsFrom = iface;
    if (next.model === session.selectedModel && next.effort === session.selectedEffort) return;
    this.#set({ session: { ...session, selectedModel: next.model, selectedEffort: next.effort } });
  }

  /** Draws the conversation the chat resumes, once. A run that starts first draws it itself. */
  #resume(iface: ComposerProfileInterface): void {
    if (this.#resumed) return;
    const ref = this.#conversation;
    const shown = this.#options.conversationView;
    if (ref !== undefined && !shown && !this.#live) return;
    this.#resumed = true;
    if (ref === undefined || !keepsConversation(iface)) return;
    if (shown) {
      this.#draw(shown, this.#state.session, []);
      return;
    }
    const before = this.#state.blocks;
    void this.#options.transport.conversation({ conversation: ref }).then(
      (view) => {
        // why: A message sent while it loaded posted onto the host's conversation; its run draws it.
        if (this.#state.blocks !== before || this.#busy) return;
        this.#draw(view, this.#state.session, []);
      },
      (err: unknown) => {
        // why: Nobody asked for the lost conversation by hand; the chat just starts a new one.
        if (!isUnknownConversation(err)) return this.#showFailure(turnFailure(err, iface.labels));
        if (this.#conversation !== ref) return;
        this.#conversation = undefined;
        this.#options.onConversationChange?.(undefined);
      },
    );
  }

  /**
   * Settles a restored page gate as unanswered.
   * invariant: A restored page gate cannot authorize callback execution. Only active dispatch grants do.
   */
  #answerPageGate(): void {
    if (!this.#live) return;
    const gated = this.#state.phase === 'gated' ? this.#state.session.gatedTool : null;
    if (gated?.gateKind !== 'page' || !gated.operationId) return;
    if (this.#answeredPage === gated.operationId) return;
    this.#answeredPage = gated.operationId;
    void this.#answerGate({ action: 'page', page: { unanswered: true } });
  }

  /** Sends the next queued message once the chat is idle, when the run that ended allowed it. */
  #drain(): void {
    if (this.#state.phase !== 'idle' || !this.#drainArmed) return;
    this.#drainArmed = false;
    if (this.#draining) return;
    const { message } = consumeNextComposerQueue(this.#state.pendingMessages);
    if (!message) return;
    this.#draining = true;
    // why: The message leaves the queue once it posts; one that never starts stays queued.
    void this.#sendDraft(message.draft, {
      onPosted: () =>
        this.#set({
          pendingMessages: removeComposerPendingMessage(this.#state.pendingMessages, message.id),
        }),
    }).finally(() => {
      this.#draining = false;
    });
  }

  /** Says in the console, once for each set of names, where the page's tools and the profile's disagree. */
  #warnPageTools(): void {
    const { iface, pageTools } = this.#options;
    const declared = iface && 'tools' in iface ? iface.tools.page : undefined;
    if (declared === undefined) return;
    const handled = Object.keys(pageTools ?? {}).sort();
    const key = JSON.stringify([declared, handled]);
    if (key === this.#pageToolsWarned) return;
    this.#pageToolsWarned = key;
    warnPageToolMismatch(declared, handled);
  }

  /** The composer's draft, when it holds something to send. */
  async #composerDraft(): Promise<UserTurnDraft | undefined> {
    const { draftText, pendingFiles, pendingVoice } = this.#state;
    const draft = await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice });
    return userDraftHasPayload(draft) ? draft : undefined;
  }

  /** Puts a message back in the composer. What the composer holds now is stashed first, so nothing typed is lost. */
  async #restore(fields: ComposerFields): Promise<void> {
    const { draftText, pendingFiles, pendingVoice } = this.#state;
    if (composerHasPayload(draftText, pendingFiles, pendingVoice)) {
      const draft = await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice });
      const stash = createComposerPendingMessage({ kind: 'stash', draft });
      this.#set({
        pendingMessages: orderComposerPendingMessages([...this.#state.pendingMessages, stash]),
      });
    }
    this.#set({
      draftText: fields.text,
      pendingFiles: fields.files,
      pendingVoice: fields.voice,
      issues: [],
    });
  }

  /** A steer with no running turn: the visitor reads `session.turn_ended`; steers, this one too, move to the front of the queue. */
  #steerAfterTurnEnded(): void {
    this.#set({
      failure: clientFailure(
        // labels-exempt: internal diagnostic; the user reads session.turn_ended
        new TheoremError('request', 'steer: no active turn', {
          copy: { key: 'session.turn_ended' },
        }),
        this.#options.iface?.labels,
      ),
      // why: The composer already gave the message up, so it waits as the next to send, not lost.
      pendingMessages: orderComposerPendingMessages(
        convertSteersToFrontQueued(this.#state.pendingMessages),
      ),
    });
  }

  /** The message posted: it joins the transcript, and the reply starts streaming. */
  #posted(blocks: TranscriptBlock[], patch: Partial<ChatState>): void {
    this.#setDelivery({ status: 'sending' });
    this.#set({
      blocks: [...this.#state.blocks, ...blocks],
      chatStarted: true,
      streaming: true,
      ...patch,
    });
  }

  #sendFields(fields: ComposerFields): Promise<void> {
    return this.#runTurn(
      ({ iface, view, transport, scope, signal }) =>
        streamInterfaceTurn({
          iface,
          transport,
          session: this.#state.session,
          text: fields.text,
          pendingFiles: fields.files,
          pendingVoice: fields.voice,
          signal,
          scope,
          view,
          transcript: this.#state.blocks,
          onUserBlocks: (blocks) => this.#posted(blocks, this.#clearedComposer()),
        }),
      { turn: true, message: { restore: () => this.#restore(fields) } },
    );
  }

  #sendDraft(
    draft: UserTurnDraft,
    options: { walkAway?: boolean; onPosted(): void },
  ): Promise<void> {
    return this.#runTurn(
      ({ iface, view, transport, scope, signal }) =>
        streamInterfaceDraftTurn({
          iface,
          transport,
          session: this.#state.session,
          draft,
          signal,
          scope,
          view,
          transcript: this.#state.blocks,
          walkAway: options.walkAway === true,
          onUserBlocks: (blocks) => {
            this.#posted(blocks, { streamBlocks: [] });
            options.onPosted();
          },
        }),
      { turn: true, message: { restore: () => this.#restore(composerFieldsFromDraft(draft)) } },
    );
  }

  async #answerGate(resolution: ToolGateResolution): Promise<void> {
    // why: Set once the run starts (not while another runs), and cleared once it has ended.
    let started = false;
    try {
      await this.#runTurn(({ iface, view, transport, scope }) => {
        started = true;
        const { session } = this.#state;
        // why: A person's answer shows on its gate while it settles; the page's has no gate to show on.
        if (session.gatedTool && resolution.action !== 'page') {
          this.#set({
            answering: {
              callId: session.gatedTool.callId,
              operationId: issuedOperationId(session.gatedTool),
              action: resolution.action,
            },
          });
        }
        return resumeInterfaceTool({ iface, transport, session, scope, resolution, view });
      });
    } finally {
      if (started) this.#set({ answering: null });
    }
  }

  /**
   * The transport each run uses: the page's tools answer their calls, each turn carries the
   * page's slots and context as they are when it is sent, and each line lands the steers it
   * reports, moves the message's delivery on, and hands the chat the conversation's new ref
   * (so a page that reloads mid-reply keeps the posted message).
   */
  #runTransport(): TheoremTransport {
    const { transport, pageTools } = this.#options;
    const base = withPageToolDispatch(transport, pageTools);
    const tap =
      (onLine: ChatLineSink): ChatLineSink =>
      (line) => {
        this.#took(line);
        onLine(line);
      };
    return {
      ...base,
      turn: (request, onLine, signal) => base.turn(this.#withValues(request), tap(onLine), signal),
      invoke: (request, onLine, signal) => base.invoke(request, tap(onLine), signal),
    };
  }

  #withValues(request: TheoremTurnRequest): TheoremTurnRequest {
    const { iface, slots: fixed, context } = this.#options;
    const slots = slotsOf(iface, fixed, this.#picked).values;
    if (slots === undefined && context === undefined) return request;
    return {
      ...request,
      input: {
        ...request.input,
        ...(slots === undefined ? {} : { slots }),
        ...(context === undefined ? {} : { context }),
      },
    };
  }

  /** One line of a run's stream, before the run folds it. */
  #took(line: ChatLine): void {
    if (line.type === 'stage' && line.injected?.length) {
      this.#set({ pendingMessages: removeLandedSteers(this.#state.pendingMessages, line) });
    }
    const reached = deliveryOf(line);
    const delivery = this.#delivery;
    if (
      delivery &&
      reached &&
      DELIVERY_ORDER.indexOf(reached) > DELIVERY_ORDER.indexOf(delivery.status)
    ) {
      this.#setDelivery({ status: reached });
    }
    if (line.type === 'conversation') this.#adopt(line.ref);
    else this.#options.onTurnEvent?.(line);
  }

  #streamFrame(partial: TranscriptBlock[]): void {
    this.#frameBlocks = partial;
    if (this.#frame) return;
    // why: A stream can carry many lines a frame; the chat draws the latest once per frame.
    this.#frame = nextFrame(() => {
      this.#frame = null;
      const next = this.#frameBlocks;
      this.#frameBlocks = null;
      if (next) this.#set({ streamBlocks: next });
    });
  }

  /**
   * Runs one stream into the transcript: live partials while it streams, then what the run left
   * (or its failure) and the queue's next step. Does nothing while another run is in flight.
   */
  async #runTurn(
    run: (context: RunContext) => Promise<RunOutcome>,
    options: RunOptions = {},
  ): Promise<void> {
    const { iface } = this.#options;
    if (!iface || this.#busy) return;
    this.#live = true;
    const { message } = options;
    const priorDelivery = this.#delivery;
    const abort = options.turn ? new AbortController() : null;
    const turnId = options.turn ? newTurnId() : undefined;
    this.#busy = true;
    this.#abort = abort;
    this.#turnId = turnId ?? null;
    this.#stopped = false;
    this.#drainArmed = false;
    // why: A message streams once it posts, so the previous reply never shows as streaming before it.
    this.#set({ failure: null, ...(message ? {} : { streaming: true }) });
    const start: RunStart = { blocks: this.#state.blocks, streamBlocks: this.#state.streamBlocks };
    // why: A run that answers a gate continues its reply; any other starts one.
    if (!this.#state.session.gatedTool) this.#replyWorkedMs = 0;
    const startedAt = Date.now();

    const done = (async () => {
      try {
        const outcome = await run({
          iface,
          transport: this.#runTransport(),
          scope: { conversation: this.#conversation, turnId },
          signal: abort?.signal,
          view: {
            blocks: (partial) => this.#streamFrame(partial),
            // why: The reply goes on; the composer names what it left out.
            skipped: (error) => this.#set({ failure: clientFailure(error, iface.labels) }),
          },
        });
        const endedAt = Date.now();
        this.#replyWorkedMs += endedAt - startedAt;
        this.#endRun();

        const unposted = message !== undefined && !outcome.posted;
        // why: A message that posts itself (onUserBlocks) gets a fresh delivery.
        if (unposted && this.#delivery !== priorDelivery) await this.#takeBack(start, message);
        let waits: boolean;
        if (keepsConversation(iface)) {
          waits = await this.#settleHosted(outcome, start);
        } else if (unposted) {
          this.#showFailure(outcome.failure);
          waits = this.#state.session.gatedTool !== null;
        } else {
          waits = this.#settleLocal(iface, outcome, { workedMs: this.#replyWorkedMs, endedAt });
        }
        this.#runEnded(!outcome.failure && !waits && !this.#stopped);
      } catch (err) {
        // why: The run left no view to draw; the composer says so, and the chat stays as it stood.
        this.#endRun();
        this.#showFailure(turnFailure(err, iface.labels));
        this.#runEnded(false);
      }
    })();
    this.#run = done;
    await done;
    if (this.#run === done) this.#run = null;
  }

  /** The run is over: nothing streams, and nothing can stop or steer it. */
  #endRun(): void {
    this.#frame?.();
    this.#frame = null;
    this.#frameBlocks = null;
    this.#busy = false;
    this.#abort = null;
    this.#turnId = null;
    this.#set({ streaming: false });
  }

  /** Steers the reply never took wait at the front of the queue; the queue sends on when `drain`. */
  #runEnded(drain: boolean): void {
    this.#drainArmed = drain;
    this.#set({
      pendingMessages: orderComposerPendingMessages(
        convertSteersToFrontQueued(this.#state.pendingMessages),
      ),
    });
  }

  /** A message that never reached the conversation leaves the transcript and goes back in the composer. */
  async #takeBack(start: RunStart, message: { restore(): Promise<void> }): Promise<void> {
    this.#setDelivery(null);
    this.#set({
      blocks: start.blocks,
      streamBlocks: start.streamBlocks,
      chatStarted: start.blocks.length > 0 || start.streamBlocks.length > 0,
    });
    await message.restore();
  }

  /**
   * A host that keeps the conversation is the truth: the chat draws it again from its ref, even
   * after a message that never posted (a walk can settle calls before it fails). A failure shows
   * in the composer unless the host's transcript closed on it. Returns whether the reply waits
   * on gates.
   */
  async #settleHosted(outcome: RunOutcome, start: RunStart): Promise<boolean> {
    const { failure } = outcome;
    if (failure) this.#setDelivery(null);
    const ref = this.#conversation;
    if (ref === undefined) {
      this.#set({ streamBlocks: start.streamBlocks });
      this.#showFailure(failure);
      return this.#state.session.gatedTool !== null;
    }
    const view = await this.#options.transport.conversation({ conversation: ref });
    this.#draw(view, outcome.session, outcome.events);
    if (!view.transcript.slice(start.blocks.length).some((b) => b.kind === 'error')) {
      this.#showFailure(failure);
    }
    return view.paused !== undefined;
  }

  /**
   * A stateless chat keeps the reply as the run streamed it: in the transcript once it ends
   * (closed by its failure, or by the visitor's stop), or beside it while it waits on a gate.
   * Returns whether it waits.
   */
  #settleLocal(
    iface: ComposerProfileInterface,
    outcome: RunOutcome,
    worked: { workedMs: number; endedAt: number },
  ): boolean {
    const session = sessionAfter(outcome.session, outcome.events);
    const { failure } = outcome;
    const reply = stampWorked(foldAssistantTurn(iface, outcome.events), worked);
    if (session.gatedTool !== null) {
      this.#set({ session, streamBlocks: reply });
      this.#showFailure(failure);
      return true;
    }
    if (!failure) {
      this.#set({ session, streamBlocks: [], blocks: [...this.#state.blocks, ...reply] });
      return false;
    }
    this.#setDelivery(null);
    const closing = failure.aborted
      ? stampWorked(stoppedReply(reply), worked)
      : withTurnError(reply, failure.error);
    this.#set({
      session,
      streamBlocks: [],
      blocks: [...this.#state.blocks, ...closing],
      ...(failure.issues ? { issues: failure.issues } : {}),
    });
    return false;
  }
}

/** A chat for `options`. Framework-free: see `ChatController`. */
export function createChatController(options: ChatOptions): ChatController {
  return new Chat(options);
}
