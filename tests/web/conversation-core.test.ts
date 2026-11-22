import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  type ModelRequest,
  type ProfileDefinition,
  TheoremError,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem, type ReplyRun } from '../../src/conversation/mod.ts';
import {
  type ConversationCore,
  type CoreContext,
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremConversationCore,
  followedUp,
  type Reply,
  type ReplyLine,
  type RunEnd,
  type TheoremConversationCoreOptions,
  type TheoremConversationStore,
  tellEveryResult,
  type WriteContext,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-core',
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

/** A model that answers in text, once `gate` lets it; `started` resolves as each request arrives. */
function answerer(seen: ModelRequest[], gate: { until: Promise<void>; started: () => void }) {
  const model: TurnModel = {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        gate.started();
        await gate.until;
        yield { type: 'text' as const, text: 'Done.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
  return model;
}

function harness(options: Partial<TheoremConversationCoreOptions<Note>> = {}) {
  const seen: ModelRequest[] = [];
  let free = () => {};
  let started = () => {};
  const gate = {
    until: Promise.resolve(),
    started: () => started(),
  };
  const core = createTheoremConversationCore<Note>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(answerer(seen, gate)),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    ...options,
  });
  return {
    core,
    seen,
    /** Makes the model wait, and resolves once it has a request. */
    hold() {
      gate.until = new Promise<void>((resolve) => {
        free = resolve;
      });
      return new Promise<void>((resolve) => {
        started = resolve;
      });
    },
    free: () => free(),
  };
}

function at(sessionId = KEEPER): CoreContext {
  return { sessionId, signal: new AbortController().signal };
}

/** A run's lines, then how it ended. */
async function drain(reply: Reply): Promise<{ lines: ReplyLine[]; end: RunEnd }> {
  const lines: ReplyLine[] = [];
  for (;;) {
    const next = await reply.next();
    if (next.done) return { lines, end: next.value };
    lines.push(next.value);
  }
}

function refOf(lines: readonly ReplyLine[]): string {
  let ref = '';
  for (const line of lines) if (line.type === 'conversation') ref = line.ref;
  assert(ref !== '', 'the run named no conversation');
  return ref;
}

async function say(core: ConversationCore, text: string, ref?: string) {
  return drain(await core.message(at(), { ...(ref ? { ref } : {}), input: { text } }));
}

Deno.test('a message runs with no request, and its lines end with how the run ended', async () => {
  const { core, seen } = harness();
  const { lines, end } = await say(core, 'hello');
  assertEquals(end, { outcome: 'released' });
  assertEquals(seen.length, 1);
  const view = await core.read(at(), { ref: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => block.kind),
    ['user-text', 'text', 'turn-done'],
  );
});

Deno.test("a reply holds the conversation in the app's inbox while it runs", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core, hold, free } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: () => ({ tell: [] }),
      leaseMs: LEASE_MS,
    }),
  });
  const running = hold();
  const reply = say(core, 'hello');
  await running;
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'held');
  free();
  assertEquals((await reply).end, { outcome: 'released' });
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a wake that finds the conversation held runs nothing and says until when', async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core, seen } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
    }),
  });
  const ref = refOf((await say(core, 'hello')).lines);
  await inbox.open(KEEPER, 'another-hold');
  const before = Date.now();
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assert(end.outcome === 'held' && end.leasedUntil >= before + LEASE_MS);
  assertEquals(seen.length, 1);
});

Deno.test("a page is told to wake when the app's policy tells a waiting item to a wake", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'wake' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
  });
  const ref = refOf((await say(core, 'hello')).lines);
  assertEquals((await core.read(at(), { ref })).wake, undefined);
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  assertEquals((await core.read(at(), { ref })).wake, true);
});

Deno.test("the app's inbox and a late-results decider are refused together", () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const error = assertThrows(
    () =>
      harness({
        inbox: () => ({
          inbox,
          conversation: KEEPER,
          policy: () => ({ tell: [] }),
          leaseMs: LEASE_MS,
        }),
        lateResultsDecider: tellEveryResult,
        wake: () => Promise.resolve(),
      }),
    TheoremError,
  );
  assertEquals(error.kind, 'config');
});

Deno.test('a late-results decider needs the wake it calls', () => {
  const error = assertThrows(() => harness({ lateResultsDecider: tellEveryResult }), TheoremError);
  assertEquals(error.kind, 'config');
});

