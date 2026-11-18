/**
 * The conversation core: a person's message, an answer to a paused call, a reply to no message,
 * a read and a rewind, each run against the conversation the app keeps, with no `Request`. The
 * HTTP handler builds one for each request and streams what it returns.
 *
 * @module
 */

import {
  compactHistory,
  defaultKernelScope,
  defineProfile,
  type GateReference,
  type LateResultItem,
  type LateResultsSource,
  labelText,
  type Profile,
  type ProfileDefinition,
  type ProviderHostOptions,
  runTurn,
  TheoremError,
  type TurnEvent,
  type TurnInput,
} from '@theoremjs/agents';
import {
  type ConversationInbox,
  type ConversationRun,
  type InboxItem,
  type InboxPolicy,
  type ReplyRun,
  type ReplyStart,
  runConversation,
} from '@theoremjs/agents/conversation';
import type { ClientTurnOptions } from '@theoremjs/agents/host';
import {
  type ComposerProfileInterface,
  interfaceFromProfile,
  refuseInterfacePick,
  type TranscriptBlock,
} from '@theoremjs/agents/interface';
import type {
  ConversationView,
  StatedTurn,
  TheoremInvokeRequest,
  TheoremRewound,
  TheoremTurnInput,
} from '../client/transport.ts';
import {
  answerReply,
  type ConversationHost,
  conversationView,
  messageReply,
  type OpenedConversation,
  openConversation,
  postedMessage,
  type ReplyLine,
  type ReplyRunner,
  type ReplyTurn,
  readerConversationHost,
  rewindConversation,
  statelessRefusal,
  waitingCalls,
  wakeReply,
} from './conversation.ts';
import { detachedEnd, sessionConversationInbox } from './conversation-inbox.ts';
import {
  type StoredConversation,
  type TheoremConversationStore,
  unknownConversation,
} from './conversation-store.ts';
import { sessionPageDispatch } from './page-dispatch.ts';
import {
  announced,
  backgroundWiring,
  type CallsContext,
  type CoreContext,
  recorded,
  replayAllowed,
  sessionCredentials,
  settlingOf,
  takeWalkedAway,
  withAuthorizationUrls,
} from './session-calls.ts';
import type { TheoremSessionState } from './session-store.ts';
import { type SteerInbox, type SteerUnit, steerStage, stopOnRequest } from './steer-inbox.ts';
import { sessionToolCoordinator } from './tool-operations.ts';
import { preparedTurn, stagesInOrder } from './turn-wiring.ts';

export type ChatProfile = Exclude<Profile, { type: 'live' | 'decision' | 'host' | 'embedding' }>;

/** What a chat's runs read beside the session's calls. */
export type ChatContext = {
  profile: ChatProfile;
  /** Undefined when the profile keeps no conversation (`'stateless'`). */
  conversations?: TheoremConversationStore;
};

/**
 * The chat `definition` serves, with the store that keeps its conversation. `name` is the function
 * the app called, for the error a wrong profile throws.
 */
export function chatOf(
  name: string,
  definition: Profile | ProfileDefinition,
  conversations: TheoremConversationStore | undefined,
): ChatContext {
  const profile = defineProfile(definition as ProfileDefinition);
  if (profile.type === 'decision') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      `${name} serves turn-based profiles; serve type 'decision' with createTheoremDecisionHandler.`,
    );
  }
  if (profile.type === 'host') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(
      `${name} serves turn-based profiles; serve type 'host' with createTheoremHostHandler.`,
    );
  }
  if (profile.type === 'live' || profile.type === 'embedding') {
    // labels-exempt: builder config error at setup; no user sees it
    throw new Error(`${name} serves turn-based profiles; got type '${profile.type}'.`);
  }
  const stateless = profile.providerContinuation?.history === 'stateless';
  if (stateless === (conversations !== undefined)) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: {
        code: stateless ? 'conversation_store_stateless' : 'conversation_store_missing',
        profile: profile.id,
      },
    });
  }
  return { profile, ...(conversations ? { conversations } : {}) };
}

