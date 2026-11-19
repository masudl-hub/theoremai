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
  type NormalizedTurnRequest,
  type Profile,
  type ProfileDefinition,
  type ProviderHostOptions,
  runTurn,
  TheoremError,
  type TurnEvent,
  type TurnHistoryMessage,
  type TurnInput,
  type TurnRequest,
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
  type PostedMessage,
  postedMessage,
  type ReplyLine,
  type ReplyRunner,
  type ReplySaving,
  type ReplyToSave,
  type ReplyTurn,
  readerConversationHost,
  rewindConversation,
  type ShapedReply,
  statelessRefusal,
  waitingCalls,
  wakeReply,
} from './conversation.ts';
import { detachedEnd, sessionConversationInbox } from './conversation-inbox.ts';
import {
  type ReplyEnd,
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
  pausedWaits,
  recorded,
  replayAllowed,
  sessionCredentials,
  settlingOf,
  takeLapsed,
  takeWalkedAway,
  withAuthorizationUrls,
} from './session-calls.ts';
import type { TheoremSessionState } from './session-store.ts';
import { type SteerInbox, type SteerUnit, steerStage, stopOnRequest } from './steer-inbox.ts';
import { sessionToolCoordinator } from './tool-operations.ts';
import { isRefusal, preparedTurn, type ReplyRefusal, stagesInOrder } from './turn-wiring.ts';

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
function chatInterface(chat: ChatContext): ComposerProfileInterface {
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
  /**
   * The app's stop for a reply under a hold, kept where every server of the app reads it. Set,
   * `stop` asks it and no turn id is read. Unset, a stop reaches a turn by its id, in `steerInbox`.
   */
  stop?: HoldStop;
};

/** A stop for the reply that holds a conversation, whichever server, channel or wake runs it. */
export type HoldStop = {
  /** Asks the reply that holds `conversation` now to stop. False when no reply holds it. */
  ask(conversation: string): Promise<boolean>;
  /** Settles `true` once a stop is asked for `hold`, and `false` once `over` aborts: the run ended. */
  stopped(conversation: string, hold: string, over: AbortSignal): Promise<boolean>;
  /**
   * Removes a stop asked for `hold`. Called as each model run under the hold ends, so a stop that
   * came too late for one reply does not stop the follow-up under the same hold.
   */
  clear(conversation: string, hold: string): Promise<void>;
};

/**
 * The turn the app runs for one model run of a reply, as `TurnWiring.prepare` is. `run` is the
 * reply's hold of the app's `inbox`: the items it opened with, and `take` for those that arrive
 * as it runs. It is unset with no app inbox, and for the turn of an answered call. A
 * `ReplyRefusal` in place of the turn makes the app's line the reply, saved as `refused`, with no
 * model run; the turn of an answered call cannot be refused.
 */
export type ReplyPrepare<Item extends InboxItem = InboxItem> = (
  turn: NormalizedTurnRequest,
  run?: ReplyRun<Item>,
) => TurnRequest | ReplyRefusal | Promise<TurnRequest | ReplyRefusal>;

/**
 * The app's own steps around each save of a reply. Each takes the run's context, as every option
 * of the core does.
 */
export type SaveHooks<Item extends InboxItem = InboxItem> = {
  /**
   * Shapes a reply before each save: the blocks to save in place of the reply's, the ids of the
   * inbox items it told, and the app's own values for its store's write. `held` is the reply's
   * hold of the app's `inbox`. With it set, a reply that failed gets no error block from the
   * core: the app words the failure. A throw on a reply that failed or was stopped is reported
   * to `onError` and saves nothing; any other throw fails the reply.
   */
  beforeSave?: (
    at: CoreContext,
    reply: ReplyToSave & { held?: ReplyRun<Item> },
  ) => Promise<ShapedReply>;
  /** Runs once a save is written, under the hold. What it throws goes to `onError`. */
  afterSave?: (
    at: CoreContext,
    saved: { ended: ReplyEnd; told: readonly string[] },
  ) => Promise<void>;
  /**
   * The app's compaction, in place of the core's, when a saved reply says the history is due
   * for it. The core then writes nothing after the reply. What it throws goes to `onError`.
   */
  compact?: (
    at: CoreContext,
    signal: { history: TurnHistoryMessage[]; tokens: number },
  ) => Promise<void>;
};