/** A store that counts its writes. */
function countingStore(): { store: TheoremConversationStore; writes: () => number } {
  const inner = createMemoryConversationStore();
  let writes = 0;
  return {
    store: {
      read: (sessionId, ref) => inner.read(sessionId, ref),
      end: (sessionId, ending) => inner.end(sessionId, ending),
      write(sessionId, ref, expectedRevision, next) {
        writes++;
        return inner.write(sessionId, ref, expectedRevision, next);
      },
    },
    writes: () => writes,
  };
}

Deno.test("a message the app saved posts nothing, and its reply runs under the app's hold", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { store, writes } = countingStore();
  const { core, hold, free } = harness({
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: () => ({ tell: [] }),
      leaseMs: LEASE_MS,
    }),
  });
  assertEquals((await inbox.open(KEEPER, 'app-hold')).outcome, 'opened');
  const running = hold();
  const reply = drain(
    await core.message(at(), {
      input: { text: 'hello' },
      saved: { hold: 'app-hold', blocks: [{ id: 'row-1', kind: 'user-text', text: 'hello' }] },
    }),
  );
  await running;
  assertEquals(writes(), 0);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'held');
  free();
  const { lines, end } = await reply;
  assertEquals(end, { outcome: 'released' });
  assertEquals(writes(), 1);
  assertEquals(
    lines.filter((line) => line.type === 'conversation').map((line) => 'posted' in line),
    [false],
  );
  const view = await core.read(at(), { ref: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => [block.id === 'row-1', block.kind]),
    [
      [true, 'user-text'],
      [false, 'text'],
      [false, 'turn-done'],
    ],
  );
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a message the app saved, under a hold that lost the conversation, runs nothing', async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { store, writes } = countingStore();
  const { core, seen } = harness({
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: () => ({ tell: [] }),
      leaseMs: LEASE_MS,
    }),
  });
  await inbox.open(KEEPER, 'another-hold');
  const { lines, end } = await drain(
    await core.message(at(), {
      input: { text: 'hello' },
      saved: { hold: 'app-hold', blocks: [{ id: 'row-1', kind: 'user-text', text: 'hello' }] },
    }),
  );
  assertEquals(lines, []);
  assertEquals(end.outcome, 'held');
  assertEquals(seen.length, 0);
  assertEquals(writes(), 0);
});

Deno.test('a message the app saved is refused with no app inbox', async () => {
  const { core } = harness();
  const error = await assertRejects(
    () =>
      core.message(at(), {
        input: { text: 'hello' },
        saved: { hold: 'app-hold', blocks: [{ id: 'row-1', kind: 'user-text', text: 'hello' }] },
      }),
    TheoremError,
  );
  assertEquals(error.kind, 'config');
});

Deno.test("the app's prepare is given the reply's hold, with the items the reply opened with", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const runs: (ReplyRun<Note> | undefined)[] = [];
  const { core } = harness({
    prepare: (turn, run) => {
      runs.push(run);
      return turn;
    },
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'message' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
  });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  assertEquals((await say(core, 'hello')).end, { outcome: 'released' });
  assertEquals(
    runs.map((run) => run?.opened.map((item) => item.id)),
    [['note-1']],
  );
});

Deno.test("the app's prepare is given no hold when the app passes no inbox", async () => {
  const runs: unknown[] = [];
  const { core } = harness({
    prepare: (turn, run) => {
      runs.push(run);
      return turn;
    },
  });
  await say(core, 'hello');
  assertEquals(runs, [undefined]);
});

/** An inbox whose policy tells an item no reply has read, to a reply to no message. */
function followUpInbox() {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const asked: string[] = [];
  return {
    inbox,
    asked,
    option: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items: readonly Note[], moment: { opening: string }) => {
        asked.push(moment.opening);
        const fresh = items.filter((item) => item.handovers.length === 0);
        return { tell: moment.opening === 'message' ? [] : fresh.map((item) => item.id) };
      },
      leaseMs: LEASE_MS,
    }),
  };
}

