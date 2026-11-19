import { assert, assertEquals } from '@std/assert';
import { defaultKernelScope, type ProfileDefinition, type TurnModel } from '../../mod.ts';
import {
  type ConversationInbox,
  createMemoryInbox,
  type InboxItem,
} from '../../src/conversation/mod.ts';
import {
  type CoreContext,
  createMemoryConversationStore,
  createTheoremConversationCore,
  type HoldStop,
  type Reply,
  type ReplyLine,
  type RunEnd,
  type TheoremConversationStore,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'hold-stop',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const KEEPER = 'person-1';
const LEASE_MS = 60_000;

registerFixtureProviders(defaultKernelScope);

type Note = InboxItem<'note'>;
/** When a reply that waits on a stop hears one: as it is asked, or only at its next look. */
type Hears = 'at once' | 'at its next look';

/** A model that says half its reply, then waits for `rest` before the other half. */
function halves(runs: { count: number }, rest: () => Promise<void>): TurnModel {
  return {
    complete: () =>
      (async function* () {
        runs.count += 1;
        yield { type: 'text' as const, text: 'first half, ' };
        await rest();
        yield { type: 'text' as const, text: 'second half.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

/**
 * The app's stop, as a database row would keep it: the hold that has the conversation, and the
 * hold a stop was asked for.
 */
function appStop(inbox: ConversationInbox<Note>, hears: Hears) {
  let holder: string | undefined;
  let asked: string | undefined;
  const waiting = new Set<() => void>();
  const watched: string[] = [];
  const tracked: ConversationInbox<Note> = {
    ...inbox,
    open: async (conversation, hold) => {
      const opened = await inbox.open(conversation, hold);
      if (opened.outcome === 'opened') holder = hold;
      return opened;
    },
    takeOver: async (conversation, hold) => {
      await inbox.takeOver(conversation, hold);
      holder = hold;
    },
    release: async (conversation, hold, version) => {
      const released = await inbox.release(conversation, hold, version);
      if (released === 'released' && holder === hold) holder = undefined;
      return released;
    },
  };
  const stop: HoldStop = {
    ask: () => {
      if (holder === undefined) return Promise.resolve(false);
      asked = holder;
      if (hears === 'at once') for (const wake of waiting) wake();
      return Promise.resolve(true);
    },
    stopped: (_conversation, hold, over) => {
      watched.push(hold);
      return new Promise((resolve) => {
        const check = () => {
          if (asked !== hold) return;
          waiting.delete(check);
          resolve(true);
        };
        waiting.add(check);
        over.addEventListener('abort', () => {
          waiting.delete(check);
          resolve(false);
        });
        check();
      });
    },
    clear: (_conversation, hold) => {
      if (asked === hold) asked = undefined;
      return Promise.resolve();
    },
  };
  return { tracked, stop, watched };
}

function at(): CoreContext {
  return { sessionId: KEEPER, signal: new AbortController().signal };
}

async function drain(
  reply: Reply,
  onLine: (line: ReplyLine) => void = () => {},
): Promise<{ lines: ReplyLine[]; end: RunEnd }> {
  const lines: ReplyLine[] = [];
  for (;;) {
    const next = await reply.next();
    if (next.done) return { lines, end: next.value };
    lines.push(next.value);
    onLine(next.value);
  }
}

function textOf(lines: readonly ReplyLine[]): string {
  return lines.flatMap((line) => (line.type === 'text' ? [line.text] : [])).join('');
}

function app(more: { beforePrepare?: () => Promise<void>; hears?: Hears } = {}) {
  const runs = { count: 0 };
  const saves: string[] = [];
  const rest = Promise.withResolvers<void>();
  const memory = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { tracked, stop, watched } = appStop(memory, more.hears ?? 'at once');
  const conversations = createMemoryConversationStore();
  /** A store that marks told what the reply told, in its write, as an app's store does. */
  const store: TheoremConversationStore = {
    ...conversations,
    write: async (sessionId, where, expected, next, context) => {
      const result = await conversations.write(sessionId, where, expected, next, context);
      if (result.written && context?.hold && context.reply) {
        memory.settle(KEEPER, context.hold, context.reply, context.told);
      }
      return result;
    },
  };
  const core = createTheoremConversationCore<Note>({
    profile: PROFILE,
    provider: () => fixtureHostOptions(halves(runs, () => rest.promise)),
    conversationStore: store,
    inbox: () => ({
      inbox: tracked,
      conversation: KEEPER,
      policy: (items) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
      stop,
    }),
    prepare: async (request) => {
      await more.beforePrepare?.();
      return request;
    },
    beforeSave: (_at, reply) => {
      saves.push(reply.ended);
      return Promise.resolve({
        blocks: reply.blocks,
        told: reply.held?.opened.map((item) => item.id) ?? [],
      });
    },
  });
  return {
    core,
    runs,
    saves,
    watched,
    arrive: (id: string) => memory.arrive(KEEPER, { id, kind: 'note', handovers: [] }),
    free: () => rest.resolve(),
  };
}

Deno.test('a stop with no reply holding the conversation stops nothing', async () => {
  const { core } = app();
  assertEquals(await core.stop(at(), { turnId: 'any' }), false);
});

Deno.test("the app's stop reaches a reply that no page turn started, and names no turn id", async () => {
  const { core, saves, watched, free } = app();
  const stops: Promise<boolean>[] = [];
  const { lines, end } = await drain(
    await core.message(at(), { input: { text: 'tell me' } }),
    (line) => {
      if (line.type === 'text') stops.push(core.stop(at(), { turnId: 'not-this-reply' }));
    },
  );
  free();
  assertEquals(await Promise.all(stops), [true]);
  assertEquals(textOf(lines), 'first half, ');
  assertEquals(saves, ['stopped']);
  assertEquals(end, { outcome: 'released' });
  assertEquals(watched.length, 1);
  assertEquals(await core.stop(at(), { turnId: 'any' }), false, 'the stopped reply still holds');
});

Deno.test('a stop asked before the reply runs its model stops it', async () => {
  let ask: () => Promise<boolean> = () => Promise.resolve(false);
  const { core, runs, saves } = app({
    beforePrepare: async () => {
      assert(await ask(), 'no reply held the conversation');
    },
  });
  ask = () => core.stop(at(), { turnId: 'any' });
  const { lines } = await drain(await core.message(at(), { input: { text: 'tell me' } }));
  assertEquals(textOf(lines), '');
  assertEquals(runs.count, 0, 'the model ran');
  assertEquals(saves, ['stopped']);
});

Deno.test('a stop is for one reply: the follow-up under the same hold runs to its end', async () => {
  const { core, runs, saves, watched, arrive, free } = app();
  const stops: Promise<boolean>[] = [];
  const first = await drain(await core.message(at(), { input: { text: 'tell me' } }), (line) => {
    if (line.type !== 'text') return;
    arrive('note-1');
    stops.push(core.stop(at(), { turnId: 'any' }));
  });
  await Promise.all(stops);
  assert(first.end.outcome === 'continue', 'no item waited for a follow-up');
  free();
  const next = await drain(await core.followUp(at(), { ref: first.end.ref, hold: first.end.hold }));
  assertEquals(textOf(next.lines), 'first half, second half.');
  assertEquals(next.end, { outcome: 'released' });
  assertEquals(saves, ['stopped', 'committed']);
  assertEquals(runs.count, 2);
  assertEquals(watched, [first.end.hold, first.end.hold]);
});

Deno.test('a stop that came too late for its reply does not stop the follow-up', async () => {
  const { core, runs, saves, arrive, free } = app({ hears: 'at its next look' });
  const stops: Promise<boolean>[] = [];
  free();
  const first = await drain(await core.message(at(), { input: { text: 'tell me' } }), (line) => {
    if (line.type !== 'text' || stops.length > 0) return;
    arrive('note-1');
    stops.push(core.stop(at(), { turnId: 'any' }));
  });
  assertEquals(await Promise.all(stops), [true]);
  assertEquals(textOf(first.lines), 'first half, second half.', 'the reply heard the stop');
  assert(first.end.outcome === 'continue', 'no item waited for a follow-up');
  const next = await drain(await core.followUp(at(), { ref: first.end.ref, hold: first.end.hold }));
  assertEquals(textOf(next.lines), 'first half, second half.');
  assertEquals(saves, ['committed', 'committed']);
  assertEquals(runs.count, 2);
});
