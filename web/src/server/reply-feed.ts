/**
 * Where the lines of a running reply go, so every page open on the conversation can draw it live,
 * whichever request, server or process runs the reply. A page that follows reads the same lines
 * the page that started the reply reads.
 *
 * @module
 */

import type { ReplyLine } from './conversation.ts';

/** What a follower is told, in order. */
export type ReplyFeedListener = {
  /** One line of the reply. */
  line(line: ReplyLine): void;
  /** The reply is over, or none runs: the follower reads the saved conversation. */
  end(): void;
};

/**
 * Keyed by the conversation's id, which stays the same across every write; a store's ref does not.
 * `reply` names one reply on that conversation, so the end of an old reply never ends a new one.
 * The default lives in process memory, which reaches only followers connected to the process that
 * runs the reply. Bring a shared one (Redis streams, a Durable Object) for several instances.
 *
 * A reply's lines are plain JSON: the events `createTheoremHandler` streams, as they leave the
 * kernel. Keep them as long as `reply` runs, and what your host decides beyond that (a cap, an
 * expiry, a dead server's reply) is yours.
 */
export interface TheoremReplyFeed {
  /** A reply began on `conversation`. Drop the lines of any earlier reply on it. */
  start(conversation: string, reply: string): void | Promise<void>;
  /** The next line of `reply`, in order. */
  append(conversation: string, reply: string, line: ReplyLine): void | Promise<void>;
  /** `reply` is over. Tell each follower `end`, and keep nothing of it. */
  end(conversation: string, reply: string): void | Promise<void>;
  /**
   * Tells `listener` each line of the reply that runs on `conversation` now, from its first and in
   * order, then each new line as it comes, then `end`. When no reply runs, tells `end` at once.
   * Returns the function that stops the listening.
   */
  follow(conversation: string, listener: ReplyFeedListener): (() => void) | Promise<() => void>;
}

type LiveReply = { reply: string; lines: ReplyLine[]; listeners: Set<ReplyFeedListener> };

/** A feed in process memory. It keeps every line of a running reply until it ends, and sets no limit. */
export function createMemoryReplyFeed(): TheoremReplyFeed {
  const live = new Map<string, LiveReply>();
  return {
    start(conversation, reply) {
      const earlier = live.get(conversation);
      live.set(conversation, { reply, lines: [], listeners: new Set() });
      for (const listener of earlier?.listeners ?? []) listener.end();
    },
    append(conversation, reply, line) {
      const current = live.get(conversation);
      if (current?.reply !== reply) return;
      current.lines.push(line);
      for (const listener of [...current.listeners]) listener.line(line);
    },
    end(conversation, reply) {
      const current = live.get(conversation);
      if (current?.reply !== reply) return;
      live.delete(conversation);
      for (const listener of [...current.listeners]) listener.end();
    },
    follow(conversation, listener) {
      const current = live.get(conversation);
      if (!current) {
        listener.end();
        return () => {};
      }
      for (const line of [...current.lines]) listener.line(line);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    },
  };
}