/** The profile as the server reads a message against it, its tools as registered now. */
export function chatInterface(chat: ChatContext): ComposerProfileInterface {
  return interfaceFromProfile(chat.profile, defaultKernelScope.tools);
}

/**
 * The app's own inbox for a conversation, and its rule for what a reply may be told. A reply runs
 * under a hold of `conversation` in it, and the app reads the reply's items itself.
 */
export type AppInbox<Item extends InboxItem = InboxItem> = {
  inbox: ConversationInbox<Item>;
  /** The inbox's name for the conversation the runs of this context hold. */
  conversation: string;
  policy: InboxPolicy<Item>;
  /** How long a hold keeps the conversation after it last renewed, in milliseconds. */
  leaseMs: number;
};

/** Everything a conversation's runs read from whoever serves them. */
export type CoreState<Item extends InboxItem = InboxItem> = Omit<CallsContext, 'options'> & {
  chat: ChatContext;
  steer: SteerInbox;
  options: CallsContext['options'] & {
    /**
     * The app's inbox, for the runs of one context. Unset, a reply holds the session's inbox of
     * ended background calls when `lateResultsDecider` is set, and holds nothing otherwise.
     */
    inbox?: (at: CoreContext) => AppInbox<Item>;
    provider: (
      at: CoreContext,
      model?: string,
    ) => ProviderHostOptions | Promise<ProviderHostOptions>;
    conversationLeaseMs?: number;
    notifyRetryMs?: number;
    clientEvents?: ClientTurnOptions;
  };
};

/**
 * How one run of a conversation ended. `released`: the run let the conversation go. `held`:
 * another hold has it until `leasedUntil`, and tells what waits. `lost`: this run's hold no
 * longer has it.
 */
export type RunEnd =
  | { outcome: 'released' }
  | { outcome: 'held'; leasedUntil: number }
  | { outcome: 'lost' };

/** A run's lines, then how it ended. */
export type Reply = AsyncGenerator<ReplyLine, RunEnd>;

/** What the person picked for a reply's model run. */
export type Generation = { model?: string; effort?: string; turnId?: string; stated?: StatedTurn };

/** Lines that run under no hold. */
async function* unheld(lines: AsyncIterable<ReplyLine>): Reply {
  yield* lines;
  return { outcome: 'released' };
}

/** Steer inboxes are scoped to the session, so a turn id alone can't reach another user's turn. */
function inboxKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

const DEFAULT_CONVERSATION_LEASE_MS = 60_000;

/**
 * The session's inbox for the chat: the chat as this context last wrote it, and the results this
 * context may read. `ref` is the chat's ref now, because a store's ref can change with each write.
 */
function chatInbox<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'conversation'>,
  ref: () => string | null,
) {
  const leaseMs = ctx.options.conversationLeaseMs ?? DEFAULT_CONVERSATION_LEASE_MS;
  const inbox = sessionConversationInbox({
    sessions: ctx.sessions,
    sessionId: at.sessionId,
    leaseMs,
    conversation: async (key) => {
      const current = ref();
      const conversation =
        current === null
          ? opened.conversation
          : (await host.store.read(at.sessionId, current))?.conversation;
      return conversation?.id === key ? conversation : undefined;
    },
    readable: (operation) => replayAllowed(ctx, at, operation),
    labels: ctx.profile.labels,
  });
  return { inbox, key: opened.conversation.id, leaseMs };
}

