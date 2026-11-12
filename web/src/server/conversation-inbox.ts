/**
 * The handler's conversation inbox: each chat's late results, kept in the session store. An item
 * is a detached call that ended; the transcript says whether a saved reply told it, and the
 * session keeps who holds the chat and which replies were handed what.
 *
 * @module
 */

import {
  type LateResultItem,
  labelText,
  type Profile,
  type ToolOperationOutcome,
} from '@theoremjs/agents';
import type { ConversationInbox, Handover, InboxRead } from '@theoremjs/agents/conversation';
import type { StoredConversation } from './conversation-store.ts';
import type { MutableStore } from './session-authority.ts';
import type {
  SessionConversationInbox,
  SessionInboxEntry,
  SessionToolOperation,
  TheoremSessionState,
} from './session-store.ts';

/** A background call that ended, as the session keeps it. */
export type SettledOperation = Extract<SessionToolOperation, { status: 'settled' }>;

/** A detached call as its chat's transcript keeps it: what an end is told about. */
export type DetachedCall = { operationId: string; callId: string; name: string; at: number };

/**
 * What became of a detached call, as the model and the page read it: the end the session saved, or
 * that it is unresolved when the session holds no end (the call was cut off, or its saved end was
 * dropped). Undefined while it runs.
 */
export function detachedEnd(
  call: DetachedCall,
  operation: SessionToolOperation | undefined,
  labels: Profile['labels'],
): ToolOperationOutcome | undefined {
  if (operation?.status === 'settled') return operation.outcome;
  if (operation !== undefined && operation.status !== 'uncertain') return undefined;
  const message = labelText('tool.execution_uncertain', {}, labels);
  const failure = {
    code: operation ? operation.reason : 'outcome_not_retained',
    kind: 'internal',
    message,
  } as const;
  const { operationId, callId, name } = call;
  const at = operation ? operation.detectedAt : call.at;
  return {
    event: {
      type: 'tool',
      tool: { name, callId, operationId, at, phase: 'error', failure, readBack: message },
    },
    effects: 'unknown',
    replay: { failure },
  };
}

/** Options for {@link sessionConversationInbox}. */
export type SessionConversationInboxOptions = {
  sessions: MutableStore<TheoremSessionState>;
  sessionId: string;
  /** How long a hold has a chat after it opens or renews, in milliseconds. */
  leaseMs: number;
  /** The chat as its last save left it, by its id; undefined when the store no longer has it. */
  conversation: (key: string) => Promise<StoredConversation | undefined>;
  /** Whether this request may read the call's result: the handler's `authorizeToolReplay`. */
  readable: (operation: SettledOperation) => Promise<boolean>;
  /** The profile's labels, for the words of an end the session does not hold. */
  labels: Profile['labels'];
  now?: () => number;
};

/** The operation ids a chat's saved replies told, those its paused reply holds, and its untold calls. */
function transcriptState(conversation: StoredConversation | undefined) {
  const told = new Set<string>();
  const detached: DetachedCall[] = [];
  for (const block of conversation?.transcript ?? []) {
    if (block.kind === 'late-results') for (const id of block.operationIds) told.add(id);
    const { tool } = block.kind === 'tool' ? block : { tool: undefined };
    if (tool?.state?.phase === 'background' && tool.operationId) {
      const { operationId, callId, name } = tool;
      detached.push({ operationId, callId, name, at: tool.state.at });
    }
  }
  const paused = new Set<string>();
  const draft: DetachedCall[] = [];
  for (const event of conversation?.paused?.events ?? []) {
    if (event.type === 'late_results') for (const id of event.operationIds) paused.add(id);
    const tool = event.type === 'tool' ? event.tool : undefined;
    if (tool?.phase === 'background' && tool.operationId) {
      const { operationId, callId, name, at } = tool;
      draft.push({ operationId, callId, name, at });
    }
  }
  return {
    told,
    paused,
    pausedReply: conversation?.paused?.reply,
    untold: detached.filter((call) => !told.has(call.operationId)),
    /** The calls the paused reply read, wherever it detached them. */
    kept: [...detached, ...draft].filter((call) => paused.has(call.operationId)),
  };
}

