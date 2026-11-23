import {
  attachmentsRefused,
  type GateReference,
  type ProfileOptions,
  TheoremError,
  type TurnEvent,
} from '@theoremjs/agents';
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
  type GatedToolContext,
  type InterfaceTurnSession,
  moveComposerPendingWithinKind,
  orderComposerPendingMessages,
  prepareUserTurn,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  removeLandedSteers,
  saveComposerPendingMessage,
  type TranscriptBlock,
  takeSavedComposerPending,
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
import { sessionAfter, stampWorked, stoppedReply, streamFoldedTurn } from './run-commit.ts';
import {
  extractInlineEncodedAttachments,
  keepsConversation,
  type RunOutcome,
  resumeInterfaceTool,
  type StreamView,
  streamInterfaceDraftTurn,
  streamInterfaceTurn,
  streamInterfaceWake,
} from './run-session.ts';
import type { AnsweringGate, ToolDecisionAction, ToolGateResolution } from './tool-resume.ts';
import {
  type ChatLine,
  type ChatLineSink,
  type ClientTurnEvent,
  type ConversationView,
  isTurnEnded,
  isUnknownConversation,
  type RunningReply,
  type StatedTurn,
  type TheoremSteerRequest,
  type TheoremTransport,
  type TheoremTurnRequest,
  type TheoremWakeRequest,
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
   * The value chosen for each of the profile's `inputs.options`. Sent with every turn. An option you
   * name here is fixed to that value; one you leave out is the visitor's to pick (the chat's
   * `pickOption`), starting at its first allowed value.
   */
  options?: Record<string, string>;
  /** Which prompt lines each turn gets, for a host that lets its page choose (`pageStatesTurn`). */
  stated?: StatedTurn;
  /** Told each time the visitor picks an option, with every option's value. */
  onOptionsChange?: (options: Record<string, string>) => void;
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

/** The options the profile declares, and the value of each: the page's, else the picked one, else the first allowed. */
export type ChatOptionPicks = {
  declared: ProfileOptions;
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
  /**
   * The gate that waits for the person: a confirmation, a permission or a sign-in; `null` when
   * none waits. A page gate, which the page answers, is never one.
   */
  waitingGate: GatedToolContext | null;
  session: InterfaceTurnSession;
  /** The latest message's delivery; `null` before the first and once its turn failed. */
  delivery: MessageDelivery | null;
  streaming: boolean;
  /**
   * A reply that runs away from this page (another tab, another channel, or before a reload), as
   * the host's last read said; `null` when none does. While one runs the phase is `streaming`:
   * the page stops and steers it by the conversation, queues behind it, and its prompt shows in
   * `streamBlocks`.
   */
  runningElsewhere: RunningReply | null;
  /** `undefined` when the profile declares no options. */
  options: ChatOptionPicks | undefined;
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
  /**
   * Reads the conversation from the host and draws it. For a page told by its own channel that
   * something ended, such as a service worker that receives a Web Push. A run in flight reads it
   * anyway when it ends, and a failed read leaves the chat as it stands.
   */
  refresh(): Promise<void>;
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
   * Steers, queues, or stashes a message made elsewhere, as `enqueue` does the draft: a composer
   * shared by several chats gives each the same message, so its id names it in all of them.
   */
  pend(message: ComposerPendingMessage): Promise<void>;
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
  /** Moves a pending message one place up or down among those of its kind; `composerPendingMoves` says which ways it can go. */
  movePending(id: string, direction: 'up' | 'down'): void;
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
  pickOption(name: string, value: string): void;
  /**
   * Sends `text`, and what `options` adds, as the composer would, and resolves once the reply is
   * done; `null` when it can't go now (a reply is streaming, or waits on a gate).
   */
  sendText(text: string, options?: SendTextOptions): Promise<SentTurn | null>;
};

/**
 * What `sendText` sends with its text. A `model` becomes the chat's pick, as if chosen in the
 * composer; one the profile doesn't have is refused by the turn, not swapped for its default.
 */
