/**
 * One reply, run against the conversation its host stores: the history goes
 * to the model from the store, never from the browser, and what the reply
 * leaves (its transcript, its history, a paused reply) is written back.
 *
 * Every host runs replies through here: `createTheoremHandler` with the
 * kernel's `runTurn`, the studio with its own scope. Each run streams its
 * events, then one `conversation` line with the ref the store issued, then
 * the run's error when it failed.
 *
 * The conversation owns the transcript, the history, and the paused reply's
 * events. Which paused calls may run, and with what input, stays the host's
 * session store's: a call is answered there first, and its events settle it here.
 *
 * @module
 */

import {
  attachmentsRefused,
  type GateReference,
  type LabelOverrides,
  labelText,
  type Profile,
  type ProviderCheckpoint,
  TheoremError,
  type TurnEvent,
  type TurnHistoryMessage,
  type TurnInput,
  toErrorEvent,
} from '@theoremjs/agents';
import { sanitizeTurnRequestWithEvents, withPublicLabels } from '@theoremjs/agents/guardrails';
import { type ClientTurnOptions, forClient } from '@theoremjs/agents/host';
import {
  appendAssistantEventsToHistory,
  appendUserDraftToHistory,
  applyTurnEventsToSession,
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  foldTurnEvents,
  gatedToolsFromEvents,
  historyFromTranscriptBlocks,
  type PendingAttachment,
  prepareUserTurn,
  type ReplyCarried,
  replyCarriedFromEvents,
  settlesToolCall,
  streamThoughtsEnabled,
  type TranscriptBlock,
  type UserTurnDraft,
  type UserTurnHistoryMedia,
} from '@theoremjs/agents/interface';
import { base64ToBytes } from '@theoremjs/agents/kernel';
import { stampWorked, stoppedReply } from '../client/run-commit.ts';
import type {
  ConversationLine,
  ConversationView,
  EncodedBlob,
  StatedTurn,
  TheoremTurnInput,
} from '../client/transport.ts';
import {
  emptyConversation,
  type PausedReply,
  type StoredConversation,
  type TheoremConversationStore,
  type UncompactedBase,
  unknownConversation,
} from './conversation-store.ts';
import { kernelTurnInput } from './turn-input.ts';

/** One walked-away call: its id, and the run that settles it (`invokeTool` with the abandoned resume). */
export type WalkedAwayCall = { callId: string; events: AsyncIterable<TurnEvent> };

/** A walked-away call as the session issued it: the operation names the one call, since a model reuses call ids. */
export type IssuedWalkAway = WalkedAwayCall & GateReference;

/** The paused call a reference names, when its call id and its operation both match. */
function waitingOn(conversation: StoredConversation, reference: GateReference): boolean {
  return gatedToolsFromEvents(conversation.paused?.events ?? []).some(
    (call) => call.callId === reference.callId && call.operationId === reference.operationId,
  );
}

/** A turn's failure, as a run ends on it. */
export type ErrorEvent = Extract<TurnEvent, { type: 'error' }>;

/** What a run needs from the host that runs it. */
export type ConversationHost = {
  sessionId: string;
  store: TheoremConversationStore;
  /** Whether the profile shows the model's thoughts (`streamThoughtsEnabled`). */
  showThoughts: boolean;
  /** An event as the host's reader may have it (`forClient`). */
  forReader(event: TurnEvent): TurnEvent;
  /** A failure as the host's reader reads it: the profile's wording, by `forClient`'s rule. */
  failureText(failure: ErrorEvent): string;
};

/**
 * The conversation host for a profile as `forClient` shows it to `clientEvents`:
 * its thoughts as its outputs allow, its failures in its own wording.
 */
export function readerConversationHost(args: {
  sessionId: string;
  store: TheoremConversationStore;
  profile: { outputs?: Parameters<typeof streamThoughtsEnabled>[0]; labels?: LabelOverrides };
  clientEvents: ClientTurnOptions | undefined;
}): ConversationHost {
  const { profile, clientEvents } = args;
  return {
    sessionId: args.sessionId,
    store: args.store,
    showThoughts: streamThoughtsEnabled(profile.outputs),
    forReader: (event) => forClient(event, clientEvents),
    failureText(failure) {
      const worded = forClient(withPublicLabels(failure, profile.labels), clientEvents);
      return worded.type === 'error' && worded.error
        ? worded.error
        : labelText(`error.${failure.errorKind}`, {}, profile.labels);
    },
  };
}

