/**
 * Scenarios any conversation inbox must pass under {@link runConversation}: an item arrives at each
 * moment a reply can be in, and each is told exactly once, given up and reported once, or left for
 * a hold that still has the conversation.
 *
 * @module
 */

import { runConversation } from './run.ts';
import type {
  ConversationInbox,
  ConversationRun,
  InboxItem,
  InboxPolicy,
  ReplyRun,
  ReplyStart,
} from './types.ts';

/** One inbox for one scenario, with the app's own writes. */
export interface ScenarioHarness<Item extends InboxItem> {
  inbox: ConversationInbox<Item>;
  conversation: string;
  /** Saves an item with this id, as the app does when one arrives. */
  arrive(id: string): Promise<void>;
  /** A reply's save: marks `ids` told by `reply`. False when the hold no longer has it. */
  settle(hold: string, reply: string, ids: readonly string[]): Promise<boolean>;
  /** A paused reply's save: keeps `ids` with `reply`. False when the hold no longer has it. */
  pause(hold: string, reply: string, ids: readonly string[]): Promise<boolean>;
  /** Moves the clock past every lease. */
  lapse(): Promise<void>;
  /** The ids told so far, once for each time one was told. */
  told(): Promise<readonly string[]>;
}

/** One scenario: `run` throws when the inbox fails it. */
export interface ConversationScenario {
  name: string;
  run(): Promise<void>;
}

/** Options for {@link conversationScenarios}. */
export interface ConversationScenariosOptions<Item extends InboxItem> {
  /** A fresh harness for each scenario. */
  makeHarness(): Promise<ScenarioHarness<Item>>;
}

/** Long enough that no renewal runs inside a scenario; a scenario lapses the lease itself. */
const RENEW_EVERY_MS = 60_000;

const newId = (): string => crypto.randomUUID();
const idsOf = (items: readonly InboxItem[]): string[] => items.map((item) => item.id);
const tellAll: InboxPolicy = (items) => ({ tell: idsOf(items) });

function fail(message: string): never {
  throw new Error(message);
}

function expectOutcome(run: ConversationRun, outcome: ConversationRun['outcome'], when: string) {
  if (run.outcome !== outcome) fail(`${when}: the run ended ${run.outcome}, not ${outcome}`);
}

/** A scenario's harness, with the runs it makes and what was given up. */
class Scene<Item extends InboxItem> {
  readonly gaveUp: string[] = [];
  constructor(readonly h: ScenarioHarness<Item>) {}

  /** One run whose reply does `body`, by default telling all it read. */
  run(
    start: ReplyStart,
    body: (reply: ReplyRun<Item>) => Promise<void> = (reply) => this.tellRead(reply, []),
    policy: InboxPolicy<Item> = tellAll,
  ): Promise<ConversationRun> {
    return runConversation({
      conversation: this.h.conversation,
      inbox: this.h.inbox,
      policy,
      start,
      newId,
      renewEveryMs: RENEW_EVERY_MS,
      reply: body,
      gaveUp: (items) => {
        this.gaveUp.push(...idsOf(items));
      },
    });
  }

  /** Saves the reply, telling what it opened with and `later`. */
  async tellRead(reply: ReplyRun<Item>, later: readonly Item[]): Promise<void> {
    const read = idsOf([...reply.opened, ...later]);
    if (!(await this.h.settle(reply.hold, reply.reply, read))) fail('the save was turned away');
  }

  /** Runs follow-ups until the conversation is let go. */
  async drain(first: ConversationRun): Promise<void> {
    let last = first;
    for (let turns = 0; last.outcome === 'continue'; turns += 1) {
      if (turns > 3) fail('the follow-ups did not end');
      last = await this.run({ opening: 'follow_up', hold: last.hold });
    }
    expectOutcome(last, 'released', 'after the follow-ups');
  }

  async expectTold(expected: readonly string[]): Promise<void> {
    const told = await this.h.told();
    for (const id of expected) {
      const times = told.filter((each) => each === id).length;
      if (times !== 1) fail(`${id} was told ${times} times, not once`);
    }
    const extra = told.filter((id) => !expected.includes(id));
    if (extra.length > 0) fail(`told what it should not have: ${extra.join(', ')}`);
  }

  async expectUnread(): Promise<void> {
    const { items } = await this.h.inbox.read(this.h.conversation);
    if (items.length > 0) fail(`still waiting: ${idsOf(items).join(', ')}`);
  }
}