/**
 * The app's own parts of a reply: its turn, its inbox, and its steps around each save. The
 * conversation core and `createTheoremHandler` take the same ones.
 */
export type ReplyWiring<Item extends InboxItem = InboxItem> = SaveHooks<Item> & {
  /**
   * The app's own turn, from the one a reply builds: `TurnWiring.prepare`, the value the app's
   * other call sites use too. The reply keeps its profile and its abort. The app's `onStage`
   * runs before the reply's steering, and its `credentials` are read before the session's. An
   * `execution` it returns decides each call, and the session still records the same call; a
   * `background` it returns takes the place of the `background` option, and `notifier` still
   * tells the page. A call held at a gate runs on, once answered, with the `host`, `onStage`,
   * `credentials`, `execution` and `background` it gives for that call's turn. With `inbox`, it
   * is also given the reply's hold, so the turn it returns can tell the model the items the
   * reply reads: at once, or from its `onStage`.
   */
  prepare?: ReplyPrepare<Item>;
  /**
   * The app's own inbox, for the runs of one context. Every reply then runs under a hold of the
   * conversation in it. Unset, a reply holds the session's inbox of ended background calls when
   * `lateResultsDecider` is set, and holds nothing otherwise. Not with `lateResultsDecider`: the
   * app's inbox holds every item a reply is told.
   */
  inbox?: (at: CoreContext) => AppInbox<Item>;
};

/** Refuses an app's inbox beside a decider for the session's: one inbox holds what a reply is told. */
export function oneInbox(options: { inbox?: unknown; lateResultsDecider?: unknown }): void {
  if (options.inbox === undefined || options.lateResultsDecider === undefined) return;
  // labels-exempt: builder config error; the user reads error.config
  throw new TheoremError(
    'config',
    "pass `inbox` or `lateResultsDecider`, not both: the app's inbox holds every item a reply is told",
  );
}

/** Everything a conversation's runs read from whoever serves them. */
export type CoreState<Item extends InboxItem = InboxItem> = Omit<CallsContext, 'options'> & {
  chat: ChatContext;
  steer: SteerInbox;
  options: Omit<CallsContext['options'], 'prepare'> &
    ReplyWiring<Item> & {
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
 * How one run of a conversation ended. `released`: the run let the conversation go. `continue`:
 * items wait that may be told now, and `hold` still has the conversation under `ref`; the caller
 * runs `followUp` or calls `release`. `failure` is what the run threw, for the caller to throw
 * once it has done either. `held`: nothing ran, and a run after `leasedUntil` may: until then
 * another hold has the conversation and tells what waits, or a paused reply waits on a gate that
 * lapses then. `lost`: this run's hold no longer has it.
 */
export type RunEnd =
  | { outcome: 'released' }
  | { outcome: 'continue'; ref: string; hold: string; failure?: unknown }
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
  /** Records the ids of the items the reply's save marked as told. */
  told: (ids: readonly string[]) => void;
  /** The app's stop for this hold. Unset, a stop reaches the turn by its id. */
  stop?: { stopped: (over: AbortSignal) => Promise<boolean>; clear: () => Promise<void> };
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
    stop?: HoldStop;
  },
  chat: { ref: () => string | null; seen: (line: ReplyLine) => void },
): Holding<Item> {
  const { inbox, key, policy, stop } = kept;
  const letGo = async (hold: string) => {
    for (;;) {
      const { version } = await inbox.read(key);
      if ((await inbox.release(key, hold, version)) !== 'moved') return;
    }
  };
  return {
    run: async (start, lines, send) => {
      const told = new Set<string>();
      const run = await runConversation({
        conversation: key,
        inbox,
        policy,
        start,
        newId: () => crypto.randomUUID(),
        renewEveryMs: kept.leaseMs / 3,
        reply: async (run) => {
          const held = {
            run,
            renew: () => inbox.renew(key, run.hold),
            reads: kept.reads(run),
            told: (ids: readonly string[]) => {
              for (const id of ids) told.add(id);
            },
            ...(stop
              ? {
                  stop: {
                    stopped: (over: AbortSignal) => stop.stopped(key, run.hold, over),
                    clear: () => stop.clear(key, run.hold),
                  },
                }
              : {}),
          };
          const ref = chat.ref();
          // why: The page moves a message it shows as waiting into the reply that reads it, as the reply starts.
          if (run.opened.length > 0 && ref !== null) {
            send({ type: 'conversation', ref, opened: run.opened.map((item) => item.id) });
          }
          for await (const line of lines(held)) {
            chat.seen(line);
            send(line);
          }
        },
        gaveUp: kept.gaveUp,
      });
      if (run.outcome !== 'continue' || told.size === 0) return run;
      // why: A follow-up would tell these items again, and each follow-up after it, with no end.
      const { items } = await inbox.read(key);
      // why: An item that arrived again under a told id has no handover of this hold, and is new.
      const unmarked = (item: Kept) =>
        told.has(item.id) && item.handovers.some((handover) => handover.hold === run.hold);
      if (!items.some(unmarked)) return run;
      await letGo(run.hold);
      throw new TheoremError(
        'config',
        // labels-exempt: builder config error; onError receives it and the user reads error.config
        "the reply's save did not mark its `told` items in the inbox: the store's `write` marks them",
      );
    },
    letGo,
    async due() {
      const { items } = await inbox.read(key);
      if (items.length === 0) return false;
      const { tell } = await policy(items, { stage: 'pre_turn', step: 0, opening: 'wake' });
      return tell.length > 0;
    },
    ref: chat.ref,
  };
}