/** A conversation read for a request: its ref and revision, or neither for a new one. */
export type OpenedConversation = {
  ref: string | null;
  revision: string | null;
  conversation: StoredConversation;
  /** What the guardrails decided reading a restored transcript, for the reply to stream first. */
  events?: TurnEvent[];
};

/**
 * What a request opens a conversation for, checked as it opens, before the host starts any run:
 * - `read`: to draw it (`conversationView`).
 * - `message`: to post a message (`messageReply`). A reply that waits on gates must be walked
 *   away from: `abandon` names exactly the calls it waits on.
 * - `answer`: to answer `call`, one the reply waits on (`answerReply`).
 * - `rewind`: to cut it after transcript block `at`, which it must hold; -1 empties it
 *   (`rewindConversation`).
 */
export type ConversationUse =
  | { kind: 'read' }
  | { kind: 'message'; abandon?: readonly GateReference[] }
  | { kind: 'answer'; call: GateReference }
  | { kind: 'rewind'; at: number };

/**
 * The conversation under `ref`, or a new one when the browser has none, refused when it does not
 * allow `use`.
 */
export async function openConversation(
  host: ConversationHost,
  ref: string | undefined,
  use: ConversationUse,
  restore?: ConversationRestore,
): Promise<OpenedConversation> {
  const opened = await openedAt(host, ref, restore);
  if (use.kind === 'message') requireWalkAway(opened.conversation, use.abandon);
  if (use.kind === 'answer') requireWaitingOn(opened.conversation, use.call);
  if (use.kind === 'rewind') requireRewindPoint(opened.conversation, use.at);
  return opened;
}

async function openedAt(
  host: ConversationHost,
  ref: string | undefined,
  restore: ConversationRestore | undefined,
): Promise<OpenedConversation> {
  if (ref === undefined) {
    if (restore)
      // labels-exempt: internal diagnostic; the user reads error.request
      throw new TheoremError(
        'request',
        'a transcript restores a conversation the host lost, and this message names none',
      );
    return { ref: null, revision: null, conversation: emptyConversation() };
  }
  const snapshot = await host.store.read(host.sessionId, ref);
  if (snapshot) return { ref, revision: snapshot.revision, conversation: snapshot.conversation };
  if (!restore) throw unknownConversation();
  // why: A null ref makes the reply's write a new conversation, whose ref the `conversation` line hands the page.
  const { conversation, events } = conversationFromBlocks(restore.profile, restore.blocks);
  return { ref: null, revision: null, conversation, events };
}

/**
 * The page's own transcript, for a conversation the host can no longer open (its key changed, or
 * its store forgot it): the message goes on from it rather than failing. The host's copy is the
 * truth while it opens; this is read only when it does not.
 */
export type ConversationRestore = { profile: Profile; blocks: readonly TranscriptBlock[] };

/**
 * A conversation from transcript blocks, read as history by the profile's guardrails at the
 * `history` boundary, as every turn's history is. A match set to `block` refuses them. Returns it
 * with the guardrail events for what matched.
 */
function conversationFromBlocks(
  profile: Profile,
  blocks: readonly TranscriptBlock[],
): { conversation: StoredConversation; events: TurnEvent[] } {
  const { request, events, refusal } = sanitizeTurnRequestWithEvents(
    { profile: profile.id, input: { history: historyFromTranscriptBlocks(blocks) } },
    profile,
  );
  if (refusal) throw refusal;
  return {
    conversation: {
      ...emptyConversation(),
      transcript: [...blocks],
      history: request.input?.history ?? [],
    },
    events,
  };
}

/**
 * Starts a conversation from blocks the host wrote, not ran: a chat that opens on an exchange
 * already under way. The model reads them as history on the next turn, read first by the
 * profile's guardrails at the `history` boundary, as every turn's history is. A match set to
 * `block` refuses them, and nothing is stored. Returns the new conversation's ref, its view for
 * the chat's `conversationView`, and the guardrail events for what matched.
 */
