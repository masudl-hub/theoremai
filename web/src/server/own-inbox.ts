/**
 * Theorem's own conversation inbox, for the replies that hold no app `inbox`. A message the person
 * sends while a reply runs is an item in it, beside the session's ended background calls. The
 * reply takes one message at each `pre_turn`, `post_tool` and `before_end`, and a save of the
 * reply that landed it tells it once. A stop reaches the reply that holds the conversation.
 *
 * The inbox is named by the chat's conversation. A chat that keeps no conversation (`'stateless'`)
 * is named by its run: the `turnId` the page sent. Both live in process memory, so a steer and the
 * reply it joins must reach the same process.
 *
 * @module
 */

import {
  isTurnInjectStage,
  type LateResultItem,
  type LateResultsDecider,
  type LateResultsSource,
  messageParts,
  type RefText,
  type StageHandler,
  TheoremError,
  type TurnHistoryMessage,
  textOfParts,
  type UserPart,
} from '@theoremjs/agents';
import {
  createMemoryInbox,
  type InboxItem,
  type InboxPolicy,
  type MemoryInbox,
  type ReplyRun,
  type TakeAt,
} from '@theoremjs/agents/conversation';
import { appendUserDraftToHistory } from '@theoremjs/agents/interface';
import type { TheoremSteerRequest } from '../client/transport.ts';
import type { HoldStop } from './conversation-core.ts';

/** A message the person sent into a running reply, as the one user message the model reads. */
export interface PersonMessage extends InboxItem<'person_message'> {
  messages: TurnHistoryMessage[];
  /** The message's words and refs, when it names the host's objects (`StageInject.userParts`). */
  userParts?: UserPart[];
}

/** What Theorem's own inbox holds: ended background calls and the person's messages. */
export type OwnItem = LateResultItem | PersonMessage;

/** Whether `item` is a person's message. */
function isPersonMessage(item: OwnItem): item is PersonMessage {
  return item.kind === 'person_message';
}

/**
 * A steer as a client posts it (a checked `TheoremSteerRequest`) as an inbox item: its id is the
 * client's, and a reply names it in `stage.injected` once it lands. A message with no text and no
 * file is refused.
 */
export function personMessageOf(
  steer: Pick<TheoremSteerRequest, 'id' | 'input'>,
  refText?: RefText,
): PersonMessage {
  const { attachments, voice } = steer.input;
  const userParts = messageParts(steer.input.parts);
  const text = steer.input.parts
    ? textOfParts(userParts ?? steer.input.parts, refText)
    : steer.input.text;
  const messages = appendUserDraftToHistory(
    [],
    { ...(text === undefined ? {} : { text }) },
    { ...(attachments ? { attachments } : {}), ...(voice ? { voice } : {}) },
  );
  // labels-exempt: internal diagnostic; the user reads the error kind's (or copy key's) wording
  if (!messages.length) throw new TheoremError('request', 'a steer needs text or a file');
  return {
    id: steer.id,
    kind: 'person_message',
    handovers: [],
    messages,
    ...(userParts ? { userParts } : {}),
  };
}

/** The person's messages the session inbox keeps in memory, by session and conversation. */
export type MessageShelf = Map<string, Map<string, PersonMessage>>;

/** The stop of replies run by this process, which Theorem's own inbox uses when the app gives none. */
export type MemoryHoldStop = HoldStop & {
  /** Whether a model run of a reply holding `conversation` is running now. */
  running(conversation: string): boolean;
};

type RunningHold = { stopped: boolean; settle: Set<(stopped: boolean) => void> };

/** Creates the memory stop. A stop asked reaches every model run of the conversation under way. */
function createMemoryHoldStop(): MemoryHoldStop {
  const holds = new Map<string, Map<string, RunningHold>>();
  const holdOf = (conversation: string, hold: string): RunningHold => {
    const byHold = holds.get(conversation) ?? new Map<string, RunningHold>();
    holds.set(conversation, byHold);
    const running = byHold.get(hold) ?? { stopped: false, settle: new Set() };
    byHold.set(hold, running);
    return running;
  };
  const drop = (conversation: string, hold: string) => {
    const byHold = holds.get(conversation);
    byHold?.delete(hold);
    if (byHold?.size === 0) holds.delete(conversation);
  };
  return {
    running: (conversation) => (holds.get(conversation)?.size ?? 0) > 0,
    ask(conversation) {
      const byHold = holds.get(conversation);
      if (!byHold?.size) return Promise.resolve(false);
      for (const running of byHold.values()) {
        running.stopped = true;
        for (const settle of running.settle) settle(true);
        running.settle.clear();
      }
      return Promise.resolve(true);
    },
    stopped(conversation, hold, over) {
      const running = holdOf(conversation, hold);
      if (running.stopped) return Promise.resolve(true);
      return new Promise((resolve) => {
        running.settle.add(resolve);
        over.addEventListener(
          'abort',
          () => {
            running.settle.delete(resolve);
            resolve(false);
          },
          { once: true },
        );
      });
    },
    clear(conversation, hold) {
      const running = holds.get(conversation)?.get(hold);
      for (const settle of running?.settle ?? []) settle(false);
      drop(conversation, hold);
      return Promise.resolve();
    },
  };
}