/** The chat's ref, as each `conversation` line of a run changes it. */
function chatRef(first: string | null) {
  let ref = first;
  return {
    ref: () => ref,
    seen(line: ReplyLine) {
      if (line.type === 'conversation') ref = line.ref;
    },
  };
}

/** Reports the items an inbox policy gave up, under `code`. */
function gaveUp<Item extends InboxItem>(ctx: CoreState<Item>, at: CoreContext, code: string) {
  return (items: readonly InboxItem[]) => {
    ctx.options.onError?.(
      // labels-exempt: internal diagnostic; no reader sees a given-up item
      new TheoremError('unavailable', 'The inbox policy gave up items', {
        cause: { code, operationIds: items.map((item) => item.id) },
      }),
      at,
    );
  };
}

/**
 * The app's inbox, when it passes one. Its key is the app's, so it holds one conversation for
 * every session and stored chat that names that key.
 */
function appHolding<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  ref: string | null,
): Holding<Item> | undefined {
  const app = ctx.options.inbox?.(at);
  if (!app) return undefined;
  return holdingOver(
    {
      inbox: app.inbox,
      key: app.conversation,
      leaseMs: app.leaseMs,
      policy: app.policy,
      reads: (run) => ({ from: 'app', run }),
      gaveUp: gaveUp(ctx, at, 'inbox_items_given_up'),
      ...(app.stop ? { stop: app.stop } : {}),
    },
    chatRef(ref),
  );
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
  const app = appHolding(ctx, at, opened.ref);
  if (app) return app;
  const chat = chatRef(opened.ref);
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
      gaveUp: gaveUp(ctx, at, 'late_results_given_up'),
    },
    chat,
  );
}

/**
 * Runs a reply under a hold of the chat, and streams its lines. The reply reads the items the
 * policy tells it. With no inbox to hold, no reply reads one, and no hold is taken.
 * invariant: One hold has a chat at a time, and lets it go only once nothing waits that may be told.
 * A run that leaves items waiting ends `continue`, with its hold: the caller runs the follow-up or
 * lets the chat go. Never while the chat waits on gates: the answer that goes on reads what waits.
 */
function heldLines<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  opened: Pick<OpenedConversation, 'ref' | 'conversation'>,
  start: ReplyStart,
  reply: (held: HeldRun<Item> | undefined, ref: () => string | null) => AsyncIterable<ReplyLine>,
): Reply {
  const holding = holdingOf(ctx, at, host, opened);
  if (!holding) return unheld(reply(undefined, () => opened.ref));
  return sent<ReplyLine, RunEnd>(async (send) => {
    const run = await holding.run(start, (held) => reply(held, holding.ref), send);
    if (run.outcome === 'held') return { outcome: 'held', leasedUntil: run.leasedUntil };
    if (run.outcome === 'continue') {
      const ref = holding.ref();
      if (ref !== null && !(await isPaused(host, ref, opened.conversation))) {
        return {
          outcome: 'continue',
          ref,
          hold: run.hold,
          ...(run.failure === undefined ? {} : { failure: run.failure }),
        };
      }
      await holding.letGo(run.hold);
    }
    if (run.failure !== undefined) throw run.failure;
    return { outcome: run.outcome === 'lost' ? 'lost' : 'released' };
  });
}