/** The values `produce` sends, as it sends them, then its end or what it threw. */
async function* sent<T, R>(
  produce: (send: (value: T) => void) => Promise<R>,
): AsyncGenerator<T, R> {
  const queue: T[] = [];
  let ended: { failed: false; value: R } | { failed: true; failure: unknown } | undefined;
  let wake = () => {};
  produce((value) => {
    queue.push(value);
    wake();
  }).then(
    (value) => {
      ended = { failed: false, value };
      wake();
    },
    (failure: unknown) => {
      ended = { failed: true, failure };
      wake();
    },
  );
  for (;;) {
    if (queue.length > 0) {
      yield queue.splice(0, 1)[0];
      continue;
    }
    if (ended?.failed) throw ended.failure;
    if (ended) return ended.value;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

/**
 * A reply under a hold of the chat: the run, the renewal each save checks first, and whose items
 * it reads. `session`: the session's late results, as the model reads them. `app`: the app's run,
 * whose items the app reads itself.
 */
type HeldRun<Item extends InboxItem> = {
  run: Pick<ReplyRun, 'hold' | 'reply' | 'signal' | 'resume'>;
  renew: () => Promise<boolean>;
  reads: { from: 'session'; late: LateResultsSource } | { from: 'app'; run: ReplyRun<Item> };
};

/** What a held reply does once its hold ends with results waiting, or finds the chat held. */
type HeldFollow = {
  /** A server's wake: it runs the next reply itself, under the hold it has. */
  again?: boolean;
};

/** The inbox a chat's replies hold, as one context runs under it. */
type Holding<Item extends InboxItem> = {
  /** Runs one reply under a hold, and sends its lines as it yields them. */
  run(
    start: ReplyStart,
    lines: (held: HeldRun<Item>) => AsyncIterable<ReplyLine>,
    send: (line: ReplyLine) => void,
  ): Promise<ConversationRun>;
  /** Lets the chat go under `hold`, reading again each time an item arrives first. */
  letGo(hold: string): Promise<void>;
  /** Whether an item waits that the policy tells a reply to no message. */
  due(): Promise<boolean>;
  /** The chat's ref as the last line of a run under it said. */
  ref(): string | null;
};

function holdingOver<Kept extends InboxItem, Item extends InboxItem>(
  kept: {
    inbox: ConversationInbox<Kept>;
    key: string;
    leaseMs: number;
    policy: InboxPolicy<Kept>;
    reads: (run: ReplyRun<Kept>) => HeldRun<Item>['reads'];
    gaveUp: (items: readonly Kept[]) => void;
  },
  chat: { ref: () => string | null; seen: (line: ReplyLine) => void },
): Holding<Item> {
  const { inbox, key, policy } = kept;
  return {
    run: (start, lines, send) =>
      runConversation({
        conversation: key,
        inbox,
        policy,
        start,
        newId: () => crypto.randomUUID(),
        renewEveryMs: kept.leaseMs / 3,
        reply: async (run) => {
          const held = { run, renew: () => inbox.renew(key, run.hold), reads: kept.reads(run) };
          for await (const line of lines(held)) {
            chat.seen(line);
            send(line);
          }
        },
        gaveUp: kept.gaveUp,
      }),
    async letGo(hold) {
      for (;;) {
        const { version } = await inbox.read(key);
        if ((await inbox.release(key, hold, version)) !== 'moved') return;
      }
    },
    async due() {
      const { items } = await inbox.read(key);
      if (items.length === 0) return false;
      const { tell } = await policy(items, { stage: 'pre_turn', step: 0, opening: 'wake' });
      return tell.length > 0;
    },
    ref: chat.ref,
  };
}

/**
 * The inbox this context's replies hold: the app's when it passes one, the session's when a
 * decider tells its late results, and none otherwise.
 */
function holdingOf<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'ref' | 'conversation'>,
): Holding<Item> | undefined {
  let ref = opened.ref;
  const chat = {
    ref: () => ref,
    seen(line: ReplyLine) {
      if (line.type === 'conversation') ref = line.ref;
    },
  };
  const gaveUp = (code: string) => (items: readonly InboxItem[]) => {
    ctx.options.onError?.(
      // labels-exempt: internal diagnostic; no reader sees a given-up item
      new TheoremError('unavailable', 'The inbox policy gave up items', {
        cause: { code, operationIds: items.map((item) => item.id) },
      }),
      at,
    );
  };
  const app = ctx.options.inbox?.(at);
  if (app) {
    return holdingOver(
      {
        inbox: app.inbox,
        key: app.conversation,
        leaseMs: app.leaseMs,
        policy: app.policy,
        reads: (run) => ({ from: 'app', run }),
        gaveUp: gaveUp('inbox_items_given_up'),
      },
      chat,
    );
  }
  const decider = ctx.options.lateResultsDecider;
  if (!decider) return undefined;
  let whose: Promise<unknown> | undefined;
  return holdingOver<LateResultItem, Item>(
    {
      ...chatInbox(ctx, at, host, opened, chat.ref),
      policy: async (items, moment) => {
        whose ??= Promise.resolve(at.host);
        return decider.policy(items, { ...moment, host: await whose });
      },
      reads: (run) => ({ from: 'session', late: lateSource(run) }),
      gaveUp: gaveUp('late_results_given_up'),
    },
    chat,
  );
}

/**
 * Runs a reply under a hold of the chat, and streams its lines. The reply reads the items the
 * policy tells it. With no inbox to hold, no reply reads one, and no hold is taken.
 * invariant: One hold has a chat at a time, and lets it go only once nothing waits that may be told.
 * A page's reply that leaves results waiting lets the chat go, so the page wakes for them; a
 * server's wake runs the next reply under its hold.
 */
function heldLines<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'ref' | 'conversation'>,
  start: Exclude<ReplyStart, { opening: 'follow_up' }>,
  reply: (held: HeldRun<Item> | undefined, ref: () => string | null) => AsyncIterable<ReplyLine>,
  follow: HeldFollow = {},
): Reply {
  const holding = holdingOf(ctx, at, host, opened);
  if (!holding) return unheld(reply(undefined, () => opened.ref));
  return sent<ReplyLine, RunEnd>(async (send) => {
    let run = await holding.run(start, (held) => reply(held, holding.ref), send);
    let failure = run.outcome === 'held' ? undefined : run.failure;
    while (run.outcome === 'continue') {
      const paused = await isPaused(host, holding.ref(), opened.conversation);
      if (!follow.again || paused) {
        await holding.letGo(run.hold);
        break;
      }
      run = await holding.run(
        { opening: 'follow_up', hold: run.hold },
        (held) => wakeReplyLines(ctx, at, host, holding.ref(), {}, held),
        send,
      );
      if (run.outcome !== 'held' && run.failure !== undefined) failure ??= run.failure;
    }
    if (failure !== undefined) throw failure;
    if (run.outcome === 'held') return { outcome: 'held', leasedUntil: run.leasedUntil };
    return { outcome: run.outcome === 'lost' ? 'lost' : 'released' };
  });
}