export async function startConversation(
  host: Pick<ConversationHost, 'sessionId' | 'store'>,
  profile: Profile,
  blocks: readonly TranscriptBlock[],
): Promise<{ ref: string; view: ConversationView; events: TurnEvent[] }> {
  const { conversation, events } = conversationFromBlocks(profile, blocks);
  const result = await host.store.write(host.sessionId, null, null, conversation);
  if (!result.written) {
    // labels-exempt: internal diagnostic; the user reads error.unavailable
    throw new TheoremError(
      'unavailable',
      'the conversation store did not keep the new conversation',
    );
  }
  // why: A new conversation has no paused reply, so its view is the transcript alone.
  return { ref: result.ref, view: { transcript: [...blocks] }, events };
}

function foldedFor(host: ConversationHost, events: readonly TurnEvent[]): TranscriptBlock[] {
  return foldTurnEvents(
    events.map((event) => host.forReader(event)),
    { showThoughts: host.showThoughts },
  );
}

/** The conversation as the browser draws it. */
export function conversationView(
  host: ConversationHost,
  conversation: StoredConversation,
): ConversationView {
  const { paused } = conversation;
  return {
    transcript: conversation.transcript,
    ...(paused
      ? {
          paused: {
            events: paused.events.map((event) => host.forReader(event)),
            blocks: stampWorked(foldedFor(host, paused.events), {
              workedMs: paused.workedMs,
              endedAt: paused.endedAt,
            }),
          },
        }
      : {}),
  };
}

const CONFLICT = { code: 'conversation_conflict' } as const;

/** Writes `next` over what the request read; a write another request beat is refused. */
async function save(
  host: ConversationHost,
  opened: OpenedConversation,
  next: StoredConversation,
): Promise<OpenedConversation> {
  const result = await host.store.write(host.sessionId, opened.ref, opened.revision, next);
  if (!result.written) {
    // labels-exempt: internal diagnostic; the user reads error.unavailable
    throw new TheoremError('unavailable', 'the conversation changed while this reply ran', {
      cause: CONFLICT,
    });
  }
  return { ref: result.ref, revision: result.revision, conversation: next };
}

/** The line that tells the browser the ref of what was just written. */
function refLine(opened: OpenedConversation, posted?: 'posted'): ConversationLine[] {
  if (opened.ref === null) return [];
  return [{ type: 'conversation', ref: opened.ref, ...(posted ? { posted: true } : {}) }];
}

/** One model run of a reply: the kernel's turn input, the checkpoint it continues, and the generation. */
export type ReplyTurn = {
  input: TurnInput;
  /** The stored conversation's id; a run with no conversation has none. */
  conversationId?: string;
  providerState?: ProviderCheckpoint;
  model?: string;
  effort?: string;
  stated?: StatedTurn;
  /** The tools and steps the reply had when it paused, for a reply that goes on. */
  carried?: ReplyCarried;
};

/** What a reply's model run takes from the host. */
export type ReplyRunner = {
  /** The reply's events for one run (`runTurn` with the host's own options). */
  run(turn: ReplyTurn): AsyncIterable<TurnEvent>;
  /**
   * Compacts history the profile says is due for it after a reply
   * (`done.compaction.needed`): the compacted history, or undefined to keep it.
   */
  compact(
    history: TurnHistoryMessage[],
    tokens: number,
    model: string | undefined,
  ): Promise<TurnHistoryMessage[] | undefined>;
  model?: string;
  effort?: string;
  stated?: StatedTurn;
  carried?: ReplyCarried;
  signal: AbortSignal;
  /** The reply's id under its chat's hold: a paused reply keeps it, so the reply that goes on resumes what it read. */
  reply?: string;
  /**
   * Whether the reply's hold still has its chat, asked before each save. A reply that lost it saves
   * nothing: the hold that took the chat tells what it read.
   */
  held?: () => Promise<boolean>;
};

/** A reply in progress: the history it was given, and its events. */
type Reply = {
  base: TurnHistoryMessage[];
  events: TurnEvent[];
  /** How many of `events` `base` already holds. */
  baseEvents: number;
  /** The base before the first compaction that folded in late results this reply read. */
  uncompacted?: UncompactedBase;
  workedMs: number;
};

/** The model's history once the reply's events enter it. */
function replyHistory(reply: Reply): TurnHistoryMessage[] {
  return appendAssistantEventsToHistory(reply.base, reply.events.slice(reply.baseEvents));
}

