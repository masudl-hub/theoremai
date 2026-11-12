/**
 * The conversation layer's contract: what an app's storage gives the runner, and what the runner
 * gives the app's reply. One holder at a time reads a conversation's inbox; an item reaches the
 * model only through the holder, and is told once the reply that read it is saved.
 *
 * @module
 */

import type { TurnInjectStage } from '../kernel/schema.ts';

/** A reply an item was handed to, which did not tell it. */
export interface Handover {
  /** The hold the reply ran under. One hold can run several replies. */
  hold: string;
  /** The reply it was handed to. */
  reply: string;
  stage: TurnInjectStage;
  /** The model steps the reply had taken when it was handed; 0 as it opened. */
  step: number;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * Something saved for a conversation that no saved reply has told: a call's late result, a due
 * reminder, a fact from outside. The app names the kinds.
 */
export interface InboxItem<Kind extends string = string> {
  id: string;
  kind: Kind;
  /**
   * Each reply it was handed to that ended without telling it, oldest first. A reply that reads it
   * again can say what came of those earlier ones.
   */
  handovers: readonly Handover[];
}

/** What `open` finds: the conversation is now this hold's, or another hold has it until then. */
export type Opened = { outcome: 'opened' } | { outcome: 'held'; leasedUntil: number };

/** The items `read` returns, and the inbox's version as it read them. */
export interface InboxRead<Item extends InboxItem> {
  items: readonly Item[];
  /** Moves each time an item arrives. `release` compares it. */
  version: string;
}

/** Where a reply takes items: the moment, and the reply's step. */
export interface TakeAt {
  stage: TurnInjectStage;
  step: number;
}

/**
 * The app's storage for its conversations: one lock and one inbox each. An item arrives through the
 * app's own write, which moves the version. The reply's own save marks the items it told, in the
 * same write as the reply, and only while its hold still has the conversation.
 */
export interface ConversationInbox<Item extends InboxItem = InboxItem> {
  /** Takes the conversation for `hold`, on a lease, or says until when another hold has it. */
  open(conversation: string, hold: string): Promise<Opened>;
  /**
   * Takes the conversation for `hold` from any hold that has it, as a person's message does. The
   * hold that had it can no longer renew, hand, or save, and what it was handed waits again.
   */
  takeOver(conversation: string, hold: string): Promise<void>;
  /** Extends `hold`'s lease. False when the hold no longer has the conversation. */
  renew(conversation: string, hold: string): Promise<boolean>;
  /**
   * The untold items no live hold has: those never handed, those given back, and those handed
   * under a hold whose lease ran out. Items a paused reply holds are not among them.
   */
  read(conversation: string): Promise<InboxRead<Item>>;
  /**
   * Hands `ids` to `reply` under `hold`, and returns the items it handed. Only the hold that has
   * the conversation can hand. The version does not move.
   */
  hand(
    conversation: string,
    hold: string,
    handover: Omit<Handover, 'hold' | 'at'>,
    ids: readonly string[],
  ): Promise<readonly Item[]>;
  /**
   * Gives back the items `reply` read and did not tell, because it ended unsaved: an item it
   * resumed goes back to the reply that paused with it, and the rest wait for a later reply. Each
   * keeps the handover, so a later reply knows. The version does not move.
   */
  giveBack(
    conversation: string,
    hold: string,
    reply: string,
    ids: readonly string[],
  ): Promise<void>;
  /**
   * Hands what a paused reply kept to `handover.reply`, as it goes on, and returns those items.
   * Only the hold that has the conversation can resume.
   */
  resume(
    conversation: string,
    hold: string,
    paused: string,
    handover: Omit<Handover, 'hold' | 'at'>,
  ): Promise<readonly Item[]>;
  /**
   * Gives up the items among `ids` that no live hold has: no reply reads them again. Returns
   * those it gave up. Only the hold that has the conversation can give up.
   */
  giveUp(conversation: string, hold: string, ids: readonly string[]): Promise<readonly Item[]>;
  /**
   * Lets the conversation go, only while the inbox is still at `version`. `moved` when an item
   * arrived since: `hold` keeps the conversation and reads again. `lost` when `hold` no longer
   * has it.
   */
  release(
    conversation: string,
    hold: string,
    version: string,
  ): Promise<'released' | 'moved' | 'lost'>;
}

/**
 * What opens a reply. A `message` or a `wake` opens the conversation under a new hold; a message
 * with `takeOver` takes it from any hold that has it. A `follow_up` runs under the hold a run
 * before it returned with `continue`.
 */
export type ReplyStart =
  | { opening: 'message'; takeOver?: boolean }
  | { opening: 'wake' }
  | { opening: 'follow_up'; hold: string };

/** When the policy is asked: the moment, and what opened the reply. */
export interface PolicyMoment extends TakeAt {
  /**
   * `message` for a reply to the person's message, `wake` for a reply to no message, and
   * `follow_up` at the end of a hold's reply, for items that arrived while it ran.
   */
  opening: 'message' | 'wake' | 'follow_up';
}

/**
 * What the policy chose among the items: those the model reads now, and those no reply will read.
 * The rest stay for later.
 */
export interface PolicyChoice {
  tell: readonly string[];
  /** Items to give up, such as one a reply failed on too many times. They are reported once. */
  giveUp?: readonly string[];
}

/**
 * The app's rule for what may be told now. It must change nothing: the runner asks it again at
 * each moment.
 */
export type InboxPolicy<Item extends InboxItem = InboxItem> = (
  items: readonly Item[],
  moment: PolicyMoment,
) => PolicyChoice | Promise<PolicyChoice>;

/** One reply under a hold, as the runner gives it to the app. */
export interface ReplyRun<Item extends InboxItem = InboxItem> {
  hold: string;
  reply: string;
  opening: PolicyMoment['opening'];
  /** The items the reply reads as it opens. */
  opened: readonly Item[];
  /** The items the reply reads at this later moment, handed to it as they are returned. */
  take(at: TakeAt): Promise<readonly Item[]>;
  /**
   * What the paused reply kept, handed to this reply as it goes on. If this reply ends without
   * telling them, they go back to the paused reply.
   */
  resume(paused: string): Promise<readonly Item[]>;
  /** Aborts once the hold no longer has the conversation: the reply must not save. */
  signal: AbortSignal;
}

/**
 * What one run of a conversation ended with. `held`: another hold has it, and tells what waits.
 * `released`: nothing waits that may be told now. `continue`: items wait that may be told now, and
 * the hold keeps the conversation for the caller's next reply. `lost`: the hold no longer has the
 * conversation, so another hold tells what waits. `failure` is what the reply threw: its items were given
 * back, and the caller reports it.
 */
export type ConversationRun =
  | { outcome: 'held'; leasedUntil: number }
  | { outcome: 'released'; failure?: unknown }
  | { outcome: 'continue'; hold: string; failure?: unknown }
  | { outcome: 'lost'; failure?: unknown };