/** Whether the chat waits on gates: a wake leaves it to the answer that goes on. */
async function isPaused(
  host: ConversationHost,
  ref: string | null,
  fallback: StoredConversation,
): Promise<boolean> {
  const conversation =
    ref === null ? fallback : (await host.store.read(host.sessionId, ref))?.conversation;
  return conversation?.paused !== undefined;
}

/** The late results a reply's model reads: what it opened with, then what each later moment hands it. */
function lateSource(run: ReplyRun<LateResultItem>): LateResultsSource {
  let opening = true;
  return async ({ stage, step }) => {
    if (opening && stage === 'pre_turn') {
      opening = false;
      return run.opened.map((item) => item.outcome);
    }
    return (await run.take({ stage, step })).map((item) => item.outcome);
  };
}

/** One model run of a chat's reply, its gates recorded in the session as they pause. */
async function* chatTurn<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  turn: ReplyTurn,
  key: string | undefined,
  signal: AbortSignal,
  stop: AbortController,
  held: HeldRun<Item> | undefined,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(at.sessionId);
  const provider = await ctx.options.provider(at, turn.model);
  const host = await at.host;
  if (key) {
    await ctx.steer.open(key);
    stopOnRequest(ctx.steer, key, stop);
  }
  try {
    const onStage = stagesInOrder(
      ctx.options.onStage,
      key ? steerStage(ctx.steer, key) : undefined,
    );
    const prepared = await preparedTurn(
      ctx.options.prepare,
      {
        profile: ctx.profile.id,
        execution: sessionToolCoordinator(ctx.sessions, at.sessionId),
        ...backgroundWiring(ctx, at),
        pageExecution: sessionPageDispatch(
          ctx.sessions,
          at.sessionId,
          ctx.pageToolBroker,
          ctx.options.pageToolTimeoutMs,
        ).execution,
        input: turn.input,
        ...(held?.reads.from === 'session' ? { lateResults: held.reads.late } : {}),
        ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
        ...(turn.providerState ? { providerState: turn.providerState } : {}),
        sessionPermissions: state.permissions,
        signal,
        host,
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.effort ? { effort: turn.effort } : {}),
        ...turn.carried,
        ...turn.stated,
      },
      {
        credentials: sessionCredentials(ctx, at.sessionId),
        ...(onStage ? { onStage } : {}),
        announce: (service) => announced(ctx, at, service),
      },
    );
    const events = runTurn(prepared, provider);
    yield* recorded(ctx.sessions, at.sessionId, withAuthorizationUrls(ctx, at, events), {
      profileId: ctx.profile.id,
      turnInput: turn.input,
      model: turn.model,
    });
  } finally {
    if (key) await ctx.steer.close(key);
  }
}