/** The conversation's meters and checkpoint after the reply's events. */
function metered(conversation: StoredConversation, events: readonly TurnEvent[]) {
  const applied = applyTurnEventsToSession(
    {
      ...emptyInterfaceTurnSession(),
      providerState: conversation.providerState,
      inputTokens: conversation.inputTokens,
      historyTokens: conversation.historyTokens,
    },
    events,
  );
  return {
    ...(applied.providerState ? { providerState: applied.providerState } : {}),
    ...(applied.inputTokens === undefined ? {} : { inputTokens: applied.inputTokens }),
    ...(applied.historyTokens === undefined ? {} : { historyTokens: applied.historyTokens }),
  };
}

/** The reply is over: its blocks, as `closing` ends them, join the transcript and its events the history. */
function committed(
  host: ConversationHost,
  conversation: StoredConversation,
  reply: Reply,
  closing: (blocks: TranscriptBlock[]) => TranscriptBlock[] = (blocks) => blocks,
): StoredConversation {
  const { paused: _paused, providerState: _state, ...rest } = conversation;
  return {
    ...rest,
    ...metered(conversation, reply.events),
    transcript: [
      ...conversation.transcript,
      ...stampWorked(closing(foldedFor(host, reply.events)), {
        workedMs: reply.workedMs,
        endedAt: Date.now(),
      }),
    ],
    history: replyHistory(reply),
  };
}

/** The reply waits on gates: its events wait beside the transcript until they settle. */
function pausedOn(
  conversation: StoredConversation,
  reply: Reply,
  runner: Pick<ReplyRunner, 'model' | 'effort' | 'stated' | 'reply'>,
): StoredConversation {
  const paused: PausedReply = {
    events: reply.events,
    base: reply.base,
    baseEvents: reply.baseEvents,
    ...(reply.uncompacted ? { uncompacted: reply.uncompacted } : {}),
    workedMs: reply.workedMs,
    endedAt: Date.now(),
    ...(runner.model ? { model: runner.model } : {}),
    ...(runner.effort ? { effort: runner.effort } : {}),
    ...(runner.stated ? { stated: runner.stated } : {}),
    ...(runner.reply ? { reply: runner.reply } : {}),
  };
  return { ...conversation, ...metered(conversation, reply.events), paused };
}

/**
 * The reply failed: it commits as far as it got, closed by its error. The late results it read
 * leave with it, so a later reply tells them. A compaction that folded them in is undone too: the
 * history goes back to its base before that compaction, and the next reply compacts again.
 */
function failed(
  host: ConversationHost,
  conversation: StoredConversation,
  reply: Reply,
  failure: ErrorEvent,
): StoredConversation {
  const from = reply.uncompacted ?? reply;
  const unread = (events: readonly TurnEvent[]) =>
    events.filter(
      (event, index) =>
        event.type !== 'late_results' &&
        !(reply.uncompacted && event.type === 'compaction' && index >= from.baseEvents),
    );
  const events = unread(reply.events);
  const next = committed(host, conversation, {
    base: from.base,
    events,
    baseEvents: unread(reply.events.slice(0, from.baseEvents)).length,
    workedMs: reply.workedMs,
  });
  if (next.transcript.slice(conversation.transcript.length).some((b) => b.kind === 'error')) {
    return next;
  }
  return {
    ...next,
    transcript: [
      ...next.transcript,
      { id: crypto.randomUUID(), kind: 'error', message: host.failureText(failure) },
    ],
  };
}

/**
 * The person stopped the reply: what they saw of it stays, in the transcript and the history
 * alike, closed as cancelled. A call still running when it stopped enters neither.
 */
function stopped(
  host: ConversationHost,
  conversation: StoredConversation,
  reply: Reply,
): StoredConversation {
  return committed(host, conversation, reply, stoppedReply);
}

/** A line of a reply's stream: an event, or the ref of what the store wrote. */
export type ReplyLine = TurnEvent | ConversationLine;

/**
 * Runs the model for `reply` and writes what it leaves. A compaction moves the
 * reply's base to the compacted history; `withMessage` puts the person's
 * message back on it when the reply answers one.
 */
