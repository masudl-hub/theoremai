/**
 * Runs one reply in a conversation under a hold: the reply reads what the policy lets it read as it
 * opens and at each later moment, and the hold lets the conversation go only once nothing waits
 * that may be told.
 *
 * @module
 */

import type {
  ConversationInbox,
  ConversationRun,
  InboxItem,
  InboxPolicy,
  PolicyMoment,
  ReplyRun,
  ReplyStart,
  TakeAt,
} from './types.ts';

/** Options for {@link runConversation}. */
export interface RunConversationOptions<Item extends InboxItem> {
  conversation: string;
  inbox: ConversationInbox<Item>;
  policy: InboxPolicy<Item>;
  start: ReplyStart;
  /** Makes the ids of replies, and of holds the start does not name. */
  newId: () => string;
  /** How often the hold renews its lease while the reply runs, in milliseconds. */
  renewEveryMs: number;
  /**
   * The reply. Its save marks told what it told, and a paused save keeps what it read: both in the
   * same write as the reply, and only while its hold still has the conversation. Whatever it read
   * and neither told nor kept goes back for a later reply.
   */
  reply: (run: ReplyRun<Item>) => Promise<void>;
  /** Called once with the items the policy gave up, at the moment it gave them up. */
  gaveUp: (items: readonly Item[], moment: PolicyMoment) => Promise<void> | void;
}

/** Runs one reply under a hold of the conversation. See {@link ConversationRun}. */
export async function runConversation<Item extends InboxItem>(
  options: RunConversationOptions<Item>,
): Promise<ConversationRun> {
  const { conversation, inbox, start } = options;
  const hold = start.hold ?? options.newId();
  // why: A follow-up's hold is checked where it acts: handing, giving up, and before `continue`.
  if (start.opening === 'message' && start.takeOver) {
    await inbox.takeOver(conversation, hold);
  } else if (start.opening !== 'follow_up') {
    const opened = await inbox.open(conversation, hold);
    if (opened.outcome === 'held') return opened;
  }

  const lease = new AbortController();
  const renewing = setInterval(() => {
    inbox.renew(conversation, hold).then(
      (kept) => {
        if (!kept) lease.abort();
      },
      () => lease.abort(),
    );
  }, options.renewEveryMs);

  try {
    const failure = await runReply(options, hold, lease.signal);
    const ended = (run: Exclude<ConversationRun, { outcome: 'held' }>): ConversationRun =>
      failure === undefined ? run : { ...run, failure: failure.thrown };
    for (;;) {
      if (lease.signal.aborted) return ended({ outcome: 'lost' });
      const { tell, version } = await choose(options, hold, {
        stage: 'pre_turn',
        step: 0,
        opening: 'follow_up',
      });
      if (tell.length > 0) {
        const kept = await inbox.renew(conversation, hold);
        return ended(kept ? { outcome: 'continue', hold } : { outcome: 'lost' });
      }
      const released = await inbox.release(conversation, hold, version);
      if (released === 'released') return ended({ outcome: 'released' });
      if (released === 'lost') return ended({ outcome: 'lost' });
    }
  } finally {
    clearInterval(renewing);
  }
}

/** Reads the inbox and asks the policy; gives up and reports what it gives up. */
async function choose<Item extends InboxItem>(
  options: RunConversationOptions<Item>,
  hold: string,
  moment: PolicyMoment,
): Promise<{ tell: readonly string[]; version: string }> {
  const { conversation, inbox } = options;
  const { items, version } = await inbox.read(conversation);
  const choice = await options.policy(items, moment);
  if (choice.giveUp !== undefined && choice.giveUp.length > 0) {
    const given = await inbox.giveUp(conversation, hold, choice.giveUp);
    if (given.length > 0) await options.gaveUp(given, moment);
  }
  return { tell: choice.tell, version };
}

/** Runs the reply, gives back what it read and did not tell, and returns what it threw. */
async function runReply<Item extends InboxItem>(
  options: RunConversationOptions<Item>,
  hold: string,
  signal: AbortSignal,
): Promise<{ thrown: unknown } | undefined> {
  const { conversation, inbox, start } = options;
  const reply = options.newId();
  const handed = new Set<string>();
  const kept = (items: readonly Item[]): readonly Item[] => {
    for (const item of items) handed.add(item.id);
    return items;
  };
  const take = async (at: TakeAt): Promise<readonly Item[]> => {
    if (signal.aborted) return [];
    const { tell } = await choose(options, hold, { ...at, opening: start.opening });
    if (tell.length === 0) return [];
    return kept(await inbox.hand(conversation, hold, { reply, ...at }, tell));
  };
  const resume = async (paused: string): Promise<readonly Item[]> =>
    kept(await inbox.resume(conversation, hold, paused, { reply, stage: 'pre_turn', step: 0 }));

  try {
    const opened = await take({ stage: 'pre_turn', step: 0 });
    if (start.opening !== 'message' && opened.length === 0) return undefined;
    await options.reply({ hold, reply, opening: start.opening, opened, take, resume, signal });
    return undefined;
  } catch (thrown) {
    return { thrown };
  } finally {
    // invariant: Told and paused items are past giving back; the rest go back with this handover kept.
    if (handed.size > 0) await inbox.giveBack(conversation, hold, reply, [...handed]);
  }
}