/**
 * How this request runs the model for a reply: its generation, its abort (the request's, a stop,
 * or its hold losing the chat), and the chat's hold it saves under.
 */
function chatRunner<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  generation: {
    model?: string;
    effort?: string;
    turnId?: string;
    stated?: StatedTurn;
  },
  held?: HeldRun<Item>,
): ReplyRunner {
  // invariant: The page's pick is checked here, before prepare; a model prepare sets is the host's own.
  refuseInterfacePick(ctx.profile, generation);
  const key = generation.turnId ? inboxKey(at.sessionId, generation.turnId) : undefined;
  const stop = new AbortController();
  const signal = AbortSignal.any([at.signal, stop.signal, ...(held ? [held.run.signal] : [])]);
  return {
    run: (turn) => chatTurn(ctx, at, turn, key, signal, stop, held),
    async compact(history, tokens, model) {
      const provider = await ctx.options.provider(at, model);
      const compacted = await compactHistory(
        {
          profile: ctx.profile.id,
          history,
          tokens,
          signal,
          ...(model ? { model } : {}),
        },
        provider,
      );
      return compacted?.history;
    },
    ...(generation.model ? { model: generation.model } : {}),
    ...(generation.effort ? { effort: generation.effort } : {}),
    ...(generation.stated ? { stated: generation.stated } : {}),
    signal,
    ...(held ? { reply: held.run.reply, held: held.renew } : {}),
  };
}

/** The chat's conversation as this session's runs read and write it; undefined when the profile keeps none. */
function conversationHost<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
): ConversationHost | undefined {
  const store = ctx.chat.conversations;
  if (!store) return undefined;
  return readerConversationHost({
    sessionId: at.sessionId,
    store,
    profile: { outputs: ctx.chat.profile.outputs, labels: ctx.profile.labels },
    clientEvents: ctx.options.clientEvents,
  });
}

/**
 * The wake's reply under a hold of the chat; nothing when no decider tells a result, or while a
 * reply waits on gates: the answer that goes on reads what waits.
 */
async function wakeLines<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  generation: { model?: string; effort?: string; turnId?: string },
  follow: HeldFollow,
  input?: Pick<TurnInput, 'options' | 'context'>,
): Promise<Reply> {
  const opened = await openConversation(host, ref, { kind: 'read' });
  if (!holds(ctx) || opened.conversation.paused) return unheld(noLines());
  return heldLines(
    ctx,
    at,
    host,
    opened,
    { opening: 'wake' },
    (held, current) => wakeReplyLines(ctx, at, host, current(), generation, held, input),
    follow,
  );
}

/** No reply lines. */
async function* noLines(): AsyncGenerator<ReplyLine> {}

/**
 * A reply to no message under `held`, on the chat as it stands now. The page that woke draws it;
 * any other page open on the session reads it once it ends.
 */