function operationOf(state: TheoremSessionState, id: string): SessionToolOperation | undefined {
  return Object.hasOwn(state.operations, id) ? state.operations[id] : undefined;
}

/** Creates the {@link ConversationInbox} of one session's chats, keyed by `StoredConversation.id`. */
export function sessionConversationInbox(
  options: SessionConversationInboxOptions,
): ConversationInbox<LateResultItem> {
  const { sessions, sessionId, leaseMs } = options;
  const now = options.now ?? Date.now;

  const inboxOf = (state: TheoremSessionState, key: string): SessionConversationInbox => {
    state.inbox ??= { version: 0, conversations: {} };
    const conversations = state.inbox.conversations;
    if (!Object.hasOwn(conversations, key)) conversations[key] = { leasedUntil: 0, entries: {} };
    return conversations[key];
  };
  const has = (inbox: SessionConversationInbox, hold: string, at: number): boolean =>
    inbox.hold === hold && inbox.leasedUntil > at;
  /** Handed to a reply whose hold still has the chat. */
  const heldLive = (inbox: SessionConversationInbox, entry: SessionInboxEntry, at: number) =>
    entry.handed !== undefined && has(inbox, entry.handed.hold, at);
  const entryOf = (inbox: SessionConversationInbox, id: string): SessionInboxEntry => {
    if (!Object.hasOwn(inbox.entries, id)) inbox.entries[id] = { handovers: [] };
    return inbox.entries[id];
  };
  const item = (
    id: string,
    outcome: ToolOperationOutcome,
    entry: SessionInboxEntry | undefined,
  ): LateResultItem => ({
    id,
    kind: 'late_result',
    handovers: [...(entry?.handovers ?? [])],
    outcome,
  });
  /** The call's end; undefined while it runs. */
  const endOf = (state: TheoremSessionState, call: DetachedCall) =>
    detachedEnd(call, operationOf(state, call.operationId), options.labels);
  const handTo = (
    entry: SessionInboxEntry,
    hold: string,
    handover: Omit<Handover, 'hold' | 'at'>,
    at: number,
  ) => {
    // invariant: A reply that lost its hold never gave its item back: what it was handed counts as a handover.
    if (entry.handed) entry.handovers.push(entry.handed);
    entry.handed = { ...handover, hold, at };
  };
  /** The chat's untold calls that no paused reply keeps. */
  const untoldCalls = async (key: string) => {
    const conversation = await options.conversation(key);
    const chat = transcriptState(conversation);
    return { chat, calls: chat.untold.filter((call) => !chat.paused.has(call.operationId)) };
  };
  /** The call's end, while it waits for a reply: ended, not given up, and no live hold has it. */
  const waiting = (
    inbox: SessionConversationInbox,
    state: TheoremSessionState,
    call: DetachedCall,
    at: number,
  ): ToolOperationOutcome | undefined => {
    const id = call.operationId;
    const entry = Object.hasOwn(inbox.entries, id) ? inbox.entries[id] : undefined;
    if (entry?.givenUp || (entry && heldLive(inbox, entry, at))) return undefined;
    return endOf(state, call);
  };
  /** Whether this request may read the end: a saved result only as the host allows; an unresolved end always. */
  const readable = (state: TheoremSessionState, id: string) => {
    const operation = operationOf(state, id);
    return operation?.status === 'settled' ? options.readable(operation) : Promise.resolve(true);
  };

  /** Changes one chat's lock and entries in one session write. */
  const change = <T>(
    key: string,
    apply: (inbox: SessionConversationInbox, state: TheoremSessionState, at: number) => T,
  ) => sessions.mutate(sessionId, (state) => apply(inboxOf(state, key), state, now()));
  /** Acts on each of `ids` that waits, only while `hold` has the chat; returns those it acted on. */
  const actOnWaiting = async (
    key: string,
    hold: string,
    ids: readonly string[],
    act: (entry: SessionInboxEntry, at: number) => void,
  ) => {
    const { calls } = await untoldCalls(key);
    const wanted = calls.filter((call) => ids.includes(call.operationId));
    return change(key, (inbox, state, at) => {
      if (!has(inbox, hold, at)) return [];
      return wanted.flatMap((call) => {
        const outcome = waiting(inbox, state, call, at);
        if (!outcome) return [];
        const entry = entryOf(inbox, call.operationId);
        act(entry, at);
        return [item(call.operationId, outcome, entry)];
      });
    });
  };
  const lease = (inbox: SessionConversationInbox, hold: string, at: number) => {
    inbox.hold = hold;
    inbox.leasedUntil = at + leaseMs;
  };

  return {
    open(key, hold) {
      return change(key, (inbox, _state, at) => {
        if (inbox.hold !== undefined && inbox.hold !== hold && inbox.leasedUntil > at) {
          return { outcome: 'held' as const, leasedUntil: inbox.leasedUntil };
        }
        lease(inbox, hold, at);
        return { outcome: 'opened' as const };
      });
    },
    takeOver(key, hold) {
      return change(key, (inbox, _state, at) => lease(inbox, hold, at));
    },
    renew(key, hold) {
      return change(key, (inbox, _state, at) => {
        if (!has(inbox, hold, at)) return false;
        lease(inbox, hold, at);
        return true;
      });
    },
    async read(key): Promise<InboxRead<LateResultItem>> {
      const { calls } = await untoldCalls(key);
      const state = await sessions.read(sessionId);
      const inbox = state.inbox?.conversations[key] ?? { leasedUntil: 0, entries: {} };
      const at = now();
      const items: LateResultItem[] = [];
      for (const call of calls) {
        const id = call.operationId;
        const outcome = waiting(inbox, state, call, at);
        if (outcome && (await readable(state, id)))
          items.push(item(id, outcome, inbox.entries[id]));
      }
      return { items, version: String(state.inbox?.version ?? 0) };
    },
    hand(key, hold, handover, ids) {
      return actOnWaiting(key, hold, ids, (entry, at) => handTo(entry, hold, handover, at));
    },
    async giveBack(key, hold, reply, ids) {
      const { chat } = await untoldCalls(key);
      await change(key, (inbox) => {
        for (const id of ids) {
          const entry = Object.hasOwn(inbox.entries, id) ? inbox.entries[id] : undefined;
          if (entry?.handed?.hold !== hold || entry.handed.reply !== reply) continue;
          if (chat.told.has(id)) {
            delete inbox.entries[id];
            continue;
          }
          entry.handovers.push(entry.handed);
          delete entry.handed;
        }
      });
    },
    async resume(key, hold, paused, handover) {
      const { chat } = await untoldCalls(key);
      if (chat.pausedReply !== paused) return [];
      return change(key, (inbox, state, at) => {
        if (!has(inbox, hold, at)) return [];
        return chat.kept.flatMap((call) => {
          const outcome = endOf(state, call);
          const entry = entryOf(inbox, call.operationId);
          if (!outcome || heldLive(inbox, entry, at)) return [];
          handTo(entry, hold, handover, at);
          return [item(call.operationId, outcome, entry)];
        });
      });
    },
    giveUp(key, hold, ids) {
      return actOnWaiting(key, hold, ids, (entry) => {
        if (entry.handed) entry.handovers.push(entry.handed);
        delete entry.handed;
        entry.givenUp = true;
      });
    },
    release(key, hold, version) {
      return change(key, (inbox, state) => {
        if (inbox.hold !== hold) return 'lost' as const;
        if (String(state.inbox?.version ?? 0) !== version) return 'moved' as const;
        delete inbox.hold;
        inbox.leasedUntil = 0;
        return 'released' as const;
      });
    },
  };
}