Deno.test('a run that leaves an item waiting ends continue, and still holds the conversation', async () => {
  const { inbox, option } = followUpInbox();
  const { core, seen } = harness({ inbox: option });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { lines, end } = await say(core, 'hello');
  assert(end.outcome === 'continue');
  assertEquals(end.ref, refOf(lines));
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'held');

  const next = await drain(await core.followUp(at(), { ref: end.ref, hold: end.hold }));
  assertEquals(next.end, { outcome: 'released' });
  assertEquals(seen.length, 2);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a caller that runs no follow-up lets the conversation go', async () => {
  const { inbox, option } = followUpInbox();
  const { core, seen } = harness({ inbox: option });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { end } = await say(core, 'hello');
  assert(end.outcome === 'continue');
  await core.release(at(), { ref: end.ref, hold: end.hold });
  assertEquals(seen.length, 1);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a caller chooses, for each run that ends continue, who runs the next reply', async () => {
  for (const [choice, models, after] of [
    ['here', 2, 'opened'],
    ['let_go', 1, 'opened'],
    ['taken', 1, 'held'],
  ] as const) {
    const { inbox, option } = followUpInbox();
    const { core, seen } = harness({ inbox: option });
    inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
    const reply = await core.message(at(), { input: { text: 'hello' } });
    const { end } = await drain(followedUp(core, at(), reply, () => choice));
    assertEquals(end.outcome, choice === 'taken' ? 'continue' : 'released');
    assertEquals(seen.length, models);
    assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, after);
  }
});

Deno.test('a follow-up under a hold that lost the conversation runs nothing', async () => {
  const { inbox, option } = followUpInbox();
  const { core, seen } = harness({ inbox: option });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { end } = await say(core, 'hello');
  assert(end.outcome === 'continue');
  await inbox.takeOver(KEEPER, 'another-hold');
  const next = await drain(await core.followUp(at(), { ref: end.ref, hold: end.hold }));
  assertEquals(next.lines, []);
  assertEquals(next.end, { outcome: 'lost' });
  assertEquals(seen.length, 1);
});

Deno.test('a follow-up on a core that holds no conversation runs nothing', async () => {
  const { core, seen } = harness();
  const ref = refOf((await say(core, 'hello')).lines);
  const next = await drain(await core.followUp(at(), { ref, hold: 'no-hold' }));
  assertEquals(next.lines, []);
  assertEquals(next.end, { outcome: 'released' });
  assertEquals(seen.length, 1);
});