async function* wakeReplyLines<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string | null,
  generation: { model?: string; effort?: string; turnId?: string },
  held: HeldRun<Item> | undefined,
  input?: Pick<TurnInput, 'options' | 'context'>,
): AsyncGenerator<ReplyLine> {
  if (ref === null) return;
  const opened = await openConversation(host, ref, { kind: 'read' });
  const runner = chatRunner(ctx, at, generation, held);
  yield* wakeReply({ host, opened, runner, ...(input ? { input } : {}) });
  ctx.options.notifier?.publish(at.sessionId);
}

/**
 * why: The transcript keeps a detached call as the turn left it. The session holds what became of
 * it, so a call that has ended does not read as running.
 */
async function currentView<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  conversation: StoredConversation,
): Promise<ConversationView> {
  const view = conversationView(host, conversation);
  const detached = view.transcript.some(isDetachedBlock);
  // why: a session's late results come from detached calls only; an app's items come from anywhere
  if (!detached && !ctx.options.inbox) return view;
  const wake = (await wakeDue(ctx, at, host, ref, conversation)) ? { wake: true as const } : {};
  if (!detached) return { ...view, ...wake };
  const { operations } = await ctx.sessions.read(at.sessionId);
  const transcript = await Promise.all(
    view.transcript.map((block) =>
      isDetachedBlock(block) ? lateBlock(ctx, at, block, operations, host) : block,
    ),
  );
  const { notifier, notifyRetryMs } = ctx.options;
  return {
    ...view,
    transcript,
    ...(notifier && transcript.some(isDetachedBlock)
      ? { notify: notifyRetryMs === undefined ? {} : { retryMs: notifyRetryMs } }
      : {}),
    ...wake,
  };
}

/**
 * Whether the page wakes the chat now: the decider's policy tells a waiting result to a reply to no
 * message. Never while a reply waits on gates: the answer that goes on reads what waits.
 */
function wakeDue<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  conversation: StoredConversation,
): Promise<boolean> {
  if (conversation.paused) return Promise.resolve(false);
  const holding = holdingOf(ctx, at, host, { ref, conversation });
  return holding ? holding.due() : Promise.resolve(false);
}

/** Whether a reply runs under a hold of the chat: the app passes an inbox, or a decider tells late results. */
function holds<Item extends InboxItem>(ctx: CoreState<Item>): boolean {
  return ctx.options.inbox !== undefined || ctx.options.lateResultsDecider !== undefined;
}

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

function isDetachedBlock(block: TranscriptBlock): block is ToolBlock {
  return block.kind === 'tool' && block.tool.state?.phase === 'background';
}

/** A detached call's block as its operation stands. One the session no longer holds has no known end. */
async function lateBlock<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  block: ToolBlock,
  operations: TheoremSessionState['operations'],
  host: ConversationHost,
): Promise<ToolBlock> {
  const { tool } = block;
  const id = tool.operationId;
  const operation = id && Object.hasOwn(operations, id) ? operations[id] : undefined;
  if (operation?.status === 'running' || operation?.status === 'background') return block;
  const { labels } = ctx.profile;
  if (
    operation?.status === 'settled' &&
    ctx.options.authorizeToolReplay &&
    !(await ctx.options.authorizeToolReplay(at, operation))
  ) {
    const message = labelText('error.blocked', {}, labels);
    const failure = { code: 'outcome_withheld', kind: 'blocked', message } as const;
    const { name, callId } = tool;
    const at = operation.settledAt;
    return {
      ...block,
      tool: {
        ...tool,
        state: { name, callId, at, phase: 'error', failure, readBack: message },
        endedAt: at,
      },
    };
  }
  if (operation?.status === 'settled') {
    const settled = host.forReader(operation.outcome.event);
    if (settled.type !== 'tool') return block;
    const { tool: state } = settled;
    if (!('phase' in state) || (state.phase !== 'complete' && state.phase !== 'error'))
      return block;
    return { ...block, tool: { ...tool, state, endedAt: operation.settledAt } };
  }
  const { name, callId } = tool;
  const unresolved = detachedEnd(
    { operationId: id ?? '', callId, name, at: tool.state?.at ?? Date.now() },
    operation,
    labels,
  );
  if (!unresolved) return block;
  const { operationId: _id, ...state } = unresolved.event.tool;
  return { ...block, tool: { ...tool, state, endedAt: state.at } };
}