async function* runReply(
  host: ConversationHost,
  opened: OpenedConversation,
  reply: Reply,
  runner: ReplyRunner,
  input: TurnInput,
  withMessage: (history: TurnHistoryMessage[]) => TurnHistoryMessage[],
): AsyncGenerator<ReplyLine> {
  const { conversation } = opened;
  const startedAt = Date.now();
  const worked = () => ({ ...reply, workedMs: reply.workedMs + (Date.now() - startedAt) });
  // invariant: A reply whose hold lost its chat saves nothing; the hold that has it tells what this one read.
  const held = async () => !runner.held || (await runner.held());
  let errorEvent: ErrorEvent | undefined;
  try {
    const events = runner.run({
      input,
      conversationId: conversation.id,
      providerState: conversation.providerState,
      model: runner.model,
      effort: runner.effort,
      ...(runner.stated ? { stated: runner.stated } : {}),
      ...(runner.carried ? { carried: runner.carried } : {}),
    });
    for await (const event of events) {
      reply.events.push(event);
      if (event.type === 'error') {
        // why: The browser throws on an error line, so it goes out after the conversation line.
        errorEvent = event;
        continue;
      }
      if (event.type === 'compaction') {
        // invariant: A failure must not leave in the history a late result it gives back.
        if (!reply.uncompacted && reply.events.some((seen) => seen.type === 'late_results')) {
          reply.uncompacted = { base: reply.base, baseEvents: reply.baseEvents };
        }
        reply.base = withMessage(event.history);
        reply.baseEvents = reply.events.length;
      }
      yield event;
    }
  } catch (err) {
    if (await held()) {
      const written = await save(
        host,
        opened,
        runner.signal.aborted
          ? stopped(host, conversation, worked())
          : failed(host, conversation, worked(), toErrorEvent(err)),
      );
      yield* refLine(written);
    }
    // why: A stopped reply is no failure; the browser draws what it left from the ref.
    if (!runner.signal.aborted) throw err;
    return;
  }
  const settled = worked();
  if (!(await held())) return;
  if (runner.signal.aborted) {
    yield* refLine(await save(host, opened, stopped(host, conversation, settled)));
  } else if (errorEvent) {
    yield* refLine(await save(host, opened, failed(host, conversation, settled, errorEvent)));
    yield errorEvent;
  } else if (gatedToolsFromEvents(settled.events).length) {
    yield* refLine(await save(host, opened, pausedOn(conversation, settled, runner)));
  } else {
    const current = await save(host, opened, committed(host, conversation, settled));
    yield* refLine(current);
    // why: The reply is the browser's before compaction runs, so a failed compaction loses none of it.
    if (!(await held())) return;
    const compacted = await compactedAfter(host, current, settled, runner, withMessage);
    if (compacted) yield* refLine(compacted);
  }
}

/**
 * The profile compacts after a reply (`done.compaction.needed`): the history
 * before the reply is compacted, and the reply's own messages follow it.
 */
async function compactedAfter(
  host: ConversationHost,
  opened: OpenedConversation,
  reply: Reply,
  runner: ReplyRunner,
  withMessage: (history: TurnHistoryMessage[]) => TurnHistoryMessage[],
): Promise<OpenedConversation | undefined> {
  const done = reply.events.findLast((event) => event.type === 'done');
  const signal = done?.type === 'done' ? done.compaction : undefined;
  if (!signal?.needed) return undefined;
  const compacted = await runner.compact(signal.history, signal.tokens, runner.model);
  if (!compacted) return undefined;
  const history = replyHistory({ ...reply, base: withMessage(compacted), baseEvents: 0 });
  return save(host, opened, { ...opened.conversation, history });
}

/** The person's new message, as the host checked it: its blocks, its media, and the kernel's input. */
export type PostedMessage = {
  draft: UserTurnDraft;
  /** The message's blocks (`prepareUserTurn`), with their media inline. */
  blocks: TranscriptBlock[];
  media: UserTurnHistoryMedia;
  /** The kernel input without history: the message's text as the transcript shows it, its media, options, and context. */
  input: TurnInput;
};

/** A file off the wire as the profile's input limits read it. */
function pendingOf(blob: EncodedBlob): PendingAttachment {
  let sizeBytes: number;
  try {
    sizeBytes = base64ToBytes(blob.data).length;
  } catch {
    // invariant: A file that is not base64 is a malformed request; its bytes must not enter diagnostics.
    throw new TheoremError('request', labelText('error.request'), {
      cause: { code: 'request_file_encoding' },
    });
  }
  return { name: blob.name, mimeType: blob.mimeType, sizeBytes, data: blob.data };
}

