/**
 * The handler's conversation inbox: each chat's late results, kept in the session store. An item
 * is a detached call that ended; the transcript says whether a saved reply told it, and the
 * session keeps who holds the chat and which replies were handed what.
 *
 * @module
 */

import type { LateResultItem } from '@theoremjs/agents';
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
  now?: () => number;
};

/** The operation ids a chat's saved replies told, and those its paused reply holds. */
function transcriptState(conversation: StoredConversation | undefined) {
  const told = new Set<string>();
  const detached: string[] = [];
  for (const block of conversation?.transcript ?? []) {
    if (block.kind === 'late-results') for (const id of block.operationIds) told.add(id);
    if (block.kind === 'tool' && block.tool.state?.phase === 'background' && block.tool.operationId)
      detached.push(block.tool.operationId);
  }
  const paused = new Set<string>();
  for (const event of conversation?.paused?.events ?? []) {
    if (event.type === 'late_results') for (const id of event.operationIds) paused.add(id);
  }
  return {
    told,
    paused,
    pausedReply: conversation?.paused?.reply,
    untold: detached.filter((id) => !told.has(id)),
  };
}

function settledOperation(state: TheoremSessionState, id: string): SettledOperation | undefined {
  const operation = Object.hasOwn(state.operations, id) ? state.operations[id] : undefined;
  return operation?.status === 'settled' ? operation : undefined;
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
  const item = (operation: SettledOperation, entry: SessionInboxEntry | undefined) => ({
    id: operation.operationId,
    kind: 'late_result' as const,
    handovers: [...(entry?.handovers ?? [])],
    outcome: operation.outcome,
  });
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
  /** The untold results no live hold has and no paused reply keeps, as this request may read them. */
  const readableIds = async (key: string) => {
    const conversation = await options.conversation(key);
    const chat = transcriptState(conversation);
    return { chat, ids: chat.untold.filter((id) => !chat.paused.has(id)) };
  };
  const waiting = (
    inbox: SessionConversationInbox,
    state: TheoremSessionState,
    id: string,
    at: number,
  ): SettledOperation | undefined => {
    const operation = settledOperation(state, id);
    if (!operation) return undefined;
    const entry = Object.hasOwn(inbox.entries, id) ? inbox.entries[id] : undefined;
    if (entry?.givenUp || (entry && heldLive(inbox, entry, at))) return undefined;
    return operation;
  };
  const authorized = async (operations: readonly SettledOperation[]) => {
    const kept: SettledOperation[] = [];
    for (const operation of operations) if (await options.readable(operation)) kept.push(operation);
    return kept;
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
    const { ids: open } = await readableIds(key);
    const wanted = ids.filter((id) => open.includes(id));
    return change(key, (inbox, state, at) => {
      if (!has(inbox, hold, at)) return [];
      return wanted.flatMap((id) => {
        const operation = waiting(inbox, state, id, at);
        if (!operation) return [];
        const entry = entryOf(inbox, id);
        act(entry, at);
        return [item(operation, entry)];
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
      const { ids } = await readableIds(key);
      const state = await sessions.read(sessionId);
      const inbox = state.inbox?.conversations[key] ?? { leasedUntil: 0, entries: {} };
      const at = now();
      const found = ids.flatMap((id) => {
        const operation = waiting(inbox, state, id, at);
        return operation ? [operation] : [];
      });
      const items = (await authorized(found)).map((operation) =>
        item(operation, inbox.entries[operation.operationId]),
      );
      return { items, version: String(state.inbox?.version ?? 0) };
    },
    hand(key, hold, handover, ids) {
      return actOnWaiting(key, hold, ids, (entry, at) => handTo(entry, hold, handover, at));
    },
    async giveBack(key, hold, reply, ids) {
      const { chat } = await readableIds(key);
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
      const { chat } = await readableIds(key);
      if (chat.pausedReply !== paused) return [];
      return change(key, (inbox, state, at) => {
        if (!has(inbox, hold, at)) return [];
        return [...chat.paused].flatMap((id) => {
          const operation = settledOperation(state, id);
          const entry = entryOf(inbox, id);
          if (!operation || heldLive(inbox, entry, at)) return [];
          handTo(entry, hold, handover, at);
          return [item(operation, entry)];
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