/** The answer's reply, handed first what the paused reply read, so it tells them as it goes on. */
async function* answered<Item extends InboxItem>(
  held: HeldRun<Item> | undefined,
  paused: string | undefined,
  reply: () => AsyncIterable<ReplyLine>,
): AsyncGenerator<ReplyLine> {
  if (held && paused) await held.run.resume(paused);
  yield* reply();
}

/** The person's message: a new reply, run against the conversation the app keeps. */
async function message<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: MessageArgs,
): Promise<Reply> {
  const { generation = {}, saved } = args;
  if (saved && !ctx.options.inbox) {
    // labels-exempt: builder config error; the user reads error.config
    throw new TheoremError(
      'config',
      "a `saved` message needs `inbox`: its hold is in the app's inbox",
    );
  }
  const posted = postedMessage(chatInterface(ctx.chat), args.input, args.context);
  const host = conversationHost(ctx, at);
  if (!host) {
    if (args.ref !== undefined) throw statelessRefusal('continue');
    // labels-exempt: internal diagnostic; the user reads error.request
    if (args.abandon) throw statelessRefusal('walk away from');
    const runner = chatRunner(ctx, at, generation);
    return unheld(
      runner.run({
        input: posted.input,
        model: generation.model,
        effort: generation.effort,
        ...(generation.stated ? { stated: generation.stated } : {}),
      }),
    );
  }
  const opened = await openConversation(host, args.ref, {
    kind: 'message',
    ...(args.abandon ? { abandon: args.abandon } : {}),
  });
  // why: Take the walked-away calls before streaming, so a stale one is a reply status, not a stream error.
  const walkAway = args.abandon
    ? await takeWalkedAway(ctx, at, args.abandon, opened.conversation)
    : undefined;
  const start: ReplyStart = saved
    ? { opening: 'message', hold: saved.hold }
    : { opening: 'message', takeOver: true };
  return heldLines(ctx, at, host, opened, start, (held) =>
    messageReply({
      host,
      opened,
      message: posted,
      ...(walkAway ? { walkAway } : {}),
      ...(saved ? { saved: saved.blocks } : {}),
      runner: chatRunner(ctx, at, generation, held),
    }),
  );
}

/** The answered call's events, for a session that keeps no conversation. */
export async function unconversedAnswer(
  ctx: CallsContext,
  at: CoreContext,
  body: TheoremInvokeRequest,
): Promise<Reply> {
  if (body.conversation !== undefined) throw statelessRefusal('continue');
  return unheld((await settlingOf(ctx, at, body))());
}

/**
 * The person's answer to a paused call. In a kept conversation the reply goes on in the same
 * run once no call waits; otherwise the run is the call's.
 */
async function answer<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  body: TheoremInvokeRequest,
): Promise<Reply> {
  const host = conversationHost(ctx, at);
  if (!host) return unconversedAnswer(ctx, at, body);
  if (body.conversation === undefined) throw unknownConversation();
  const call = { callId: body.gateId, operationId: body.operationId };
  const opened = await openConversation(host, body.conversation, { kind: 'answer', call });
  const settling = await settlingOf(ctx, at, body);
  const paused = opened.conversation.paused?.reply;
  return heldLines(ctx, at, host, opened, { opening: 'message', takeOver: true }, (held) =>
    answered(held, paused, () =>
      answerReply({
        host,
        opened,
        call,
        settling: settling(),
        runner: chatRunner(ctx, at, body, held),
      }),
    ),
  );
}

/**
 * A reply to no message, for results that ended since the model last ran. It runs under a hold of
 * the chat, so two wakes at once run it once, and reads what the decider's policy tells.
 */
async function wake<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: WakeArgs,
): Promise<Reply> {
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('wake');
  return await wakeLines(
    ctx,
    at,
    host,
    args.ref,
    args.generation ?? {},
    args.again ? { again: true } : {},
    args.input,
  );
}

/** The conversation as a page draws it. */
async function read<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: { ref: string },
): Promise<ConversationView> {
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('read');
  const opened = await openConversation(host, args.ref, { kind: 'read' });
  return currentView(ctx, at, host, args.ref, opened.conversation);
}