/** What every request of one handler shares: the memory the own inbox keeps. */
export type OwnInbox = {
  /** The messages a stored chat's session inbox tells beside the decider's late results. */
  shelf: MessageShelf;
  /** The inbox of each run of a chat that keeps no conversation, by session and `turnId`, while it runs. */
  runs: Map<string, MemoryInbox<OwnItem>>;
  /** The conversation each running reply of a stored chat holds, by session and the page's `turnId`. */
  turns: Map<string, string>;
  stop: MemoryHoldStop;
};

/** Creates the memory one handler's replies share. */
export function createOwnInbox(): OwnInbox {
  return { shelf: new Map(), runs: new Map(), turns: new Map(), stop: createMemoryHoldStop() };
}

/** A stop whose names are scoped, so no scope reaches another's reply. */
export function scopedStop(stop: HoldStop, scope: string): HoldStop {
  return {
    ask: (name) => stop.ask(ownKey(scope, name)),
    stopped: (name, hold, over) => stop.stopped(ownKey(scope, name), hold, over),
    clear: (name, hold) => stop.clear(ownKey(scope, name), hold),
  };
}

/** The inbox of one run of a chat that keeps no conversation: Theorem's own, in memory, while it runs. */
export type RunInbox = { memory: MemoryInbox<OwnItem>; close(): void };

/**
 * Opens the inbox of the run `name` in `scope`. A person's message reaches it with `steerRun`,
 * and a reply under a hold of it (`namedRun`) takes it. `close` ends it; a message still waiting is lost.
 */
export function openRun(own: OwnInbox, scope: string, name: string, leaseMs: number): RunInbox {
  const key = ownKey(scope, name);
  const memory = createMemoryInbox<OwnItem>({ leaseMs });
  own.runs.set(key, memory);
  return { memory, close: () => own.runs.delete(key) };
}

/** Puts a person's message into the run `name` in `scope`. False when no such run is open. */
export function steerRun(
  own: OwnInbox,
  scope: string,
  name: string,
  message: PersonMessage,
): boolean {
  const memory = own.runs.get(ownKey(scope, name));
  if (!memory) return false;
  memory.arrive(name, message);
  return true;
}

/** The inbox's name for a conversation or a run in one session: no session reaches another's. */
export function ownKey(sessionId: string, name: string): string {
  return `${sessionId}\u0000${name}`;
}

/**
 * The rule for what a reply takes: the first waiting message, one at each moment, and the
 * decider's choice among the late results.
 */
export function ownPolicy(options: {
  decider?: LateResultsDecider;
  host: () => Promise<unknown>;
}): InboxPolicy<OwnItem> {
  const { decider } = options;
  return async (items, moment) => {
    const message = items.find(isPersonMessage);
    const late = items.filter((item): item is LateResultItem => item.kind === 'late_result');
    const choice = decider
      ? await decider.policy(late, { ...moment, host: await options.host() })
      : { tell: [] };
    return {
      tell: [...(message ? [message.id] : []), ...choice.tell],
      ...(choice.giveUp ? { giveUp: choice.giveUp } : {}),
    };
  };
}

/** What a reply takes from its hold: late results for the kernel's source, messages for a stage. */
export type OwnReads = {
  late: LateResultsSource;
  stage: StageHandler;
  /** The ids among `ids` that this reply took as messages. */
  mine(ids: readonly string[]): string[];
};

/**
 * One take of the hold at each moment, shared by the two readers: the kernel asks for late results,
 * and the stage handler for a message. Each reader reads a moment once.
 */
export function ownReads(run: ReplyRun<OwnItem>): OwnReads {
  type Moment = { items: Promise<readonly OwnItem[]>; read: Set<'late' | 'stage'> };
  const moments = new Map<string, Moment>();
  let opening = true;
  const handed = new Set<string>();
  const items = (who: 'late' | 'stage', at: TakeAt): Promise<readonly OwnItem[]> => {
    const key = `${at.stage}:${at.step}`;
    let moment = moments.get(key);
    if (!moment || moment.read.has(who)) {
      const first = opening && at.stage === 'pre_turn';
      opening &&= !first;
      moment = {
        items: first ? Promise.resolve(run.opened) : run.take(at),
        read: new Set(),
      };
      moments.set(key, moment);
    }
    moment.read.add(who);
    return moment.items;
  };
  return {
    late: async ({ stage, step }) =>
      (await items('late', { stage, step }))
        .filter((item): item is LateResultItem => item.kind === 'late_result')
        .map((item) => item.outcome),
    stage: async ({ stage, step }) => {
      if (!isTurnInjectStage(stage)) return undefined;
      const taken = await items('stage', { stage, step });
      const message = taken.find(isPersonMessage);
      if (!message) return undefined;
      handed.add(message.id);
      const { id, messages, userParts } = message;
      return userParts
        ? { injects: [{ id, messages, userParts }] }
        : { inject: messages, injectId: id };
    },
    mine: (ids) => ids.filter((id) => handed.has(id)),
  };
}
