/**
 * A conversation inbox kept in memory, for tests and single-process apps. It also does the app's
 * own writes (an arrival, a reply's save, and a paused reply's save), which a durable store does
 * in the same write as the item or the reply.
 *
 * @module
 */

import type { ConversationInbox, Handover, InboxItem, InboxRead, Opened } from './types.ts';

/** Options for {@link createMemoryInbox}. */
export interface MemoryInboxOptions {
  /** How long a hold has a conversation after it opens or renews, in milliseconds. */
  leaseMs: number;
  /** The clock, in epoch milliseconds. */
  now?: () => number;
}

/** The in-memory inbox, with the app's writes. */
export interface MemoryInbox<Item extends InboxItem> extends ConversationInbox<Item> {
  /** Saves an item for the conversation, and moves its version. */
  arrive(conversation: string, item: Item): void;
  /**
   * A reply's save: marks `ids` told by `reply`. Only while `hold` still has the conversation and
   * `reply` was handed each id; false, and nothing marked, otherwise.
   */
  settle(conversation: string, hold: string, reply: string, ids: readonly string[]): boolean;
  /**
   * A paused reply's save: keeps `ids` with `reply` until a later reply resumes it, past any
   * lease. Fenced as `settle` is.
   */
  pause(conversation: string, hold: string, reply: string, ids: readonly string[]): boolean;
  /** Each item's state, for tests. */
  states(conversation: string): ReadonlyMap<string, ItemState>;
}

/** Where an item is. */
export type ItemState = 'waiting' | 'handed' | 'paused' | 'told' | 'given_up';

interface Entry<Item> {
  item: Item;
  state: ItemState;
  /** Every handover, the current one last while it is handed. */
  handovers: Handover[];
  /** The hold and reply it is handed to, while handed. */
  holder?: { hold: string; reply: string };
  /** The paused reply it goes back to, from its pause until it is told. */
  pausedWith?: string;
}

interface Conversation<Item> {
  hold?: string;
  leasedUntil: number;
  version: number;
  entries: Map<string, Entry<Item>>;
}