export type SendTextOptions = {
  files?: readonly File[];
  voice?: readonly File[];
  model?: string;
  /** The model's effort. Left out, the model's default. */
  effort?: string;
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
  message?: SentMessage;
  /** The run wakes the conversation: it shows as streaming only once the host's reply begins. */
  wake?: true;
};

/** The message a run sends: its id, its draft, and how it goes back in the composer. */
type SentMessage = { id: string; draft(): Promise<UserTurnDraft>; restore(): Promise<void> };

const DELIVERY_ORDER: readonly MessageDelivery[] = ['sending', 'sent', 'delivered', 'read'];

/** The server's own reports (bookkeeping, a failure, the end), which say nothing of the model having the message. */
const SERVER_EVENTS = new Set([
  'stage',
  'guardrail',
  'late_results',
  'session',
  'hook_failed',
  'error',
  'done',
]);
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

function picksOf(
  iface: ComposerProfileInterface | null,
  fixed: Record<string, string> | undefined,
  picked: Record<string, string>,
): { values: Record<string, string> | undefined; options: ChatOptionPicks | undefined } {
  const declared = iface?.inputs.options ?? {};
  const values: Record<string, string> = { ...fixed };
  for (const [name, decl] of Object.entries(declared)) {
    const first = decl.choices[0]?.value;
    const value = fixed?.[name] ?? picked[name] ?? first;
    if (value !== undefined) values[name] = value;
  }
  const chosen = Object.keys(declared).length > 0;
  return {
    values: chosen || fixed ? values : undefined,
    options: chosen ? { declared, values } : undefined,
  };
}