/**
 * The person's message as the profile accepts it: refused when its files break the profile's
 * limits. `server` is the host's own context for the run (the handler's `context` option).
 */
export function postedMessage(
  iface: ComposerProfileInterface,
  input: TheoremTurnInput,
  server?: unknown,
): PostedMessage {
  const prepared = prepareUserTurn(
    iface.inputs,
    {
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.attachments ? { attachments: input.attachments.map(pendingOf) } : {}),
      ...(input.voice ? { voice: input.voice.map(pendingOf) } : {}),
    },
    iface.guardrails,
  );
  if (!prepared.ok) throw attachmentsRefused(prepared.issues);
  const { text: _sent, ...rest } = input;
  const { text } = prepared.draft;
  return {
    draft: prepared.draft,
    blocks: prepared.blocks,
    media: {
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
    },
    input: kernelTurnInput(text === undefined ? rest : { ...rest, text }, server),
  };
}

/**
 * Refuses a walk-away that does not name exactly the calls the paused reply
 * waits on, by call id and operation; a message to a paused reply must walk away.
 */
function requireWalkAway(
  conversation: StoredConversation,
  abandon: readonly GateReference[] | undefined,
): void {
  const waiting = gatedToolsFromEvents(conversation.paused?.events ?? []);
  if (waiting.length && !abandon) {
    // labels-exempt: internal diagnostic; the user reads the copy key's wording
    throw new TheoremError('request', 'a message to a paused reply must walk away from it', {
      copy: { key: 'session.gate_pending' },
    });
  }
  const named = abandon ?? [];
  if (
    waiting.length !== named.length ||
    !named.every((reference) => waitingOn(conversation, reference))
  ) {
    // labels-exempt: internal diagnostic; the user reads the copy key's wording
    throw new TheoremError(
      'request',
      'the message walks away from calls the reply is not waiting on',
      {
        copy: { key: 'session.gate_expired' },
      },
    );
  }
}

/** Refuses an answer to a call the paused reply is not waiting on, by call id and operation. */
function requireWaitingOn(conversation: StoredConversation, reference: GateReference): void {
  if (waitingOn(conversation, reference)) return;
  throw new TheoremError('request', labelText('session.gate_expired'), {
    copy: { key: 'session.gate_expired' },
  });
}

/**
 * Streams each walked-away call's tool events into the paused reply as it
 * settles; each run's other events stay with that run. Returns the error that
 * ended a run, or undefined once every call settled.
 */
async function* settleWalkedAway(
  paused: Reply,
  calls: readonly WalkedAwayCall[],
): AsyncGenerator<TurnEvent, ErrorEvent | undefined> {
  for (const call of calls) {
    for await (const event of call.events) {
      if (event.type === 'error') return event;
      if (event.type !== 'tool') continue;
      paused.events.push(event);
      yield event;
    }
    if (!paused.events.some((event) => settlesToolCall(event, call.callId))) {
      // labels-exempt: internal diagnostic; the user reads error.internal
      throw new TheoremError('internal', `walked-away call ${call.callId} ended without settling`);
    }
  }
  return undefined;
}

function pausedReply(paused: PausedReply): Reply {
  return {
    base: paused.base,
    events: [...paused.events],
    baseEvents: paused.baseEvents,
    ...(paused.uncompacted ? { uncompacted: paused.uncompacted } : {}),
    workedMs: paused.workedMs,
  };
}

/** A run's error as a failure to throw. */
function failureOf(error: ErrorEvent): TheoremError {
  return new TheoremError(error.errorKind, error.error ?? labelText(`error.${error.errorKind}`));
}

/**
 * The person sends a message. A reply that waits on gates is walked away
 * from first: each call settles cancelled and the paused reply commits; then
 * the message posts and its reply runs.
 */