/** Creates an in-memory {@link ConversationInbox}. */
export function createMemoryInbox<Item extends InboxItem>(
  options: MemoryInboxOptions,
): MemoryInbox<Item> {
  const now = options.now ?? Date.now;
  const conversations = new Map<string, Conversation<Item>>();

  const conversationOf = (key: string): Conversation<Item> => {
    const found = conversations.get(key);
    if (found) return found;
    const made: Conversation<Item> = { leasedUntil: 0, version: 0, entries: new Map() };
    conversations.set(key, made);
    return made;
  };
  const has = (c: Conversation<Item>, hold: string): boolean =>
    c.hold === hold && c.leasedUntil > now();
  const heldLive = (c: Conversation<Item>, entry: Entry<Item>): boolean =>
    entry.state === 'handed' && entry.holder !== undefined && has(c, entry.holder.hold);
  /** Handed under a hold that lost the conversation. */
  const lapsed = (c: Conversation<Item>, entry: Entry<Item>): boolean =>
    entry.state === 'handed' && !heldLive(c, entry);
  /** Waiting for any reply: never handed, given back, or lapsed and not a paused reply's. */
  const readable = (c: Conversation<Item>, entry: Entry<Item>): boolean =>
    entry.state === 'waiting' || (lapsed(c, entry) && entry.pausedWith === undefined);
  /** Kept for the paused reply: paused, or resumed under a hold that lost the conversation. */
  const keptFor = (c: Conversation<Item>, entry: Entry<Item>, paused: string): boolean =>
    entry.pausedWith === paused && (entry.state === 'paused' || lapsed(c, entry));
  /** The item as a reply sees it: the handovers before the current one. */
  const view = (entry: Entry<Item>): Item => ({
    ...entry.item,
    handovers: entry.state === 'handed' ? entry.handovers.slice(0, -1) : [...entry.handovers],
  });
  const handedTo = (entry: Entry<Item> | undefined, hold: string, reply: string): boolean =>
    entry?.state === 'handed' && entry.holder?.hold === hold && entry.holder.reply === reply;
  const handTo = (entry: Entry<Item>, hold: string, handover: Omit<Handover, 'hold' | 'at'>) => {
    entry.state = 'handed';
    entry.holder = { hold, reply: handover.reply };
    entry.handovers.push({ ...handover, hold, at: now() });
  };
  const mark = (
    c: Conversation<Item>,
    hold: string,
    reply: string,
    ids: readonly string[],
    state: 'told' | 'paused',
  ): boolean => {
    if (!has(c, hold)) return false;
    if (!ids.every((id) => handedTo(c.entries.get(id), hold, reply))) return false;
    for (const id of ids) {
      const entry = c.entries.get(id);
      if (!entry) continue;
      entry.state = state;
      entry.holder = undefined;
      entry.pausedWith = state === 'paused' ? reply : undefined;
    }
    return true;
  };

  return {
    open(conversation: string, hold: string): Promise<Opened> {
      const c = conversationOf(conversation);
      if (c.hold !== undefined && c.hold !== hold && c.leasedUntil > now()) {
        return Promise.resolve({ outcome: 'held', leasedUntil: c.leasedUntil });
      }
      c.hold = hold;
      c.leasedUntil = now() + options.leaseMs;
      return Promise.resolve({ outcome: 'opened' });
    },
    takeOver(conversation: string, hold: string): Promise<void> {
      const c = conversationOf(conversation);
      c.hold = hold;
      c.leasedUntil = now() + options.leaseMs;
      return Promise.resolve();
    },
    renew(conversation: string, hold: string): Promise<boolean> {
      const c = conversationOf(conversation);
      if (!has(c, hold)) return Promise.resolve(false);
      c.leasedUntil = now() + options.leaseMs;
      return Promise.resolve(true);
    },
    read(conversation: string): Promise<InboxRead<Item>> {
      const c = conversationOf(conversation);
      const items = [...c.entries.values()].filter((entry) => readable(c, entry)).map(view);
      return Promise.resolve({ items, version: String(c.version) });
    },
    hand(conversation, hold, handover, ids): Promise<readonly Item[]> {
      const c = conversationOf(conversation);
      if (!has(c, hold)) return Promise.resolve([]);
      const handed: Item[] = [];
      for (const id of ids) {
        const entry = c.entries.get(id);
        if (!entry || !readable(c, entry)) continue;
        handTo(entry, hold, handover);
        handed.push(view(entry));
      }
      return Promise.resolve(handed);
    },
    giveBack(conversation, hold, reply, ids): Promise<void> {
      const c = conversationOf(conversation);
      for (const id of ids) {
        const entry = c.entries.get(id);
        if (!entry || !handedTo(entry, hold, reply)) continue;
        entry.state = entry.pausedWith === undefined ? 'waiting' : 'paused';
        entry.holder = undefined;
      }
      return Promise.resolve();
    },
    resume(conversation, hold, paused, handover): Promise<readonly Item[]> {
      const c = conversationOf(conversation);
      if (!has(c, hold)) return Promise.resolve([]);
      const resumed: Item[] = [];
      for (const entry of c.entries.values()) {
        if (!keptFor(c, entry, paused)) continue;
        handTo(entry, hold, handover);
        resumed.push(view(entry));
      }
      return Promise.resolve(resumed);
    },
    giveUp(conversation, hold, ids): Promise<readonly Item[]> {
      const c = conversationOf(conversation);
      if (!has(c, hold)) return Promise.resolve([]);
      const given: Item[] = [];
      for (const id of ids) {
        const entry = c.entries.get(id);
        if (!entry || !readable(c, entry)) continue;
        entry.state = 'given_up';
        entry.holder = undefined;
        given.push(view(entry));
      }
      return Promise.resolve(given);
    },
    release(conversation, hold, version) {
      const c = conversationOf(conversation);
      if (c.hold !== hold) return Promise.resolve('lost');
      if (String(c.version) !== version) return Promise.resolve('moved');
      c.hold = undefined;
      c.leasedUntil = 0;
      return Promise.resolve('released');
    },
    arrive(conversation, item) {
      const c = conversationOf(conversation);
      c.entries.set(item.id, { item, state: 'waiting', handovers: [...item.handovers] });
      c.version += 1;
    },
    settle: (conversation, hold, reply, ids) =>
      mark(conversationOf(conversation), hold, reply, ids, 'told'),
    pause: (conversation, hold, reply, ids) =>
      mark(conversationOf(conversation), hold, reply, ids, 'paused'),
    states(conversation) {
      const c = conversationOf(conversation);
      return new Map([...c.entries].map(([id, entry]) => [id, entry.state]));
    },
  };
}