/** Answers the paused reply: the reply that goes on resumes it, tells what it got, and is saved. */
async function answerPaused<Item extends InboxItem>(
  s: Scene<Item>,
  paused: string,
  told: readonly string[],
  label: string,
): Promise<void> {
  const answered = await s.run({ opening: 'message' }, async (reply) =>
    s.tellRead(reply, await reply.resume(paused)),
  );
  expectOutcome(answered, 'released', label);
  await s.expectTold(told);
}

/** Runs a wake whose reply pauses with what it opened with; returns the paused reply. */
async function pauseWith<Item extends InboxItem>(s: Scene<Item>): Promise<string> {
  let paused: string | undefined;
  const ran = await s.run({ opening: 'wake' }, async (reply) => {
    paused = reply.reply;
    if (!(await s.h.pause(reply.hold, reply.reply, idsOf(reply.opened)))) {
      fail('the pause was turned away');
    }
  });
  expectOutcome(ran, 'released', 'the paused wake');
  if (paused === undefined) fail('the reply did not pause');
  return paused;
}

/** The scenarios, each on a fresh harness from `options.makeHarness`. */
export function conversationScenarios<Item extends InboxItem>(
  options: ConversationScenariosOptions<Item>,
): ConversationScenario[] {
  const scenario = (name: string, body: (scene: Scene<Item>) => Promise<void>) => ({
    name,
    run: async () => body(new Scene(await options.makeHarness())),
  });

  return [
    scenario('an item that arrives before a reply is told as it opens', async (s) => {
      await s.h.arrive('a');
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'the wake');
      await s.expectTold(['a']);
    }),

    scenario(
      'a wake with nothing waiting runs no reply and lets the conversation go',
      async (s) => {
        let replied = false;
        const ran = await s.run({ opening: 'wake' }, () => {
          replied = true;
          return Promise.resolve();
        });
        expectOutcome(ran, 'released', 'the wake');
        if (replied) fail('a wake with nothing waiting ran a reply');
        expectOutcome(await s.run({ opening: 'message' }), 'released', 'the next message');
      },
    ),

    scenario('a message under the hold the app already took runs, and lets go', async (s) => {
      await s.h.arrive('r');
      const opened = await s.h.inbox.open(s.h.conversation, 'app-hold');
      if (opened.outcome !== 'opened') fail('the app did not take the conversation');
      const ran = await s.run({ opening: 'message', hold: 'app-hold' });
      expectOutcome(ran, 'released', 'the message');
      await s.expectTold(['r']);
    }),

    scenario('a message under a hold the app does not have is held', async (s) => {
      const opened = await s.h.inbox.open(s.h.conversation, 'other-hold');
      if (opened.outcome !== 'opened') fail('the other hold did not take the conversation');
      let replied = false;
      const ran = await s.run({ opening: 'message', hold: 'app-hold' }, () => {
        replied = true;
        return Promise.resolve();
      });
      expectOutcome(ran, 'held', 'the message');
      if (replied) fail('a message under a hold it does not have ran a reply');
    }),

    scenario('an item that arrives during a step is read at the next moment', async (s) => {
      const ran = await s.run({ opening: 'message' }, async (reply) => {
        await s.h.arrive('b');
        await s.tellRead(reply, await reply.take({ stage: 'post_tool', step: 1 }));
      });
      expectOutcome(ran, 'released', 'the message');
      await s.expectTold(['b']);
    }),

    scenario('an item that arrives while the reply saves is told by a follow-up', async (s) => {
      const ran = await s.run({ opening: 'message' }, async (reply) => {
        await s.h.arrive('c');
        if (await s.h.settle(reply.hold, reply.reply, ['c'])) fail('saved an item it never read');
        await s.tellRead(reply, []);
      });
      expectOutcome(ran, 'continue', 'the message');
      await s.drain(ran);
      await s.expectTold(['c']);
    }),

    scenario('an item that arrives as the hold lets go keeps the conversation', async (s) => {
      const inbox = s.h.inbox;
      let arrived = false;
      const racing = new Scene<Item>({
        ...s.h,
        inbox: {
          open: (c, hold) => inbox.open(c, hold),
          takeOver: (c, hold) => inbox.takeOver(c, hold),
          renew: (c, hold) => inbox.renew(c, hold),
          read: (c) => inbox.read(c),
          hand: (c, hold, handover, ids) => inbox.hand(c, hold, handover, ids),
          giveBack: (c, hold, reply, ids) => inbox.giveBack(c, hold, reply, ids),
          resume: (c, hold, paused, handover) => inbox.resume(c, hold, paused, handover),
          giveUp: (c, hold, ids) => inbox.giveUp(c, hold, ids),
          release: async (c, hold, version) => {
            if (!arrived) {
              arrived = true;
              await s.h.arrive('d');
            }
            return inbox.release(c, hold, version);
          },
        },
      });
      const ran = await racing.run({ opening: 'message' });
      expectOutcome(ran, 'continue', 'the message');
      await racing.drain(ran);
      await s.expectTold(['d']);
    }),

    scenario('a wake that finds a reply running is told once that reply ends', async (s) => {
      let woke: ConversationRun | undefined;
      const ran = await s.run({ opening: 'message' }, async (reply) => {
        await s.h.arrive('e');
        woke = await s.run({ opening: 'wake' });
        await s.tellRead(reply, []);
      });
      if (woke === undefined) fail('the wake did not run');
      expectOutcome(woke, 'held', 'the wake');
      expectOutcome(ran, 'continue', 'the message');
      await s.drain(ran);
      await s.expectTold(['e']);
    }),

    scenario('two replies that open at once never run together', async (s) => {
      await s.h.arrive('f');
      let running = 0;
      const body = async (reply: ReplyRun<Item>) => {
        running += 1;
        if (running > 1) fail('two replies ran at once');
        await new Promise((resolve) => setTimeout(resolve, 1));
        await s.tellRead(reply, []);
        running -= 1;
      };
      const both = await Promise.all([
        s.run({ opening: 'message' }, body),
        s.run({ opening: 'message' }, body),
      ]);
      for (const ran of both) {
        if (ran.outcome === 'continue') await s.drain(ran);
        else if (ran.outcome !== 'held' && ran.outcome !== 'released') {
          fail(`a racing reply ended ${ran.outcome}`);
        }
      }
      await s.expectTold(['f']);
    }),

    scenario('an item a paused reply read waits for it, and is told once it goes on', async (s) => {
      await s.h.arrive('g');
      const paused = await pauseWith(s);
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'a wake during the pause');
      await s.h.lapse();
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'a wake after the lease');
      await s.expectTold([]);
      await answerPaused(s, paused, ['g'], 'the answer');
    }),

    scenario('a resumed reply that fails leaves the item with the paused reply', async (s) => {
      await s.h.arrive('h');
      const paused = await pauseWith(s);
      const failed = await s.run({ opening: 'message' }, async (reply) => {
        await reply.resume(paused);
        throw new Error('the model failed');
      });
      expectOutcome(failed, 'released', 'the failed answer');
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'a wake after the failure');
      await s.expectUnread();
      await answerPaused(s, paused, ['h'], 'the second answer');
    }),

    scenario('a resumed reply that pauses again keeps the item for its own pause', async (s) => {
      await s.h.arrive('i');
      const first = await pauseWith(s);
      let second: string | undefined;
      await s.run({ opening: 'message' }, async (reply) => {
        const resumed = await reply.resume(first);
        second = reply.reply;
        if (!(await s.h.pause(reply.hold, reply.reply, idsOf(resumed)))) fail('pause turned away');
      });
      if (second === undefined) fail('the answer did not pause');
      const again = second;
      await s.run({ opening: 'message' }, async (reply) => {
        if ((await reply.resume(first)).length > 0) fail('the first pause still had the item');
        await s.tellRead(reply, await reply.resume(again));
      });
      await s.expectTold(['i']);
    }),

    scenario('a reply whose lease ran out cannot save what another hold told', async (s) => {
      await s.h.arrive('j');
      let late: boolean | undefined;
      const first = await s.run({ opening: 'wake' }, async (reply) => {
        await s.h.lapse();
        expectOutcome(await s.run({ opening: 'wake' }), 'released', 'the second hold');
        late = await s.h.settle(reply.hold, reply.reply, idsOf(reply.opened));
      });
      if (late !== false) fail('the first hold saved after its lease ran out');
      expectOutcome(first, 'lost', 'the first hold');
      await s.expectTold(['j']);
    }),

    scenario('of two replies whose holds overlap, at most one saves', async (s) => {
      await s.h.arrive('k');
      let late: boolean | undefined;
      let second: boolean | undefined;
      const first = await s.run({ opening: 'wake' }, async (reply) => {
        await s.h.lapse();
        // why: The second reply reads nothing as it runs, so only the fences stand between them.
        const ran = await s.run(
          { opening: 'message' },
          async (own) => {
            if ((await reply.take({ stage: 'post_tool', step: 1 })).length > 0) {
              fail('a hold that lost its lease took an item');
            }
            late = await s.h.settle(reply.hold, reply.reply, idsOf(reply.opened));
            second = await s.h.settle(own.hold, own.reply, []);
          },
          (items, moment) => ({ tell: moment.opening === 'follow_up' ? idsOf(items) : [] }),
        );
        await s.drain(ran);
      });
      if (late === undefined || second === undefined) fail('the replies did not save');
      if (late && second) fail('both replies saved');
      expectOutcome(first, 'lost', 'the first hold');
      await s.expectTold(['k']);
    }),

    scenario(
      'a message takes the conversation from a running wake, and tells what it read',
      async (s) => {
        await s.h.arrive('q');
        let late: boolean | undefined;
        const woke = await s.run({ opening: 'wake' }, async (reply) => {
          const message = await s.run({ opening: 'message', takeOver: true });
          expectOutcome(message, 'released', 'the message');
          late = await s.h.settle(reply.hold, reply.reply, idsOf(reply.opened));
        });
        if (late !== false) fail('the wake saved after a message took the conversation');
        expectOutcome(woke, 'lost', 'the wake');
        await s.expectTold(['q']);
      },
    ),

    scenario(
      'a hold that lost its lease ends lost, and the next hold tells what came',
      async (s) => {
        const first = await s.run({ opening: 'message' }, async (reply) => {
          await s.h.lapse();
          await s.h.arrive('l');
          // why: Whether a lapsed hold may still save depends on the store's fences; either way it ends lost.
          await s.h.settle(reply.hold, reply.reply, []);
        });
        if (first.outcome !== 'lost') fail(`the lapsed message ended ${first.outcome}, not lost`);
        if (first.failure !== undefined) fail('the lapsed message failed');
        expectOutcome(await s.run({ opening: 'wake' }), 'released', 'the next wake');
        await s.expectTold(['l']);
      },
    ),

    scenario('a follow-up under a hold that lapsed ends lost, and runs no reply', async (s) => {
      const first = await s.run({ opening: 'message' }, async (reply) => {
        await s.h.arrive('m');
        await s.tellRead(reply, []);
      });
      if (first.outcome !== 'continue') fail(`the message ended ${first.outcome}, not continue`);
      await s.h.lapse();
      let replied = false;
      const late = await s.run({ opening: 'follow_up', hold: first.hold }, () => {
        replied = true;
        return Promise.resolve();
      });
      expectOutcome(late, 'lost', 'the late follow-up');
      if (replied) fail('a follow-up ran a reply under a hold it lost');
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'the next wake');
      await s.expectTold(['m']);
    }),

    scenario('a reply that throws gives back what it read, with its handover', async (s) => {
      await s.h.arrive('n');
      const thrown = new Error('the model failed');
      const ran = await s.run({ opening: 'wake' }, () => Promise.reject(thrown));
      if (ran.outcome !== 'continue') fail(`the failed wake ended ${ran.outcome}, not continue`);
      if (ran.failure !== thrown) fail('the failure was not returned');
      const { items } = await s.h.inbox.read(s.h.conversation);
      const back = items.find((item) => item.id === 'n');
      if (back === undefined) fail('the item was not given back');
      if (back.handovers.length !== 1)
        fail(`the item has ${back.handovers.length} handovers, not 1`);
      await s.drain(ran);
      await s.expectTold(['n']);
    }),

    scenario('an item a reply fails on is given up once the policy says so', async (s) => {
      await s.h.arrive('o');
      const twice: InboxPolicy<Item> = (items) => ({
        tell: idsOf(items.filter((item) => item.handovers.length < 2)),
        giveUp: idsOf(items.filter((item) => item.handovers.length >= 2)),
      });
      const failing = () => Promise.reject(new Error('the model failed'));
      let last = await s.run({ opening: 'wake' }, failing, twice);
      for (let turns = 0; last.outcome === 'continue'; turns += 1) {
        if (turns > 3) fail('the failing follow-ups did not end');
        last = await s.run({ opening: 'follow_up', hold: last.hold }, failing, twice);
      }
      expectOutcome(last, 'released', 'after giving up');
      if (s.gaveUp.join() !== 'o') fail(`gave up ${s.gaveUp.join() || 'nothing'}, not o once`);
      await s.expectUnread();
      expectOutcome(await s.run({ opening: 'wake' }), 'released', 'a wake after giving up');
      await s.expectTold([]);
    }),
  ];
}