/** The conversation cut after one block; a reply that waits on gates is walked away from first. */
async function rewind<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: { ref: string; at: number },
): Promise<TheoremRewound> {
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('rewind');
  const opened = await openConversation(host, args.ref, { kind: 'rewind', at: args.at });
  const waiting = waitingCalls(opened.conversation);
  const walkAway = waiting.length
    ? await takeWalkedAway(ctx, at, waiting, opened.conversation)
    : undefined;
  const next = await rewindConversation({
    host,
    opened,
    at: args.at,
    ...(walkAway ? { walkAway } : {}),
  });
  if (next.ref === null) throw new TheoremError('internal', labelText('error.internal'));
  return {
    conversation: next.ref,
    view: await currentView(ctx, at, host, next.ref, next.conversation),
  };
}

/** A person's message, for {@link ConversationCore.message}. */
export type MessageArgs = {
  /** The conversation's ref; unset for a new one. */
  ref?: string;
  input: TheoremTurnInput;
  /** The app's own context for the run. The profile's `inputs.context.from` must list `server`. */
  context?: unknown;
  generation?: Generation;
  /** The calls a paused reply waits on, to walk away from: exactly those. */
  abandon?: readonly GateReference[];
  /**
   * The app saved the message itself and took the conversation in its `inbox` under `hold`, in
   * one write. The core then posts nothing and runs the reply under `hold`. `blocks` is the
   * message as the app saved it.
   */
  saved?: { hold: string; blocks: readonly TranscriptBlock[] };
};

/** A reply to no message, for {@link ConversationCore.wake}. */
export type WakeArgs = {
  ref: string;
  generation?: Generation;
  input?: Pick<TurnInput, 'options' | 'context'>;
  /** A server's wake: it runs each next reply itself while results wait. */
  again?: boolean;
};

/** A conversation's runs, with no HTTP request. Each run's lines end with how it ended. */
export type ConversationCore = {
  /** The person's message: it posts, and its reply runs. */
  message(at: CoreContext, args: MessageArgs): Promise<Reply>;
  /** The person's answer to a paused call; the reply goes on once no call waits. */
  answer(at: CoreContext, body: TheoremInvokeRequest): Promise<Reply>;
  /** A reply to no message, for items that arrived since the model last ran. */
  wake(at: CoreContext, args: WakeArgs): Promise<Reply>;
  /** The conversation as a page draws it. */
  read(at: CoreContext, args: { ref: string }): Promise<ConversationView>;
  /** The conversation cut after block `at`; a reply that waits on gates is walked away from first. */
  rewind(at: CoreContext, args: { ref: string; at: number }): Promise<TheoremRewound>;
  /** Puts `unit` into a running turn. False when the turn is not running. */
  steer(at: CoreContext, args: { turnId: string; unit: SteerUnit }): Promise<boolean>;
  /** Stops a running turn where it stands. False when the turn is not running. */
  stop(at: CoreContext, args: { turnId: string }): Promise<boolean>;
};

/** The conversation core over `state`. */
export function createConversationCore<Item extends InboxItem = InboxItem>(
  state: CoreState<Item>,
): ConversationCore {
  if (state.options.inbox && state.options.lateResultsDecider) {
    // labels-exempt: builder config error; the user reads error.config
    throw new TheoremError(
      'config',
      "pass `inbox` or `lateResultsDecider`, not both: the app's inbox holds every item a reply is told",
    );
  }
  return {
    message: (at, args) => message(state, at, args),
    answer: (at, body) => answer(state, at, body),
    wake: (at, args) => wake(state, at, args),
    read: (at, args) => read(state, at, args),
    rewind: (at, args) => rewind(state, at, args),
    steer: (at, { turnId, unit }) =>
      Promise.resolve(state.steer.enqueue(inboxKey(at.sessionId, turnId), unit)),
    stop: (at, { turnId }) => Promise.resolve(state.steer.stop(inboxKey(at.sessionId, turnId))),
  };
}