export async function* messageReply(args: {
  host: ConversationHost;
  opened: OpenedConversation;
  message: PostedMessage;
  /** The paused reply's calls, each with the run that settles it: exactly the calls it waits on. */
  walkAway?: readonly IssuedWalkAway[];
  runner: ReplyRunner;
}): AsyncGenerator<ReplyLine> {
  const { host, message, runner } = args;
  const { events: restored = [], ...stored } = args.opened;
  let opened: OpenedConversation = stored;
  yield* restored;
  const { paused } = opened.conversation;
  requireWalkAway(opened.conversation, args.walkAway);
  if (paused) {
    const walked = pausedReply(paused);
    const error = yield* settleWalkedAway(walked, args.walkAway ?? []);
    if (error) {
      opened = await save(host, opened, {
        ...opened.conversation,
        paused: { ...paused, events: walked.events, endedAt: Date.now() },
      });
      yield* refLine(opened);
      yield error;
      return;
    }
    opened = { ...opened, conversation: committed(host, opened.conversation, walked) };
  }
  const withMessage = (history: TurnHistoryMessage[]) =>
    appendUserDraftToHistory(history, message.draft, message.media);
  let base = opened;
  for (;;) {
    try {
      // why: The message posts before the model runs, so a reply the browser stops still leaves it, in the transcript and the history.
      opened = await save(host, base, {
        ...base.conversation,
        transcript: [...base.conversation.transcript, ...message.blocks],
        history: withMessage(base.conversation.history),
      });
      break;
    } catch (err) {
      const moved = paused ? undefined : await savedSince(host, base, runner, err);
      if (!moved) throw err;
      requireWalkAway(moved.conversation, undefined);
      base = moved;
    }
  }
  const { conversation } = base;
  yield* refLine(opened, 'posted');
  const reply: Reply = {
    base: withMessage(conversation.history),
    events: [],
    baseEvents: 0,
    workedMs: 0,
  };
  yield* runReply(
    host,
    opened,
    reply,
    runner,
    { ...message.input, ...historyInput(conversation) },
    withMessage,
  );
}

/**
 * The conversation as a save that `err` lost to left it, while this reply's hold still has the chat.
 * Undefined when `err` is no such loss, the hold lost the chat, or no newer save is there to read.
 *
 * why: The hold a message took the chat from may land the one save it began first; no save of it follows.
 */
async function savedSince(
  host: ConversationHost,
  opened: OpenedConversation,
  runner: ReplyRunner,
  err: unknown,
): Promise<OpenedConversation | undefined> {
  if (!(err instanceof TheoremError && err.cause === CONFLICT) || opened.ref === null)
    return undefined;
  if (runner.held && !(await runner.held())) return undefined;
  const snapshot = await host.store.read(host.sessionId, opened.ref);
  if (!snapshot || snapshot.revision === opened.revision) return undefined;
  return { ref: opened.ref, revision: snapshot.revision, conversation: snapshot.conversation };
}

/** The conversation's history as a run reads it, with its meters. */
function historyInput(conversation: StoredConversation): TurnInput {
  return {
    history: conversation.history,
    ...(conversation.inputTokens === undefined ? {} : { inputTokens: conversation.inputTokens }),
    ...(conversation.historyTokens === undefined
      ? {}
      : { historyTokens: conversation.historyTokens }),
  };
}

/**
 * The model takes up the results of calls that ended while nothing ran: a reply to no message.
 * It writes nothing until it ends, so a message posted meanwhile keeps the conversation, and this
 * reply ends with no write: that message's reply read the same results.
 */
export async function* wakeReply(args: {
  host: ConversationHost;
  opened: OpenedConversation;
  runner: ReplyRunner;
  /** What the page sends with every message: its option picks and context. */
  input?: Pick<TurnInput, 'options' | 'context'>;
}): AsyncGenerator<ReplyLine> {
  const { host, opened, runner } = args;
  const { conversation } = opened;
  const reply: Reply = { base: conversation.history, events: [], baseEvents: 0, workedMs: 0 };
  try {
    yield* runReply(
      host,
      opened,
      reply,
      runner,
      { ...args.input, ...historyInput(conversation) },
      (history) => history,
    );
  } catch (err) {
    if (!(err instanceof TheoremError && err.cause === CONFLICT)) throw err;
  }
}

/**
 * The person answers one call the reply waits on. `settling` streams the
 * call's events; once no call waits, the reply goes on in the same stream.
 */