function samePicks(a: ChatOptionPicks | undefined, b: ChatOptionPicks | undefined): boolean {
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

function newId(): string {
  return crypto.randomUUID();
}

/** A pending message's draft as the input a steer sends. */
function steerInput(draft: UserTurnDraft): TheoremSteerRequest['input'] {
  const attachments = extractInlineEncodedAttachments(draft.attachments);
  const voice = extractInlineEncodedAttachments(draft.voice);
  return {
    ...(draft.text?.trim() ? { text: draft.text } : {}),
    ...(attachments ? { attachments } : {}),
    ...(voice ? { voice } : {}),
  };
}

/** A reply that runs elsewhere, drawn from the host's lines: its prompt and the reply so far. */
type Following = {
  since: number;
  abort: AbortController;
  prompt: TranscriptBlock[];
  partial: TranscriptBlock[];
};

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
  /** What the last view said about the host's push; unset, nothing is listened for. */
  #notify: ConversationView['notify'];
  #listening: AbortController | null = null;
  /** The reply that runs elsewhere, as this page draws it from the host's lines. */
  #following: Following | null = null;
  /** The `since` of the last reply whose lines this page began to read: one read of each reply. */
  #followedSince: number | null = null;
  /** The last view said the host streams the lines of a reply that runs elsewhere. */
  #followOffered = false;
  /** The last view said results wait that no reply has read: the chat wakes once it is idle. */
  #wakeDue = false;
  /** The ids a reply names the run's message by, once the host said it saved the message itself. */
  #savedAs: readonly string[] | null = null;
  /** How many blocks, at the end of the transcript, are the message the run posted. */
  #ownPosted = 0;
  /** The run in flight has streamed an event of its reply. */
  #streamed = false;
  #reading: Promise<void> | null = null;
  #readAgain = false;
  /** Reads the conversation again once the hold of the reply that runs elsewhere lapses. */
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** The `heldUntil` of the last read made when a hold lapsed. */
  #heldUntilRead: number | null = null;

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
      waitingGate: null,
      session: emptyInterfaceTurnSession(),
      delivery: null,
      streaming: false,
      runningElsewhere: null,
      options: picksOf(options.iface, options.options, {}).options,
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
    this.#followPush();
    this.#followHold();
    this.#followReply();
    return () => {
      this.#listeners.delete(listener);
      this.#followPush();
      this.#followHold();
      this.#followReply();
    };
  };

  refresh = (): Promise<void> => {
    if (this.#reading) {
      this.#readAgain = true;
      return this.#reading;
    }
    this.#reading = this.#readHost().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  };

  /** invariant: Reads never overlap, so an older view never draws over a newer one. */
  async #readHost(): Promise<void> {
    do {
      this.#readAgain = false;
      await this.#readOnce();
    } while (this.#readAgain);
  }

  async #readOnce(): Promise<void> {
    const { iface, transport } = this.#options;
    const ref = this.#conversation;
    if (!iface || ref === undefined || !keepsConversation(iface) || this.#busy) return;
    const before = this.#state.blocks;
    let view: ConversationView;
    try {
      view = await transport.conversation({ conversation: ref });
    } catch (err) {
      // why: Nobody asked for this read, and the next one heals a passing failure.
      if (isUnknownConversation(err)) this.#setPush(undefined);
      return;
    }
    // why: A run reads the conversation once it ends, later than this.
    if (this.#busy) return;
    // why: Another read drew first. It may have started before the call ended, so read again.
    if (this.#state.blocks !== before || this.#conversation !== ref) {
      this.#readAgain = true;
      return;
    }
    this.#draw(view, this.#state.session, []);
  }

  #setPush(notify: ConversationView['notify']): void {
    this.#notify = notify;
    this.#followPush();
  }

  /** Holds the host's push open while the last view asks for it and someone is here to see it. */
  #followPush(): void {
    if (!this.#notify || this.#listeners.size === 0 || !this.#options.transport.notify) {
      this.#listening?.abort();
      this.#listening = null;
      return;
    }
    if (this.#listening) return;
    const listening = new AbortController();
    this.#listening = listening;
    void this.#listen(listening);
  }

  /**
   * Reads the conversation again when the hold of the reply that runs elsewhere lapses, while
   * someone is here to see it. The app says when that reply ends; this covers a server that died
   * holding it, which says nothing.
   */
  #followHold(): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    const running = this.#state.runningElsewhere;
    if (!running || this.#listeners.size === 0) return;
    // why: A read that still shows a hold already followed lapsed waits for the app's publish; the
    // server's clock and this one differ, so one read per hold, not one per draw.
    if (running.heldUntil === this.#heldUntilRead) return;
    this.#holdTimer = setTimeout(
      () => {
        this.#holdTimer = null;
        this.#heldUntilRead = running.heldUntil;
        void this.refresh();
      },
      Math.max(0, running.heldUntil - Date.now()),
    );
  }

  /**
   * Draws the reply that runs elsewhere from the host's lines, while someone is here to see it:
   * the same reducer the page that started it uses. It stays `runningElsewhere`, so stop and steer
   * go by the conversation. The host ends the lines with the reply, and the page reads the saved
   * conversation then.
   */
  #followReply(): void {
    const running = this.#state.runningElsewhere;
    const { iface, transport } = this.#options;
    const wanted =
      running !== null &&
      this.#followOffered &&
      this.#listeners.size > 0 &&
      !this.#busy &&
      iface !== undefined &&
      transport.follow !== undefined;
    const current = this.#following;
    if (current && (!wanted || current.since !== running.since)) {
      this.#following = null;
      current.abort.abort();
      this.#endFollow();
    }
    if (!wanted || this.#following || this.#followedSince === running.since) return;
    const ref = this.#conversation;
    if (ref === undefined) return;
    const following = {
      since: running.since,
      abort: new AbortController(),
      prompt: running.prompt,
      partial: [] as TranscriptBlock[],
    };
    this.#following = following;
    void this.#streamFollowed(following, ref);
  }

  async #streamFollowed(following: Following, ref: string): Promise<void> {
    const { iface, transport } = this.#options;
    if (!iface || !transport.follow) return;
    const follow = transport.follow.bind(transport);
    let lines = 0;
    try {
      await streamFoldedTurn({
        iface,
        events: [],
        view: {
          blocks: (partial) => {
            if (this.#following !== following) return;
            lines += 1;
            this.#followedSince = following.since;
            following.partial = partial;
            if (!this.#state.streaming) this.#set({ streaming: true });
            this.#streamFrame([...following.prompt, ...partial]);
          },
          skipped: (error) => this.#set({ failure: clientFailure(error, iface.labels) }),
        },
        stream: (onLine) => follow({ conversation: ref }, onLine, following.abort.signal),
      });
    } catch {
      // why: A cut follow leaves the page as the last read drew it; the next read shows where the reply stands.
    }
    if (this.#following !== following) return;
    this.#following = null;
    this.#endFollow();
    // why: A host with no reply to follow yet (it began a moment later) says nothing has changed; its push says when.
    if (lines > 0 && !following.abort.signal.aborted) void this.refresh();
  }

  /** Nothing follows: the frame in flight is dropped or drawn, and the reply no longer shows as streaming. */
  #endFollow(): void {
    this.#frame?.();
    this.#frame = null;
    this.#frameBlocks = null;
    if (this.#state.streaming) this.#set({ streaming: false });
  }

  async #listen(listening: AbortController): Promise<void> {
    const { signal } = listening;
    while (!signal.aborted) {
      try {
        await this.#options.transport.notify?.(() => void this.refresh(), signal);
      } catch {
        // why: The push is a convenience; the page still reads on its next turn or reload.
      }
      const retryMs = this.#notify?.retryMs;
      if (signal.aborted || retryMs === undefined) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.#listening === listening) this.#listening = null;
  }

  update = (options: ChatOptions): void => {
    this.#options = options;
    this.#warnPageTools();
    const { options: picks } = picksOf(options.iface, options.options, this.#picked);
    const patch: Partial<ChatState> = {};
    if (options.iface !== this.#state.iface) patch.iface = options.iface;
    if (!samePicks(picks, this.#state.options)) patch.options = picks;
    if (Object.keys(patch).length > 0) this.#set(patch);
  };

  setDraftText = (value: ChatUpdate<string>): void => {
    const next = typeof value === 'function' ? value(this.#state.draftText) : value;
    if (next === this.#state.draftText) return;
    const { failure } = this.#state;
    const issues = this.#state.issues.filter((issue) => issue.code !== 'text_too_long');
    // why: Editing the text answers a refusal for its length; a refusal for the files stays until they change.
    this.#set({
      draftText: next,
      issues,
      ...(failure?.errorKind === 'input' && issues.length === 0 ? { failure: null } : {}),
    });
  };
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

  /**
   * Asks the host to stop the reply, so what it leaves comes back; a host that can't drops the
   * stream. A reply that runs elsewhere is stopped by the conversation, and the read after it
   * draws what it left.
   */
  async #stop(): Promise<void> {
    const abort = this.#abort;
    const turnId = this.#turnId;
    if (!abort) {
      await this.#stopElsewhere();
      return;
    }
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

  /** Stops the reply that runs elsewhere. False when it may still run: the stop was refused or failed. */
  async #stopElsewhere(): Promise<boolean> {
    const conversation = this.#conversation;
    if (!this.#state.runningElsewhere || conversation === undefined) return true;
    this.#stopped = true;
    let stopped = true;
    try {
      await this.#options.transport.stop({ conversation });
    } catch (err) {
      // why: A reply that ended first is not running; the read below shows what it left.
      if (!isTurnEnded(err)) {
        stopped = false;
        this.#stopped = false;
        this.#set({ failure: clientFailure(err, this.#options.iface?.labels) });
      }
    }
    await this.refresh();
    return stopped;
  }

  enqueue = async (kind: 'queue' | 'steer' | 'stash'): Promise<void> => {
    const { draftText, pendingFiles, pendingVoice } = this.#state;
    if (!composerHasPayload(draftText, pendingFiles, pendingVoice)) return;
    this.#set({ issues: [] });
    let message: ComposerPendingMessage;
    try {
      const draft = await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice });
      message = createComposerPendingMessage({ kind, draft });
      const { iface } = this.#options;
      const checked =
        kind !== 'stash' && iface ? prepareUserTurn(iface.inputs, draft, iface.guardrails) : null;
      if (checked && !checked.ok) {
        // why: A message the profile refuses is never queued or steered; it stays in the composer as typed.
        this.#set({
          issues: checked.issues,
          failure: clientFailure(attachmentsRefused(checked.issues), iface?.labels),
        });
        return;
      }
    } catch (err) {
      this.#set({ failure: clientFailure(err, this.#options.iface?.labels) });
      return;
    }
    this.#set(this.#clearedComposer());
    await this.pend(message);
  };

  pend = async (message: ComposerPendingMessage): Promise<void> => {
    this.#set({
      pendingMessages: orderComposerPendingMessages([...this.#state.pendingMessages, message]),
    });
    if (message.kind === 'queue' && this.#state.phase === 'idle') this.#drainArmed = true;
    if (message.kind !== 'steer') return;
    const target = this.#steerTarget();
    if (!target) {
      this.#steerAfterTurnEnded();
      return;
    }
    const input = steerInput(message.draft);
    if (Object.keys(input).length === 0) return;
    try {
      const { saved } = await this.#options.transport.steer({ ...target, id: message.id, input });
      if (!saved) return;
      this.#set({
        pendingMessages: saveComposerPendingMessage(
          this.#state.pendingMessages,
          message.id,
          saved.landsAs,
        ),
      });
      this.#adopt(saved.conversation);
      // why: A run in flight reads the conversation once it ends, after this save. With none, the chat reads now, and wakes for the message.
      if (!this.#busy) await this.refresh();
    } catch (err) {
      this.#set({ failure: clientFailure(err, this.#options.iface?.labels) });
    }
  };

  /** Where a steer goes: the turn this page runs, or the reply that runs elsewhere. */
  #steerTarget(): { turnId: string; conversation?: string } | { conversation: string } | null {
    const conversation = this.#conversation;
    const turnId = this.#turnId;
    if (turnId) return { turnId, ...(conversation === undefined ? {} : { conversation }) };
    if (this.#state.runningElsewhere && conversation !== undefined) return { conversation };
    return null;
  }

  sendNow = async (source?: ComposerPendingMessage): Promise<void> => {
    if (!this.#options.iface || source?.saved) return;
    const draft = source ? source.draft : await this.#composerDraft();
    if (!draft) return;
    if (this.#busy) {
      await this.#stop();
      await this.#run;
    } else if (!(await this.#stopElsewhere())) {
      // why: A reply that may still run is not sent into; the message stays where it was.
      return;
    }
    this.#set({ pendingMessages: convertSteersToFrontQueued(this.#state.pendingMessages) });
    this.#drainArmed = false;
    // why: Sent while the reply waits on gates, the message walks away from them in its own request.
    await this.#sendDraft(draft, {
      id: source?.id ?? newId(),
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
    if (!message || message.saved) return;
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

  movePending = (id: string, direction: 'up' | 'down'): void => {
    this.#set({
      pendingMessages: moveComposerPendingWithinKind(this.#state.pendingMessages, id, direction),
    });
  };

  decide = (action: ToolDecisionAction): Promise<void> => this.#answerGate({ action });

  authenticate = (secret?: string): Promise<void> =>
    this.#answerGate({ action: 'auth', ...(secret === undefined ? {} : { secret }) });

  branch = async (index: number): Promise<void> => {
    const { iface } = this.#options;
    if (!iface || this.#busy || this.#state.runningElsewhere) return;
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

  pickOption = (name: string, value: string): void => {
    const before = picksOf(this.#options.iface, this.#options.options, this.#picked).values;
    this.#picked = { ...this.#picked, [name]: value };
    this.#set({
      options: picksOf(this.#options.iface, this.#options.options, this.#picked).options,
    });
    this.#options.onOptionsChange?.({ ...before, [name]: value });
  };

  sendText = async (text: string, options: SendTextOptions = {}): Promise<SentTurn | null> => {
    if (!this.#options.iface || this.#state.phase !== 'idle') return null;
    // invariant: the turn reads the pick from the session, before `#followDefaults` next runs.
    const modelId =
      options.model ??
      (options.effort === undefined ? undefined : this.#state.session.selectedModel);
    if (modelId !== undefined) this.setGeneration({ modelId, effort: options.effort });
    const before = this.#state.blocks.length;
    await this.#sendFields({
      text,
      files: [...(options.files ?? [])],
      voice: [...(options.voice ?? [])],
    });
    return { blocks: this.#state.blocks.slice(before) };
  };

  #set(patch: Partial<ChatState>): void {
    const next = { ...this.#state, ...patch };
    const running = this.#busy || next.runningElsewhere !== null;
    next.phase = running ? 'streaming' : next.session.gatedTool ? 'gated' : 'idle';
    const gate = next.session.gatedTool;
    next.waitingGate = next.phase === 'gated' && gate && gate.gateKind !== 'page' ? gate : null;
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
    this.#wake();
  }

  /**
   * Wakes the conversation when the host said results wait. A message the queue sends goes first:
   * its reply reads them. The host takes each result once, so a wake is never run twice for it.
   */
  #wake(): void {
    const ref = this.#conversation;
    if (!this.#wakeDue || ref === undefined || this.#busy || this.#draining) return;
    if (this.#state.phase !== 'idle' || !this.#options.transport.wake) return;
    this.#wakeDue = false;
    void this.#runTurn(
      ({ iface, view, transport, scope, signal }) =>
        streamInterfaceWake({
          iface,
          transport,
          session: this.#state.session,
          scope: { ...scope, conversation: ref },
          view,
          signal,
          began: () => this.#set({ failure: null, streaming: true }),
        }),
      { turn: true, wake: true },
    );
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
  /**
   * The session a run leaves, with the model and effort picked now.
   * why: the run carries the pick it started with; one made while it ran must outlast it.
   */
  #sessionAfter(session: InterfaceTurnSession, events: readonly TurnEvent[]): InterfaceTurnSession {
    const { selectedModel, selectedEffort } = this.#state.session;
    return { ...sessionAfter(session, events), selectedModel, selectedEffort };
  }

  #draw(view: ConversationView, session: InterfaceTurnSession, events: readonly TurnEvent[]): void {
    const shown = [...this.#state.blocks, ...this.#state.streamBlocks];
    const blocks = keepIds(shown, view.transcript);
    const after = view.paused?.blocks ?? view.running?.prompt ?? [];
    const drawn = [...view.transcript, ...after].map((block) => block.id);
    const ended = this.#state.runningElsewhere !== null && view.running === undefined;
    if (this.#following && view.running?.since === this.#following.since) {
      this.#following.prompt = view.running.prompt;
    }
    this.#set({
      // why: A saved message the conversation now shows is no longer waiting.
      pendingMessages: takeSavedComposerPending(this.#state.pendingMessages, drawn).remaining,
      blocks,
      // why: A reply this page follows draws from the host's lines, over the prompt as the read now shows it.
      streamBlocks:
        this.#following && view.running?.since === this.#following.since
          ? [...view.running.prompt, ...this.#following.partial]
          : keepIds(shown.slice(blocks.length), after),
      // why: A reply at rest leaves the run's own events (tokens, an ask); a paused one, the host's.
      session: this.#sessionAfter(session, view.paused?.events ?? events),
      chatStarted: view.transcript.length > 0 || after.length > 0 || view.running !== undefined,
      runningElsewhere: view.running ?? null,
    });
    this.#wakeDue = view.wake === true;
    this.#followOffered = view.follow === true;
    this.#setPush(view.notify);
    this.#followHold();
    this.#followReply();
    // why: The reply that ran elsewhere ended as a reply here ends: the queue sends on, unless it was stopped.
    if (ended && !this.#busy) {
      this.#runEnded(!this.#stopped);
      this.#stopped = false;
    }
  }

  /**
   * Keeps the model and effort valid as the interface changes: a pick still on the old defaults
   * follows the new ones, and a pick the profile no longer has falls back to them.
   * invariant: judged only when the interface changes. A pick made under this one stays, and a
   * model it does not have is refused by the turn, not swapped for the default.
   */
  #followDefaults(iface: ComposerProfileInterface): void {
    if (iface === this.#defaultsFrom) return;
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
      id: message.id,
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
  #posted(blocks: TranscriptBlock[], own: number, patch: Partial<ChatState>): void {
    this.#ownPosted = own;
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
          onUserBlocks: (blocks, own) => this.#posted(blocks, own, this.#clearedComposer()),
        }),
      {
        turn: true,
        message: {
          id: newId(),
          draft: () =>
            encodeComposerDraft({
              text: fields.text,
              pendingFiles: fields.files,
              pendingVoice: fields.voice,
            }),
          restore: () => this.#restore(fields),
        },
      },
    );
  }

  #sendDraft(
    draft: UserTurnDraft,
    options: { id: string; walkAway?: boolean; onPosted(): void },
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
          onUserBlocks: (blocks, own) => {
            this.#posted(blocks, own, { streamBlocks: [] });
            options.onPosted();
          },
        }),
      {
        turn: true,
        message: {
          id: options.id,
          draft: () => Promise.resolve(draft),
          restore: () => this.#restore(composerFieldsFromDraft(draft)),
        },
      },
    );
  }

  /** The gate on the reply still running that no answer is on its way to. */
  #drawnGate(): GateReference | undefined {
    const { streamBlocks, answering } = this.#state;
    for (const block of streamBlocks) {
      if (block.kind !== 'tool' || block.tool.state?.phase !== 'gate') continue;
      const { callId, operationId } = block.tool;
      if (operationId && callId !== answering?.callId) return { callId, operationId };
    }
    return undefined;
  }

  async #answerGate(resolution: ToolGateResolution): Promise<void> {
    // why: Set once this answer shows on its gate (not while another's does), and cleared once it has ended.
    let started = false;
    // why: A gate draws while its reply streams, but what waits is only settled when that run ends.
    const running = this.#state.phase === 'gated' ? null : this.#run;
    if (running) {
      const gate = this.#drawnGate();
      if (!gate || resolution.action === 'page') return;
      started = true;
      this.#set({ answering: { ...gate, action: resolution.action } });
      await running;
      // invariant: An answer goes only to the gate it was given on.
      if (this.#state.session.gatedTool?.operationId !== gate.operationId) {
        this.#set({ answering: null });
        return;
      }
    }
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
   * page's options and context as they are when it is sent, and each line lands the steers it
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
        if (line.type === 'conversation' && line.opened) this.#opened(line.opened, onLine);
        onLine(line);
      };
    return {
      ...base,
      turn: (request, onLine, signal) => base.turn(this.#withValues(request), tap(onLine), signal),
      invoke: (request, onLine, signal) => base.invoke(request, tap(onLine), signal),
      ...(base.wake
        ? {
            wake: (request, onLine, signal) =>
              base.wake?.(this.#wakeValues(request), tap(onLine), signal) ?? Promise.resolve(),
          }
        : {}),
    };
  }

  /** A wake carries the option picks and context a message would. */
  #wakeValues(request: TheoremWakeRequest): TheoremWakeRequest {
    const { iface, options: fixed, context } = this.#options;
    const options = picksOf(iface, fixed, this.#picked).values;
    if (options === undefined && context === undefined) return request;
    return {
      ...request,
      input: {
        ...(options === undefined ? {} : { options }),
        ...(context === undefined ? {} : { context }),
      },
    };
  }

  #withValues(request: TheoremTurnRequest): TheoremTurnRequest {
    const { iface, options: fixed, context, stated } = this.#options;
    const options = picksOf(iface, fixed, this.#picked).values;
    if (options === undefined && context === undefined && stated === undefined) return request;
    return {
      ...request,
      ...(stated === undefined ? {} : { stated }),
      input: {
        ...request.input,
        ...(options === undefined ? {} : { options }),
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
    if (line.type === 'conversation') {
      this.#adopt(line.ref);
      if (line.landsAs) this.#savedAs = line.landsAs;
      return;
    }
    this.#streamed = true;
    this.#options.onTurnEvent?.(line);
  }

  /**
   * A reply opened with messages the host saved before: they leave the pending list and join the
   * transcript where the reply reads them. That is before the message this run posted, when the
   * reply has streamed nothing.
   */
  #opened(ids: readonly string[], onLine: ChatLineSink): void {
    const { iface } = this.#options;
    const { landed, remaining } = takeSavedComposerPending(this.#state.pendingMessages, ids);
    if (!iface || landed.length === 0) return;
    this.#set({ pendingMessages: remaining });
    const read: ClientTurnEvent = {
      type: 'stage',
      stage: 'pre_turn',
      injected: landed.map((m) => ({ id: m.id, messages: userDraftToSteerInject(m.draft) })),
    };
    if (this.#streamed || this.#ownPosted === 0) {
      onLine(read);
      return;
    }
    const at = this.#state.blocks.length - this.#ownPosted;
    this.#set({
      blocks: [
        ...this.#state.blocks.slice(0, at),
        ...foldAssistantTurn(iface, [read]),
        ...this.#state.blocks.slice(at),
      ],
    });
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
    const turnId = options.turn ? newId() : undefined;
    this.#busy = true;
    this.#abort = abort;
    this.#turnId = turnId ?? null;
    this.#stopped = false;
    this.#drainArmed = false;
    this.#savedAs = null;
    this.#ownPosted = 0;
    this.#streamed = false;
    // why: A message streams once it posts, so the previous reply never shows as streaming before it.
    // A wake shows only once the host's reply begins; one with nothing to wake for shows nothing.
    if (!options.wake) this.#set({ failure: null, ...(message ? {} : { streaming: true }) });
    const start: RunStart = { blocks: this.#state.blocks, streamBlocks: this.#state.streamBlocks };
    // why: A run that answers a gate continues its reply; any other starts one.
    if (!this.#state.session.gatedTool) this.#replyWorkedMs = 0;
    const startedAt = Date.now();

    const done = (async () => {
      try {
        const outcome = await run({
          iface,
          transport: this.#runTransport(),
          scope: { conversation: this.#conversation, turnId, id: message?.id },
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
          waits = await this.#settleHosted(outcome, start, options);
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
  async #settleHosted(
    outcome: RunOutcome,
    start: RunStart,
    { message, wake }: RunOptions,
  ): Promise<boolean> {
    const { failure } = outcome;
    if (failure) this.#setDelivery(null);
    const ref = this.#conversation;
    if (ref === undefined) {
      this.#set({ streamBlocks: start.streamBlocks });
      this.#showFailure(failure);
      return this.#state.session.gatedTool !== null;
    }
    const view = await this.#options.transport.conversation({ conversation: ref });
    const savedAs = this.#savedAs;
    if (message && savedAs && !view.transcript.some((block) => savedAs.includes(block.id))) {
      await this.#keepSaved(message, savedAs);
    }
    this.#draw(view, outcome.session, outcome.events);
    // why: The page does not repeat a run that failed or was stopped, or a wake the host ran nothing for (another reply holds the conversation). The next read can wake.
    if (failure || (wake && !this.#streamed)) this.#wakeDue = false;
    if (!view.transcript.slice(start.blocks.length).some((b) => b.kind === 'error')) {
      this.#showFailure(failure);
    }
    return view.paused !== undefined;
  }

  /** The host saved the message and no reply has read it: it waits with the pending messages. */
  async #keepSaved(message: SentMessage, landsAs: readonly string[]): Promise<void> {
    this.#setDelivery(null);
    const waiting = createComposerPendingMessage({
      kind: 'steer',
      draft: await message.draft(),
      id: message.id,
    });
    this.#set({
      pendingMessages: orderComposerPendingMessages([
        ...this.#state.pendingMessages,
        { ...waiting, saved: { landsAs } },
      ]),
    });
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
    const session = this.#sessionAfter(outcome.session, outcome.events);
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