Deno.test('a follow-up answers in another session of the same conversation', async () => {
  const { inbox, option } = followUpInbox();
  const { core, seen } = harness({ inbox: option });
  const phone = at('phone-session');
  const first = await drain(await core.message(phone, { input: { text: 'hello' } }));
  const phoneRef = refOf(first.lines);
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { lines, end } = await say(core, 'hello');
  assert(end.outcome === 'continue');

  const next = await drain(await core.followUp(phone, { ref: phoneRef, hold: end.hold }));
  assertEquals(next.end, { outcome: 'released' });
  assertEquals(seen.length, 3);
  const kinds = async (where: CoreContext, ref: string) =>
    (await core.read(where, { ref })).transcript.map((block) => block.kind);
  assertEquals(await kinds(at(), refOf(lines)), ['user-text', 'text', 'turn-done']);
  assertEquals(await kinds(phone, refOf(next.lines)), [
    'user-text',
    'text',
    'turn-done',
    'text',
    'turn-done',
  ]);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test("a release under the app's inbox reads no chat", async () => {
  const { inbox, option } = followUpInbox();
  const { core } = harness({ inbox: option });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { end } = await say(core, 'hello');
  assert(end.outcome === 'continue');
  await core.release(at('phone-session'), { ref: 'no-such-chat', hold: end.hold });
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a follow-up that cannot open its chat throws, and lets the conversation go', async () => {
  const { inbox, option } = followUpInbox();
  const { core, seen } = harness({ inbox: option });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { end } = await say(core, 'hello');
  assert(end.outcome === 'continue');
  await assertRejects(() => core.followUp(at(), { ref: 'no-such-chat', hold: end.hold }));
  assertEquals(seen.length, 1);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

/** A memory store that keeps the context of each write, and whether it was written. */
function contextStore() {
  const inner = createMemoryConversationStore();
  const writes: { context: WriteContext | undefined; written: boolean }[] = [];
  const store: TheoremConversationStore = {
    read: (sessionId, ref) => inner.read(sessionId, ref),
    end: (sessionId, ending) => inner.end(sessionId, ending),
    async write(sessionId, ref, expectedRevision, next, context) {
      const result = await inner.write(sessionId, ref, expectedRevision, next, context);
      writes.push({ context, written: result.written });
      return result;
    },
  };
  return { store, writes };
}

Deno.test("the app's save steps are given the run's context and the reply's hold, and the last runs while the reply holds the conversation", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { store, writes } = contextStore();
  const shaped: { session: string; ended: string; opened: string[]; hold: string }[] = [];
  const after: { session: string; ended: string; told: readonly string[]; held: string }[] = [];
  const { core } = harness({
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'message' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
    beforeSave: (ctx, reply) => {
      shaped.push({
        session: ctx.sessionId,
        ended: reply.ended,
        opened: reply.held?.opened.map((item) => item.id) ?? [],
        hold: reply.held?.hold ?? '',
      });
      return Promise.resolve({
        blocks: reply.blocks,
        told: ['note-1'],
        host: { row: 'reply-row' },
      });
    },
    afterSave: async (ctx, saved) => {
      after.push({
        session: ctx.sessionId,
        ...saved,
        held: (await inbox.open(KEEPER, 'another-hold')).outcome,
      });
    },
  });
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  assertEquals((await say(core, 'hello')).end, { outcome: 'released' });
  assertEquals(
    shaped.map((reply) => [reply.session, reply.ended, reply.opened]),
    [[KEEPER, 'committed', ['note-1']]],
  );
  const saves = writes.filter((write) => write.context);
  assertEquals(saves.length, 1, 'the posted message is a write with no context');
  assertEquals(saves[0].context?.hold, shaped[0].hold);
  assertEquals(saves[0].context?.host, { row: 'reply-row' });
  assertEquals(saves[0].context?.told, ['note-1']);
  assertEquals(after, [{ session: KEEPER, ended: 'committed', told: ['note-1'], held: 'held' }]);
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a reply whose hold another run took over ends lost, and its save tells nothing', async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { store, writes } = contextStore();
  const ends: string[] = [];
  const after: string[] = [];
  const { core, hold, free } = harness({
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: () => ({ tell: [] }),
      leaseMs: LEASE_MS,
    }),
    beforeSave: (_ctx, reply) => {
      ends.push(reply.ended);
      return Promise.resolve({ blocks: reply.blocks, told: ['note-1'] });
    },
    afterSave: (_ctx, saved) => {
      after.push(saved.ended);
      return Promise.resolve();
    },
  });
  const running = hold();
  const reply = say(core, 'hello');
  await running;
  await inbox.takeOver(KEEPER, 'the-newer-message');
  free();
  assertEquals((await reply).end.outcome, 'lost');
  assertEquals(ends, ['lost']);
  assertEquals(after, []);
  const saves = writes.filter((write) => write.context);
  assertEquals(
    saves.map((write) => [write.context?.ended, write.context?.told, write.written]),
    [['lost', [], false]],
  );
});

Deno.test("an after-save step that throws is reported, and the reply's save stands", async () => {
  const reported: unknown[] = [];
  const { core } = harness({
    beforeSave: (_ctx, reply) => Promise.resolve({ blocks: reply.blocks, told: [] }),
    afterSave: () => Promise.reject(new Error('the channel is down')),
    onError: (err) => reported.push(err),
  });
  const { lines, end } = await say(core, 'hello');
  assertEquals(end, { outcome: 'released' });
  assertEquals(
    reported.map((err) => (err instanceof Error ? err.message : err)),
    ['the channel is down'],
  );
  const view = await core.read(at(), { ref: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => block.kind),
    ['user-text', 'text', 'turn-done'],
  );
});

Deno.test("a block's host values reach the page that reads the conversation", async () => {
  const { core } = harness({
    beforeSave: (_ctx, reply) =>
      Promise.resolve({
        blocks: reply.blocks.map((block, index) => ({ ...block, host: { row: `row-${index}` } })),
        told: [],
      }),
  });
  const { lines } = await say(core, 'hello');
  const view = await core.read(at(), { ref: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => [block.kind, block.host]),
    [
      ['user-text', undefined],
      ['text', { row: 'row-0' }],
      ['turn-done', { row: 'row-1' }],
    ],
  );
});