export async function* answerReply(args: {
  host: ConversationHost;
  opened: OpenedConversation;
  /** The call answered, as the session issued it. */
  call: GateReference;
  settling: AsyncIterable<TurnEvent>;
  runner: ReplyRunner;
}): AsyncGenerator<ReplyLine> {
  const { host, runner } = args;
  let opened = args.opened;
  requireWaitingOn(opened.conversation, args.call);
  const { paused, ...waiting } = opened.conversation;
  if (!paused) return;
  const reply = pausedReply(paused);
  const startedAt = Date.now();
  let error: ErrorEvent | undefined;
  for await (const event of args.settling) {
    if (event.type === 'error') {
      error = event;
      break;
    }
    reply.events.push(event);
    yield event;
  }
  reply.workedMs += Date.now() - startedAt;
  if (error || gatedToolsFromEvents(reply.events).length) {
    // why: An answer that failed before its call settled leaves the reply as it was, to answer again.
    const settledCall = reply.events.some((event) => settlesToolCall(event, args.call.callId));
    const events = error && !settledCall ? paused.events : reply.events;
    if (runner.held && !(await runner.held())) return;
    opened = await save(host, opened, {
      ...opened.conversation,
      paused: { ...paused, events, workedMs: reply.workedMs, endedAt: Date.now() },
    });
    yield* refLine(opened);
    if (error) yield error;
    return;
  }
  yield* runReply(
    host,
    { ...opened, conversation: waiting },
    reply,
    {
      ...runner,
      model: runner.model ?? paused.model,
      effort: runner.effort ?? paused.effort,
      ...(paused.stated ? { stated: paused.stated } : {}),
      carried: replyCarriedFromEvents(reply.events),
    },
    {
      history: replyHistory(reply),
      ...(waiting.inputTokens === undefined ? {} : { inputTokens: waiting.inputTokens }),
      ...(waiting.historyTokens === undefined ? {} : { historyTokens: waiting.historyTokens }),
    },
    (history) => history,
  );
}

/** Refuses a rewind to a block the transcript does not hold; -1 empties it. */
function requireRewindPoint(conversation: StoredConversation, at: number): void {
  if (Number.isSafeInteger(at) && at >= -1 && at < conversation.transcript.length) return;
  // labels-exempt: internal diagnostic; the user reads error.request
  throw new TheoremError('request', `no transcript block ${at} to rewind to`);
}

/**
 * The conversation cut after transcript block `at` (-1 empties it): the
 * history is rebuilt from what is kept, and the model's checkpoint and meters
 * start over. A paused reply is walked away from first, and commits before the cut.
 */
export async function rewindConversation(args: {
  host: ConversationHost;
  opened: OpenedConversation;
  at: number;
  walkAway?: readonly IssuedWalkAway[];
}): Promise<OpenedConversation> {
  const { host, opened, at } = args;
  let { conversation } = opened;
  requireRewindPoint(conversation, at);
  requireWalkAway(conversation, args.walkAway);
  if (conversation.paused) {
    const walked = pausedReply(conversation.paused);
    const settling = settleWalkedAway(walked, args.walkAway ?? []);
    let step = await settling.next();
    while (!step.done) step = await settling.next();
    if (step.value) throw failureOf(step.value);
    conversation = committed(host, conversation, walked);
  }
  const transcript = conversation.transcript.slice(0, at + 1);
  return save(host, opened, {
    version: 2,
    id: conversation.id,
    transcript,
    history: historyFromTranscriptBlocks(transcript),
  });
}

/** A paused call's operation: every call a session issued carries one. */
export function requiredOperationId(call: { operationId?: string }): string {
  if (!call.operationId) throw new TheoremError('internal', labelText('error.internal'));
  return call.operationId;
}

/** The calls a paused reply waits on: the ones a message or a rewind walks away from. */
export function waitingCalls(conversation: StoredConversation): GateReference[] {
  return gatedToolsFromEvents(conversation.paused?.events ?? []).map((call) => ({
    callId: call.callId,
    operationId: requiredOperationId(call),
  }));
}

/** Refuses what only a kept conversation answers, for a profile that keeps none. */
export function statelessRefusal(what: string): TheoremError {
  // labels-exempt: internal diagnostic; the user reads error.request
  return new TheoremError('request', `a stateless chat keeps no conversation to ${what}`);
}
