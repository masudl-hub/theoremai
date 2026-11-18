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
  type GateReference,
  type LateResultItem,
  type LateResultsSource,
  labelText,
  type Profile,
  type ProviderHostOptions,
  runTurn,
  TheoremError,
  type TurnEvent,
  type TurnInput,
} from '@theoremjs/agents';
import { type ReplyRun, type ReplyStart, runConversation } from '@theoremjs/agents/conversation';
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
} from '../client/transport.ts';
import {
  answerReply,
  type ConversationHost,
  conversationView,
  messageReply,
  type OpenedConversation,
  openConversation,
  type PostedMessage,
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

/** The profile as the server reads a message against it, its tools as registered now. */
export function chatInterface(chat: ChatContext): ComposerProfileInterface {
  return interfaceFromProfile(chat.profile, defaultKernelScope.tools);
}

/** Everything a conversation's runs read from whoever serves them. */
export type CoreState = Omit<CallsContext, 'options'> & {
  chat: ChatContext;
  inbox: SteerInbox;
  options: CallsContext['options'] & {
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
 * The chat's inbox as this request reads it: the chat as this request last wrote it, and the
 * results this request may read. `seen` follows each line's ref, because a store's ref can change
 * with each write.
 */
function chatInbox(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'ref' | 'conversation'>,
) {
  let ref = opened.ref;
  const leaseMs = ctx.options.conversationLeaseMs ?? DEFAULT_CONVERSATION_LEASE_MS;
  const inbox = sessionConversationInbox({
    sessions: ctx.sessions,
    sessionId: at.sessionId,
    leaseMs,
    conversation: async (key) => {
      const conversation =
        ref === null
          ? opened.conversation
          : (await host.store.read(at.sessionId, ref))?.conversation;
      return conversation?.id === key ? conversation : undefined;
    },
    readable: (operation) => replayAllowed(ctx, at, operation),
    labels: ctx.profile.labels,
  });
  return {
    inbox,
    key: opened.conversation.id,
    leaseMs,
    seen(line: ReplyLine) {
      if (line.type === 'conversation') ref = line.ref;
    },
    get ref() {
      return ref;
    },
  };
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

/** A reply under a hold of the chat: the run, and the renewal each save checks first. */
type HeldRun = { run: ReplyRun<LateResultItem>; renew: () => Promise<boolean> };

/** What a held reply does once its hold ends with results waiting, or finds the chat held. */
type HeldFollow = {
  /** A server's wake: it runs the next reply itself, under the hold it has. */
  again?: boolean;
};

/**
 * Runs a reply under a hold of the chat, and streams its lines. The reply reads the late results
 * the decider's policy tells it. Without a decider no reply reads one, and no hold is taken.
 * invariant: One hold has a chat at a time, and lets it go only once nothing waits that may be told.
 * A page's reply that leaves results waiting lets the chat go, so the page wakes for them; a
 * server's wake runs the next reply under its hold.
 */
function heldLines(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'ref' | 'conversation'>,
  start: Exclude<ReplyStart, { opening: 'follow_up' }>,
  reply: (held: HeldRun | undefined, ref: () => string | null) => AsyncIterable<ReplyLine>,
  follow: HeldFollow = {},
): Reply {
  const decider = ctx.options.lateResultsDecider;
  if (!decider) return unheld(reply(undefined, () => opened.ref));
  const chat = chatInbox(ctx, at, host, opened);
  const ref = () => chat.ref;
  return sent<ReplyLine, RunEnd>(async (send) => {
    const whose = await at.host;
    const runOnce = (begin: ReplyStart, lines: (held: HeldRun) => AsyncIterable<ReplyLine>) =>
      runConversation({
        conversation: chat.key,
        inbox: chat.inbox,
        policy: (items, moment) => decider.policy(items, { ...moment, host: whose }),
        start: begin,
        newId: () => crypto.randomUUID(),
        renewEveryMs: chat.leaseMs / 3,
        reply: async (run) => {
          const renew = () => chat.inbox.renew(chat.key, run.hold);
          for await (const line of lines({ run, renew })) {
            chat.seen(line);
            send(line);
          }
        },
        gaveUp: (items) => {
          ctx.options.onError?.(
            // labels-exempt: internal diagnostic; no reader sees a given-up result
            new TheoremError('unavailable', 'The late-results policy gave up results', {
              cause: { code: 'late_results_given_up', operationIds: items.map((item) => item.id) },
            }),
            at,
          );
        },
      });
    let run = await runOnce(start, (held) => reply(held, ref));
    let failure = run.outcome === 'held' ? undefined : run.failure;
    while (run.outcome === 'continue') {
      const paused = await isPaused(host, chat.ref, opened.conversation);
      if (!follow.again || paused) {
        await letGo(chat.inbox, chat.key, run.hold);
        break;
      }
      run = await runOnce({ opening: 'follow_up', hold: run.hold }, (held) =>
        wakeReplyLines(ctx, at, host, chat.ref, {}, held),
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

/** Lets the chat go under `hold`, reading again each time a result arrives first. */
async function letGo(
  inbox: ReturnType<typeof chatInbox>['inbox'],
  key: string,
  hold: string,
): Promise<void> {
  for (;;) {
    const { version } = await inbox.read(key);
    if ((await inbox.release(key, hold, version)) !== 'moved') return;
  }
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
async function* chatTurn(
  ctx: CoreState,
  at: CoreContext,
  turn: ReplyTurn,
  key: string | undefined,
  signal: AbortSignal,
  stop: AbortController,
  late: ReplyRun<LateResultItem> | undefined,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(at.sessionId);
  const provider = await ctx.options.provider(at, turn.model);
  const host = await at.host;
  if (key) {
    await ctx.inbox.open(key);
    stopOnRequest(ctx.inbox, key, stop);
  }
  try {
    const onStage = stagesInOrder(
      ctx.options.onStage,
      key ? steerStage(ctx.inbox, key) : undefined,
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
        ...(late ? { lateResults: lateSource(late) } : {}),
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
    if (key) await ctx.inbox.close(key);
  }
}

/**
 * How this request runs the model for a reply: its generation, its abort (the request's, a stop,
 * or its hold losing the chat), and the chat's hold it saves under.
 */
function chatRunner(
  ctx: CoreState,
  at: CoreContext,
  generation: {
    model?: string;
    effort?: string;
    turnId?: string;
    stated?: StatedTurn;
  },
  held?: HeldRun,
): ReplyRunner {
  // invariant: The page's pick is checked here, before prepare; a model prepare sets is the host's own.
  refuseInterfacePick(ctx.profile, generation);
  const key = generation.turnId ? inboxKey(at.sessionId, generation.turnId) : undefined;
  const stop = new AbortController();
  const signal = AbortSignal.any([at.signal, stop.signal, ...(held ? [held.run.signal] : [])]);
  return {
    run: (turn) => chatTurn(ctx, at, turn, key, signal, stop, held?.run),
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
function conversationHost(ctx: CoreState, at: CoreContext): ConversationHost | undefined {
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
async function wakeLines(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  generation: { model?: string; effort?: string; turnId?: string },
  follow: HeldFollow,
  input?: Pick<TurnInput, 'options' | 'context'>,
): Promise<Reply> {
  const opened = await openConversation(host, ref, { kind: 'read' });
  if (!ctx.options.lateResultsDecider || opened.conversation.paused) return unheld(noLines());
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
async function* wakeReplyLines(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  ref: string | null,
  generation: { model?: string; effort?: string; turnId?: string },
  held: HeldRun | undefined,
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
async function currentView(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  conversation: StoredConversation,
): Promise<ConversationView> {
  const view = conversationView(host, conversation);
  if (!view.transcript.some(isDetachedBlock)) return view;
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
    ...((await wakeDue(ctx, at, host, ref, conversation)) ? { wake: true as const } : {}),
  };
}

/**
 * Whether the page wakes the chat now: the decider's policy tells a waiting result to a reply to no
 * message. Never while a reply waits on gates: the answer that goes on reads what waits.
 */
async function wakeDue(
  ctx: CoreState,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  conversation: StoredConversation,
): Promise<boolean> {
  const decider = ctx.options.lateResultsDecider;
  if (!decider || conversation.paused) return false;
  const chat = chatInbox(ctx, at, host, { ref, conversation });
  const { items } = await chat.inbox.read(chat.key);
  if (items.length === 0) return false;
  const { tell } = await decider.policy(items, {
    stage: 'pre_turn',
    step: 0,
    opening: 'wake',
    host: await at.host,
  });
  return tell.length > 0;
}

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;

function isDetachedBlock(block: TranscriptBlock): block is ToolBlock {
  return block.kind === 'tool' && block.tool.state?.phase === 'background';
}

/** A detached call's block as its operation stands. One the session no longer holds has no known end. */
async function lateBlock(
  ctx: CoreState,
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
async function* answered(
  held: HeldRun | undefined,
  paused: string | undefined,
  reply: () => AsyncIterable<ReplyLine>,
): AsyncGenerator<ReplyLine> {
  if (held && paused) await held.run.resume(paused);
  yield* reply();
}

/** The person's message: a new reply, run against the conversation the app keeps. */
async function message(
  ctx: CoreState,
  at: CoreContext,
  args: {
    ref?: string;
    message: PostedMessage;
    generation: Generation;
    abandon?: readonly GateReference[];
  },
): Promise<Reply> {
  const { generation } = args;
  const host = conversationHost(ctx, at);
  if (!host) {
    if (args.ref !== undefined) throw statelessRefusal('continue');
    // labels-exempt: internal diagnostic; the user reads error.request
    if (args.abandon) throw statelessRefusal('walk away from');
    const runner = chatRunner(ctx, at, generation);
    return unheld(
      runner.run({
        input: args.message.input,
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
  return heldLines(ctx, at, host, opened, { opening: 'message', takeOver: true }, (held) =>
    messageReply({
      host,
      opened,
      message: args.message,
      ...(walkAway ? { walkAway } : {}),
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
async function answer(ctx: CoreState, at: CoreContext, body: TheoremInvokeRequest): Promise<Reply> {
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
async function wake(
  ctx: CoreState,
  at: CoreContext,
  args: {
    ref: string;
    generation?: Generation;
    input?: Pick<TurnInput, 'options' | 'context'>;
    /** A server's wake: it runs each next reply itself while results wait. */
    again?: boolean;
  },
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
async function read(
  ctx: CoreState,
  at: CoreContext,
  args: { ref: string },
): Promise<ConversationView> {
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('read');
  const opened = await openConversation(host, args.ref, { kind: 'read' });
  return currentView(ctx, at, host, args.ref, opened.conversation);
}

/** The conversation cut after one block; a reply that waits on gates is walked away from first. */
async function rewind(
  ctx: CoreState,
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

/** One conversation's runs, as whoever serves it calls them. */
export type ConversationCore = {
  message(at: CoreContext, args: Parameters<typeof message>[2]): Promise<Reply>;
  answer(at: CoreContext, body: TheoremInvokeRequest): Promise<Reply>;
  wake(at: CoreContext, args: Parameters<typeof wake>[2]): Promise<Reply>;
  read(at: CoreContext, args: { ref: string }): Promise<ConversationView>;
  rewind(at: CoreContext, args: { ref: string; at: number }): Promise<TheoremRewound>;
  /** Puts `unit` into a running turn. False when the turn is not running. */
  steer(at: CoreContext, args: { turnId: string; unit: SteerUnit }): Promise<boolean>;
  /** Stops a running turn where it stands. False when the turn is not running. */
  stop(at: CoreContext, args: { turnId: string }): Promise<boolean>;
};

/** The conversation core over `state`. */
export function createConversationCore(state: CoreState): ConversationCore {
  return {
    message: (at, args) => message(state, at, args),
    answer: (at, body) => answer(state, at, body),
    wake: (at, args) => wake(state, at, args),
    read: (at, args) => read(state, at, args),
    rewind: (at, args) => rewind(state, at, args),
    steer: (at, { turnId, unit }) =>
      Promise.resolve(state.inbox.enqueue(inboxKey(at.sessionId, turnId), unit)),
    stop: (at, { turnId }) => Promise.resolve(state.inbox.stop(inboxKey(at.sessionId, turnId))),
  };
}