/**
 * What the caller of a run that ended `continue` does with its hold. `here`: runs the follow-up
 * in the same stream. `taken`: the app runs it elsewhere, by a call of its own to `followUp`.
 * `let_go`: no follow-up runs, and whoever opens the conversation next reads what waits.
 */
export type ContinueChoice = 'here' | 'taken' | 'let_go';

/**
 * A run, then what `choose` says for each `continue` it and its follow-ups end with. It ends as
 * the last run ended, `continue` only when the app took it, and throws the first failure.
 */
export async function* followedUp(
  core: Pick<ConversationCore, 'followUp' | 'release'>,
  at: CoreContext,
  reply: Reply,
  choose: (run: { ref: string; hold: string }) => ContinueChoice | Promise<ContinueChoice>,
): Reply {
  let end = yield* reply;
  let failure: unknown;
  while (end.outcome === 'continue') {
    failure ??= end.failure;
    const { ref, hold } = end;
    const choice = await choose({ ref, hold });
    if (choice === 'taken') break;
    if (choice === 'let_go') {
      await core.release(at, { ref, hold });
      end = { outcome: 'released' };
      break;
    }
    end = yield* await core.followUp(at, { ref, hold });
  }
  if (failure !== undefined) throw failure;
  return end;
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
  refused: (refusal: ReplyRefusal['refuse']) => void,
): AsyncGenerator<TurnEvent> {
  const state = await ctx.sessions.read(at.sessionId);
  const provider = await ctx.options.provider(at, turn.model);
  const host = await at.host;
  const over = new AbortController();
  if (key) await ctx.steer.open(key);
  if (held?.stop) {
    held.stop.stopped(over.signal).then(
      (stopped) => {
        if (stopped) stop.abort();
      },
      (err) => ctx.options.onError?.(err, at),
    );
  } else if (key) {
    stopOnRequest(ctx.steer, key, stop);
  }
  try {
    const onStage = stagesInOrder(
      ctx.options.onStage,
      key ? steerStage(ctx.steer, key) : undefined,
    );
    const { prepare } = ctx.options;
    const run = held?.reads.from === 'app' ? held.reads.run : undefined;
    const prepared = await preparedTurn(
      prepare && ((request) => prepare(request, run)),
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
    if (isRefusal(prepared)) {
      refused(prepared.refuse);
      yield { type: 'text', text: prepared.refuse.text };
      yield { type: 'done', stop: { kind: 'completed' } };
      return;
    }
    const events = runTurn(prepared, provider);
    yield* recorded(ctx.sessions, at.sessionId, withAuthorizationUrls(ctx, at, events), {
      profileId: ctx.profile.id,
      turnInput: turn.input,
      model: turn.model,
    });
  } finally {
    over.abort();
    // why: A stop that stays set would stop the follow-up, which keeps this hold.
    await held?.stop?.clear().catch((err) => ctx.options.onError?.(err, at));
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
  let refusal: ReplyRefusal['refuse'] | undefined;
  return {
    run: (turn) =>
      chatTurn(ctx, at, turn, key, signal, stop, held, (refused) => {
        refusal = refused;
      }),
    refused: () => refusal,
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
    ...(held ? { reply: held.run.reply, hold: held.run.hold, held: held.renew } : {}),
    saving: replySaving(ctx, at, held),
  };
}

/** The app's steps around a reply's save, bound to `at` and to the reply's hold. */
function replySaving<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  held: HeldRun<Item> | undefined,
): ReplySaving {
  const { beforeSave, afterSave, compact, onError } = ctx.options;
  return {
    ...(beforeSave
      ? {
          before: (reply) =>
            beforeSave(at, {
              ...reply,
              ...(held?.reads.from === 'app' ? { held: held.reads.run } : {}),
            }),
        }
      : {}),
    after: async (saved) => {
      held?.told(saved.told);
      await afterSave?.(at, saved);
    },
    ...(compact ? { compact: (signal) => compact(at, signal) } : {}),
    report: (err) => onError?.(err, at),
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
 * paused reply still waits: the answer that goes on reads what waits. Once every gate of a paused
 * reply has lapsed, the wake walks away from it and runs.
 */
async function wakeLines<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  generation: { model?: string; effort?: string; turnId?: string },
  input?: Pick<TurnInput, 'options' | 'context'>,
): Promise<Reply> {
  const opened = await openConversation(host, ref, { kind: 'read' });
  if (!holds(ctx)) return unheld(noLines());
  const waits = await pausedWaits(ctx, at, opened.conversation);
  if (waits) return waiting(waits);
  return heldLines(ctx, at, host, opened, { opening: 'wake' }, (held, current) =>
    wakeReplyLines(ctx, at, host, current(), generation, held, input),
  );
}

/** No reply lines. */
async function* noLines(): AsyncGenerator<ReplyLine> {}

/**
 * No run, while a paused reply waits: `held` until its last gate lapses. A gate with no time limit
 * never lapses, so the run ends `released` and only the person's answer or next message goes on.
 */
async function* waiting(waits: { until?: number }): Reply {
  yield* noLines();
  return waits.until === undefined
    ? { outcome: 'released' }
    : { outcome: 'held', leasedUntil: waits.until };
}

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
  const walkAway = opened.conversation.paused
    ? await takeLapsed(ctx, at, opened.conversation)
    : undefined;
  // why: an answer landed since the run was let in, so the reply still waits and the answer goes on
  if (opened.conversation.paused && !walkAway) return;
  const runner = chatRunner(ctx, at, generation, held);
  yield* wakeReply({
    host,
    opened,
    runner,
    ...(input ? { input } : {}),
    ...(walkAway ? { walkAway } : {}),
  });
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
 * message. Never while a paused reply still waits: the answer that goes on reads what waits.
 */
async function wakeDue<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  host: ConversationHost,
  ref: string,
  conversation: StoredConversation,
): Promise<boolean> {
  if (await pausedWaits(ctx, at, conversation)) return false;
  const holding = holdingOf(ctx, at, host, { ref, conversation });
  return holding ? holding.due() : false;
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

/**
 * The message as the profile accepts it, and the conversation it posts to, when the host keeps
 * one. Refuses a message the profile does not take, a conversation the host does not have, and a
 * walk-away that does not name the calls the paused reply waits on. Changes nothing.
 */
async function messageOpened<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: Pick<MessageArgs, 'ref' | 'input' | 'context' | 'abandon'>,
): Promise<{
  posted: PostedMessage;
  kept?: { host: ConversationHost; opened: OpenedConversation };
}> {
  const posted = postedMessage(chatInterface(ctx.chat), args.input, args.context);
  const host = conversationHost(ctx, at);
  if (!host) {
    if (args.ref !== undefined) throw statelessRefusal('continue');
    // labels-exempt: internal diagnostic; the user reads error.request
    if (args.abandon) throw statelessRefusal('walk away from');
    return { posted };
  }
  const opened = await openConversation(host, args.ref, {
    kind: 'message',
    ...(args.abandon ? { abandon: args.abandon } : {}),
  });
  return { posted, kept: { host, opened } };
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
  const { posted, kept } = await messageOpened(ctx, at, args);
  if (!kept) {
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
  const { host, opened } = kept;
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
  return await wakeLines(ctx, at, host, args.ref, args.generation ?? {}, args.input);
}

/**
 * One follow-up, under the hold a run ended `continue` with. `ref` is the chat the follow-up
 * answers in, which is `at`'s to read: under an app inbox it can be another session's than the
 * run's.
 */
async function followUp<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: FollowUpArgs,
): Promise<Reply> {
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('wake');
  if (!holds(ctx)) return unheld(noLines());
  const opened = await openConversation(host, args.ref, { kind: 'read' }).catch(
    async (err: unknown) => {
      // why: a follow-up that cannot open its chat runs nothing, so the hold is let go at once
      await appHolding(ctx, at, args.ref)?.letGo(args.hold);
      throw err;
    },
  );
  if (await pausedWaits(ctx, at, opened.conversation)) {
    await holdingOf(ctx, at, host, opened)?.letGo(args.hold);
    return unheld(noLines());
  }
  const start: ReplyStart = { opening: 'follow_up', hold: args.hold };
  return heldLines(ctx, at, host, opened, start, (held, current) =>
    wakeReplyLines(ctx, at, host, current(), args.generation ?? {}, held, args.input),
  );
}

/**
 * Lets the conversation go under the hold a run ended `continue` with. Under an app inbox no chat
 * is read: the hold is of the app's key.
 */
async function release<Item extends InboxItem>(
  ctx: CoreState<Item>,
  at: CoreContext,
  args: { ref: string; hold: string },
): Promise<void> {
  const app = appHolding(ctx, at, args.ref);
  if (app) return app.letGo(args.hold);
  const host = conversationHost(ctx, at);
  if (!host) throw statelessRefusal('wake');
  const opened = await openConversation(host, args.ref, { kind: 'read' });
  await holdingOf(ctx, at, host, opened)?.letGo(args.hold);
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
};

/** A follow-up, for {@link ConversationCore.followUp}: the `ref` and `hold` of a `continue`. */
export type FollowUpArgs = {
  ref: string;
  hold: string;
  generation?: Generation;
  input?: Pick<TurnInput, 'options' | 'context'>;
};

/** A conversation's runs, with no HTTP request. Each run's lines end with how it ended. */
export type ConversationCore = {
  /** The person's message: it posts, and its reply runs. */
  message(at: CoreContext, args: MessageArgs): Promise<Reply>;
  /**
   * Throws what `message` throws for `args` before it runs anything, and changes nothing: for an
   * app that saves the message itself, to call before that save.
   */
  checkMessage(
    at: CoreContext,
    args: Pick<MessageArgs, 'ref' | 'input' | 'context' | 'abandon'>,
  ): Promise<void>;
  /** The person's answer to a paused call; the reply goes on once no call waits. */
  answer(at: CoreContext, body: TheoremInvokeRequest): Promise<Reply>;
  /** A reply to no message, for items that arrived since the model last ran. */
  wake(at: CoreContext, args: WakeArgs): Promise<Reply>;
  /**
   * The next reply to no message, under the hold of a run that ended `continue`. `at` may name
   * another session than that run's, when the app's `inbox` names the same conversation for both.
   */
  followUp(at: CoreContext, args: FollowUpArgs): Promise<Reply>;
  /** Lets the conversation go under `hold`, with no reply: after a run that ended `continue`, or a hold the app took itself. */
  release(at: CoreContext, args: { ref: string; hold: string }): Promise<void>;
  /** The conversation as a page draws it. */
  read(at: CoreContext, args: { ref: string }): Promise<ConversationView>;
  /** The conversation cut after block `at`; a reply that waits on gates is walked away from first. */
  rewind(at: CoreContext, args: { ref: string; at: number }): Promise<TheoremRewound>;
  /** Puts `unit` into a running turn. False when the turn is not running. */
  steer(at: CoreContext, args: { turnId: string; unit: SteerUnit }): Promise<boolean>;
  /**
   * Stops a running turn where it stands. False when the turn is not running. Where the app's
   * `inbox` has a `stop`, it stops the reply that holds the conversation, and reads no `turnId`.
   */
  stop(at: CoreContext, args: { turnId: string }): Promise<boolean>;
};

/** The conversation core over `state`. */
export function createConversationCore<Item extends InboxItem = InboxItem>(
  state: CoreState<Item>,
): ConversationCore {
  oneInbox(state.options);
  return {
    message: (at, args) => message(state, at, args),
    checkMessage: async (at, args) => {
      await messageOpened(state, at, args);
    },
    answer: (at, body) => answer(state, at, body),
    wake: (at, args) => wake(state, at, args),
    followUp: (at, args) => followUp(state, at, args),
    release: (at, args) => release(state, at, args),
    read: (at, args) => read(state, at, args),
    rewind: (at, args) => rewind(state, at, args),
    steer: (at, { turnId, unit }) =>
      Promise.resolve(state.steer.enqueue(inboxKey(at.sessionId, turnId), unit)),
    stop: (at, { turnId }) => {
      const app = state.options.inbox?.(at);
      if (app?.stop) return app.stop.ask(app.conversation);
      return Promise.resolve(state.steer.stop(inboxKey(at.sessionId, turnId)));
    },
  };
}
