import { assert, assertEquals, assertRejects } from '@std/assert';
import { defineProfile, type ProfileDefinition, type TurnEvent, toErrorEvent } from '../../mod.ts';
import type { TranscriptBlock } from '../../src/interface/mod.ts';
import { failureEvent } from '../../src/kernel/tools/events.ts';
import { theoremStartRequestSchema } from '../../web/src/client/transport.ts';
import {
  answerReply,
  conversationView,
  messageReply,
  type ReplyLine,
  type ReplyRunner,
  type ReplySaving,
  type ReplyToSave,
  readerConversationHost,
  wakeReply,
} from '../../web/src/server/conversation.ts';
import {
  createMemoryConversationStore,
  createSealedConversationStore,
  emptyConversation,
  openConversation,
  type PostedMessage,
  type StoredConversation,
  type TheoremConversationStore,
  type WriteContext,
} from '../../web/src/server/mod.ts';
import { toolSnapshot } from '../fixtures/events.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-reply-save',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const PERSON = 'one-person';

type Write = { next: StoredConversation; context: WriteContext | undefined; written: boolean };

/** A memory store that keeps each write it was asked for. */
function recordingStore() {
  const inner = createMemoryConversationStore();
  const writes: Write[] = [];
  const store: TheoremConversationStore = {
    read: (sessionId, ref) => inner.read(sessionId, ref),
    end: (sessionId, ending) => inner.end(sessionId, ending),
    async write(sessionId, ref, expectedRevision, next, context) {
      const result = await inner.write(sessionId, ref, expectedRevision, next, context);
      writes.push({ next, context, written: result.written });
      return result;
    },
  };
  return { store, writes };
}

function hostOf(store: TheoremConversationStore) {
  return readerConversationHost({
    sessionId: PERSON,
    store,
    profile: PROFILE,
    clientEvents: undefined,
  });
}

function message(text: string): PostedMessage {
  return {
    draft: { text },
    blocks: [{ id: `typed-${text}`, kind: 'user-text', text }],
    media: {},
    input: { text },
  };
}

const ANSWER: TurnEvent[] = [
  { type: 'text', text: 'Done.' },
  { type: 'done', stop: { kind: 'completed' } },
];

const GATE: TurnEvent[] = [
  {
    type: 'tool',
    tool: { name: 'lookup', callId: 'call-1', operationId: 'call-1', arguments: {}, stepId: 's1' },
  },
  {
    type: 'tool',
    tool: {
      name: 'lookup',
      callId: 'call-1',
      operationId: 'call-1',
      at: 0,
      phase: 'gate',
      gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
    },
  },
  { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
];

/** A runner whose model run yields `events`, then throws `thrown` when it is set. */
function runner(
  events: readonly TurnEvent[],
  extra: Partial<ReplyRunner> & { thrown?: Error } = {},
): ReplyRunner {
  const { thrown, ...rest } = extra;
  return {
    signal: new AbortController().signal,
    compact: () => Promise.resolve(undefined),
    run: () =>
      (async function* () {
        yield* events;
        if (thrown) throw thrown;
      })(),
    ...rest,
  };
}

/** The app's steps, recording what each was given. `shape` is what `before` answers. */
function steps(
  shape: (reply: ReplyToSave) => {
    blocks: readonly TranscriptBlock[];
    told: readonly string[];
    host?: unknown;
  } = (reply) => ({ blocks: reply.blocks, told: [] }),
) {
  const seen: ReplyToSave[] = [];
  const after: { ended: string; told: readonly string[]; landed: readonly string[] }[] = [];
  const compacted: number[] = [];
  const reported: unknown[] = [];
  const saving: ReplySaving = {
    before: (reply) => {
      seen.push(reply);
      return Promise.resolve(shape(reply));
    },
    after: (saved) => {
      after.push(saved);
      return Promise.resolve();
    },
    compact: (signal) => {
      compacted.push(signal.tokens);
      return Promise.resolve();
    },
    report: (err) => reported.push(err),
  };
  return { saving, seen, after, compacted, reported };
}

async function linesOf(reply: AsyncIterable<ReplyLine>): Promise<ReplyLine[]> {
  const lines: ReplyLine[] = [];
  for await (const line of reply) lines.push(line);
  return lines;
}

const NEW = () => ({ ref: null, revision: null, conversation: emptyConversation() });
const kinds = (blocks: readonly TranscriptBlock[]) => blocks.map((block) => block.kind);

Deno.test("a reply's save tells the store how the reply ended and the blocks it adds", async () => {
  const { store, writes } = recordingStore();
  await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      runner: runner(ANSWER, { hold: 'hold-1', reply: 'reply-1' }),
    }),
  );
  assertEquals(writes.length, 2);
  const [posted, saved] = writes;
  assertEquals(posted.context, undefined, 'a posted message is no reply, so it has no context');
  assert(saved.context, 'the save of a reply has a context');
  const { appended, ...rest } = saved.context;
  assertEquals(rest, { hold: 'hold-1', reply: 'reply-1', ended: 'committed', told: [] });
  assertEquals(kinds(appended), ['text', 'turn-done']);
  assertEquals(saved.next.transcript, [...posted.next.transcript, ...appended]);
});

Deno.test('the app shapes a reply before its save, and the store is told what it shaped', async () => {
  const { store, writes } = recordingStore();
  const shapedBlocks: TranscriptBlock[] = [
    { id: 'row-1', kind: 'user-text', text: 'hello', host: { rowId: 'row-1' } },
    { id: 'row-2', kind: 'text', text: 'Done.', host: { rowId: 'row-2' } },
  ];
  const app = steps(() => ({ blocks: shapedBlocks, told: ['item-1'], host: { patches: 2 } }));
  const lines = await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(
        [
          {
            type: 'stage',
            stage: 'pre_turn',
            injected: [
              {
                id: 'steer-1',
                messages: [{ role: 'user', content: 'Also the fern' }],
                host: { rowId: 'row-9' },
              },
            ],
          },
          ...ANSWER,
        ],
        { hold: 'hold-1', reply: 'reply-1', saving: app.saving },
      ),
    }),
  );
  assertEquals(writes.length, 1, 'a message the app saved is written with its reply, once');
  assertEquals(app.seen.length, 1);
  const [given] = app.seen;
  assertEquals(given.ended, 'committed');
  assertEquals(given.landed, ['steer-1']);
  assertEquals(kinds(given.blocks), ['user-text', 'user-text', 'text', 'turn-done']);
  assertEquals(given.blocks[0].id, 'row-1');
  assertEquals(given.blocks[1].host, { rowId: 'row-9' }, "an inject's blocks carry its host");
  assertEquals(writes[0].context, {
    hold: 'hold-1',
    reply: 'reply-1',
    host: { patches: 2 },
    ended: 'committed',
    told: ['item-1'],
    appended: shapedBlocks,
  });
  assertEquals(writes[0].next.transcript, shapedBlocks);
  assertEquals(app.after, [{ ended: 'committed', told: ['item-1'], landed: ['steer-1'] }]);
  const ref = lines.findLast((line) => line.type === 'conversation');
  assert(ref?.type === 'conversation');
  const kept = await store.read(PERSON, ref.ref);
  assertEquals(kept?.conversation.transcript, shapedBlocks, 'the store keeps each block host');
});

Deno.test('a reply that fails is worded by the app that shapes it, from the failure', async () => {
  const { store, writes } = recordingStore();
  const app = steps();
  await assertRejects(
    () =>
      linesOf(
        messageReply({
          host: hostOf(store),
          opened: NEW(),
          message: message('hello'),
          saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
          runner: runner([{ type: 'text', text: 'So far' }], {
            saving: app.saving,
            thrown: new Error('the-model-broke'),
          }),
        }),
      ),
    Error,
    'the-model-broke',
  );
  assertEquals(app.seen.length, 1);
  assertEquals(app.seen[0].ended, 'failed');
  assertEquals(app.seen[0].failure?.type, 'error');
  assertEquals(kinds(app.seen[0].blocks), ['user-text', 'text'], 'the core adds no error block');
  assertEquals(writes[0].context?.ended, 'failed');
  assertEquals(app.after, [{ ended: 'failed', told: [], landed: [] }]);
});

Deno.test('a shaping step that throws on a failed reply saves nothing and keeps the failure', async () => {
  const { store, writes } = recordingStore();
  const app = steps(() => {
    throw new Error('the-shaping-broke');
  });
  await assertRejects(
    () =>
      linesOf(
        messageReply({
          host: hostOf(store),
          opened: NEW(),
          message: message('hello'),
          saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
          runner: runner([], { saving: app.saving, thrown: new Error('the-model-broke') }),
        }),
      ),
    Error,
    'the-model-broke',
  );
  assertEquals(writes.length, 0);
  assertEquals(app.after, []);
  assertEquals(
    app.reported.map((err) => (err instanceof Error ? err.message : '')),
    ['the-shaping-broke'],
  );
});

Deno.test('a shaping step that throws on a finished reply fails the reply, unsaved', async () => {
  const { store, writes } = recordingStore();
  const app = steps(() => {
    throw new Error('the-shaping-broke');
  });
  await assertRejects(
    () =>
      linesOf(
        messageReply({
          host: hostOf(store),
          opened: NEW(),
          message: message('hello'),
          saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
          runner: runner(ANSWER, { saving: app.saving }),
        }),
      ),
    Error,
    'the-shaping-broke',
  );
  assertEquals(writes.length, 0);
  assertEquals(app.reported, []);
});

Deno.test('a reply that pauses saves the blocks the app shaped beside it, once', async () => {
  const { store, writes } = recordingStore();
  const link: TranscriptBlock = { id: 'row-2', kind: 'text', text: 'Sign in here.' };
  const app = steps((reply) => ({ blocks: [...reply.blocks, link], told: [] }));
  await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(GATE, { saving: app.saving }),
    }),
  );
  assertEquals(app.seen.length, 1);
  assertEquals(app.seen[0].ended, 'paused');
  assertEquals(
    app.seen[0].blocks.map((block) => block.id),
    ['row-1'],
    "the paused reply's own blocks wait with it",
  );
  assertEquals(writes.length, 1);
  assertEquals(
    writes[0].next.transcript.map((block) => block.id),
    ['row-1', 'row-2'],
  );
  assertEquals(writes[0].context?.appended, writes[0].next.transcript);
  assert(writes[0].next.paused, 'the reply waits on its gate');
});

Deno.test('a reply to a message whose hold lost the conversation tells nothing, and a store with no holds keeps none of it', async () => {
  const { store, writes } = recordingStore();
  const app = steps((reply) => ({ blocks: reply.blocks, told: ['item-1'] }));
  const lines = await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(ANSWER, {
        hold: 'hold-1',
        reply: 'reply-1',
        held: () => Promise.resolve(false),
        saving: app.saving,
      }),
    }),
  );
  assertEquals(app.seen.length, 1);
  assertEquals(app.seen[0].ended, 'lost');
  assertEquals(kinds(app.seen[0].blocks), ['user-text', 'text', 'turn-done']);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].context?.ended, 'lost');
  assertEquals(writes[0].context?.told, [], 'a lost reply tells nothing');
  assertEquals(writes[0].written, false, 'the memory store keeps no holds, so it refuses');
  assertEquals(app.reported, [], 'a store that refuses a lost write decided; nothing is reported');
  assertEquals(app.after, []);
  assertEquals(
    lines.filter((line) => line.type === 'conversation' && !('posted' in line)),
    [],
  );
});

Deno.test('a lost reply with no shaping step, and a lost wake, write nothing', async () => {
  const { store, writes } = recordingStore();
  const lost = { held: () => Promise.resolve(false) };
  await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(ANSWER, lost),
    }),
  );
  const app = steps();
  await linesOf(
    wakeReply({
      host: hostOf(store),
      opened: NEW(),
      runner: runner(ANSWER, { ...lost, saving: app.saving }),
    }),
  );
  assertEquals(writes.length, 0);
  assertEquals(app.seen, []);
});

Deno.test('the built-in stores refuse a lost write, whether or not another save came first', async () => {
  const lost: WriteContext = { ended: 'lost', told: [], appended: [] };
  const memory = createMemoryConversationStore();
  const first = await memory.write(PERSON, null, null, emptyConversation());
  assert(first.written);
  const next = emptyConversation();
  assertEquals(await memory.write(PERSON, first.ref, first.revision, next, lost), {
    written: false,
  });
  const taker = await memory.write(PERSON, first.ref, first.revision, next);
  assert(taker.written, 'the hold that took the conversation still saves');
  assertEquals(await memory.write(PERSON, first.ref, first.revision, next, lost), {
    written: false,
  });
  const sealed = createSealedConversationStore({ keys: { 1: 'k'.repeat(32) }, keyVersion: 1 });
  const seal = await sealed.write(PERSON, null, null, emptyConversation());
  assert(seal.written);
  assertEquals(await sealed.write(PERSON, seal.ref, seal.revision, next, lost), { written: false });
});

Deno.test("the app's compaction runs in place of the runner's, and the reply writes once", async () => {
  const { store, writes } = recordingStore();
  const app = steps();
  let ran = 0;
  await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(
        [
          { type: 'text', text: 'Done.' },
          {
            type: 'done',
            stop: { kind: 'completed' },
            compaction: {
              needed: true,
              meter: 'history',
              tokens: 900,
              unknownMedia: 0,
              history: [],
            },
          },
        ],
        {
          saving: app.saving,
          compact: () => {
            ran++;
            return Promise.resolve([{ role: 'user', content: 'Summary.' }]);
          },
        },
      ),
    }),
  );
  assertEquals(app.compacted, [900]);
  assertEquals(ran, 0);
  assertEquals(writes.length, 1);
  assertEquals(app.after.length, 1);
});

Deno.test('a transcript a page restores carries no host values', async () => {
  const { store } = recordingStore();
  const opened = await openConversation(
    hostOf(store),
    'a-ref-the-host-lost',
    { kind: 'message' },
    {
      profile: defineProfile(PROFILE),
      blocks: [{ id: 'b1', kind: 'user-text', text: 'hello', host: { rowId: 'forged' } }],
    },
  );
  assertEquals(opened.conversation.transcript, [{ id: 'b1', kind: 'user-text', text: 'hello' }]);
});

Deno.test('a message that walks away from a paused reply ends both replies in one save', async () => {
  const { store, writes } = recordingStore();
  const host = hostOf(store);
  const first = await linesOf(
    messageReply({ host, opened: NEW(), message: message('look it up'), runner: runner(GATE) }),
  );
  const ref = first.flatMap((line) => (line.type === 'conversation' ? [line.ref] : [])).at(-1);
  assert(ref, 'the paused reply named its conversation');
  const before = writes.length;
  const app = steps((reply) => ({ blocks: reply.blocks, told: ['row-2'] }));
  await linesOf(
    messageReply({
      host,
      opened: await openConversation(host, ref, {
        kind: 'message',
        abandon: [{ callId: 'call-1', operationId: 'call-1' }],
      }),
      message: message('never mind'),
      saved: [{ id: 'row-2', kind: 'user-text', text: 'never mind' }],
      walkAway: [
        {
          callId: 'call-1',
          operationId: 'call-1',
          events: (async function* () {
            yield failureEvent(
              { name: 'lookup', callId: 'call-1' },
              { code: 'cancelled', kind: 'cancelled', message: 'cancelled' },
            );
          })(),
        },
      ],
      runner: runner(ANSWER, { hold: 'hold-1', reply: 'reply-2', saving: app.saving }),
    }),
  );
  assertEquals(writes.length, before + 1, 'the walked-away reply and the new one save together');
  assertEquals(app.seen.length, 1);
  assertEquals(app.seen[0].ended, 'committed');
  assertEquals(kinds(app.seen[0].blocks), ['tool', 'turn-done', 'user-text', 'text', 'turn-done']);
  const write = writes[before];
  assertEquals(write.context?.reply, 'reply-2');
  assertEquals(write.context?.appended, app.seen[0].blocks);
  assertEquals(write.next.paused, undefined);
  assertEquals(kinds(write.next.transcript), [
    'user-text',
    'tool',
    'turn-done',
    'user-text',
    'text',
    'turn-done',
  ]);
});

Deno.test('a start request from a page carries no host values', () => {
  const { blocks } = theoremStartRequestSchema.parse({
    blocks: [{ id: 'b1', kind: 'user-text', text: 'hello', host: { row: 'forged' } }],
  });
  assertEquals(blocks, [{ id: 'b1', kind: 'user-text', text: 'hello' }]);
});

const CALL = { callId: 'call-1', operationId: 'call-1' };
const SETTLED: TurnEvent = {
  type: 'tool',
  tool: {
    name: 'lookup',
    callId: 'call-1',
    operationId: 'call-1',
    at: 0,
    phase: 'complete',
    output: { finding: 'ok' },
    readBack: '{"finding":"ok"}',
  },
};

/** A conversation whose reply waits on its gate, saved with the block the app put beside it. */
async function pausedBeside(store: TheoremConversationStore) {
  const host = hostOf(store);
  const link: TranscriptBlock = { id: 'row-2', kind: 'text', text: 'Sign in here.' };
  const app = steps((reply) => ({ blocks: [...reply.blocks, link], told: [] }));
  const lines = await linesOf(
    messageReply({
      host,
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(GATE, { saving: app.saving }),
    }),
  );
  const ref = lines.flatMap((line) => (line.type === 'conversation' ? [line.ref] : [])).at(-1);
  assert(ref, 'the paused reply named its conversation');
  return { host, ref };
}

Deno.test("an answered reply's save holds the paused reply's blocks once, and not the block the app put beside it", async () => {
  const { store, writes } = recordingStore();
  const { host, ref } = await pausedBeside(store);
  const app = steps();
  await linesOf(
    answerReply({
      host,
      opened: await openConversation(host, ref, { kind: 'answer', call: CALL }),
      call: CALL,
      settling: (async function* () {
        yield SETTLED;
      })(),
      runner: runner(ANSWER, { saving: app.saving }),
    }),
  );
  assertEquals(app.seen.length, 1);
  assertEquals(app.seen[0].ended, 'committed');
  assertEquals(kinds(app.seen[0].blocks), ['tool', 'turn-done', 'text', 'turn-done']);
  const write = writes.at(-1);
  assertEquals(write?.context?.appended, app.seen[0].blocks);
  assertEquals(
    write?.next.transcript.map((block) => block.kind),
    ['user-text', 'text', 'tool', 'turn-done', 'text', 'turn-done'],
  );
  assertEquals(
    write?.next.transcript.filter((block) => block.id === 'row-2').length,
    1,
    'the block beside the pause is saved once',
  );
});

Deno.test('an answer that does not settle saves the reply paused again, with the failure and no block', async () => {
  const { store, writes } = recordingStore();
  const { host, ref } = await pausedBeside(store);
  const app = steps();
  const failure = toErrorEvent(new Error('the-answer-broke'));
  const lines = await linesOf(
    answerReply({
      host,
      opened: await openConversation(host, ref, { kind: 'answer', call: CALL }),
      call: CALL,
      settling: (async function* () {
        yield failure;
      })(),
      runner: runner(ANSWER, { saving: app.saving }),
    }),
  );
  assertEquals(
    app.seen.map((reply) => [reply.ended, reply.blocks, reply.failure]),
    [['paused', [], failure]],
  );
  assertEquals(writes.at(-1)?.context?.ended, 'paused');
  assertEquals(writes.at(-1)?.context?.appended, []);
  assert(writes.at(-1)?.next.paused, 'the reply still waits on its gate');
  assertEquals(lines.at(-1), failure);
});

Deno.test('a walk-away that does not settle saves the reply paused again, with the failure and no block', async () => {
  const { store, writes } = recordingStore();
  const { host, ref } = await pausedBeside(store);
  const app = steps();
  const failure = toErrorEvent(new Error('the-cancel-broke'));
  const saved = writes.length;
  const lines = await linesOf(
    messageReply({
      host,
      opened: await openConversation(host, ref, { kind: 'message', abandon: [CALL] }),
      message: message('never mind'),
      saved: [{ id: 'row-3', kind: 'user-text', text: 'never mind' }],
      walkAway: [
        {
          ...CALL,
          events: (async function* () {
            yield failure;
          })(),
        },
      ],
      runner: runner(ANSWER, { saving: app.saving }),
    }),
  );
  assertEquals(
    app.seen.map((reply) => [reply.ended, reply.blocks, reply.failure]),
    [['paused', [], failure]],
  );
  assertEquals(writes.length, saved + 1);
  assert(writes.at(-1)?.next.paused, 'the reply still waits on its gate');
  assertEquals(lines.at(-1), failure);
});

Deno.test('a store that keeps holds takes a lost reply, and the run names no save', async () => {
  const inner = createMemoryConversationStore();
  const lost: { next: StoredConversation; context: WriteContext }[] = [];
  const store: TheoremConversationStore = {
    read: (sessionId, ref) => inner.read(sessionId, ref),
    end: (sessionId, ending) => inner.end(sessionId, ending),
    write(sessionId, ref, expectedRevision, next, context) {
      if (context?.ended !== 'lost') return inner.write(sessionId, ref, expectedRevision, next);
      lost.push({ next, context });
      return inner.write(sessionId, ref, expectedRevision, next);
    },
  };
  const app = steps((reply) => ({ blocks: reply.blocks, told: ['item-1'] }));
  const lines = await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(ANSWER, {
        hold: 'hold-1',
        reply: 'reply-1',
        held: () => Promise.resolve(false),
        saving: app.saving,
      }),
    }),
  );
  assertEquals(lost.length, 1);
  assertEquals(lost[0].context.hold, 'hold-1');
  assertEquals(lost[0].context.told, []);
  assertEquals(kinds(lost[0].context.appended), ['user-text', 'text', 'turn-done']);
  assertEquals(lost[0].next.transcript, lost[0].context.appended);
  assertEquals(app.after, []);
  assertEquals(app.reported, []);
  assertEquals(
    lines.filter((line) => line.type === 'conversation'),
    [],
    'a lost reply names no conversation: the hold that has it does',
  );
});

Deno.test('a shaping step that throws on a stopped reply saves nothing, and the reply ends stopped', async () => {
  const { store, writes } = recordingStore();
  const app = steps(() => {
    throw new Error('the-shaping-broke');
  });
  const stop = new AbortController();
  stop.abort();
  const lines = await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      saved: [{ id: 'row-1', kind: 'user-text', text: 'hello' }],
      runner: runner(ANSWER, { saving: app.saving, signal: stop.signal }),
    }),
  );
  assertEquals(writes.length, 0);
  assertEquals(
    app.reported.map((err) => (err instanceof Error ? err.message : '')),
    ['the-shaping-broke'],
  );
  assertEquals(
    lines.filter((line) => line.type === 'error'),
    [],
  );
});

Deno.test("a step after the save, or the app's compaction, that throws is reported, and the save stands", async () => {
  const { store, writes } = recordingStore();
  const app = steps();
  await linesOf(
    messageReply({
      host: hostOf(store),
      opened: NEW(),
      message: message('hello'),
      runner: runner(
        [
          { type: 'text', text: 'Done.' },
          {
            type: 'done',
            stop: { kind: 'completed' },
            compaction: {
              needed: true,
              meter: 'history',
              tokens: 900,
              unknownMedia: 0,
              history: [],
            },
          },
        ],
        {
          saving: {
            ...app.saving,
            after: () => Promise.reject(new Error('the-channel-is-down')),
            compact: () => Promise.reject(new Error('the-compaction-broke')),
          },
        },
      ),
    }),
  );
  assertEquals(
    app.reported.map((err) => (err instanceof Error ? err.message : '')),
    ['the-channel-is-down', 'the-compaction-broke'],
  );
  assertEquals(
    writes.filter((write) => write.context).map((write) => write.written),
    [true],
  );
});

Deno.test("conversation view: a failed call saved without its wording reads in the profile's", () => {
  const failed: TranscriptBlock = {
    id: 'tool-1',
    kind: 'tool',
    tool: {
      name: 'design_plan',
      callId: 'call-1',
      arguments: {},
      state: {
        name: 'design_plan',
        callId: 'call-1',
        at: 1,
        phase: 'error',
        failure: { code: 'slow', kind: 'timeout', message: 'the upstream model took 61s' },
      },
    },
  };
  const labels = { 'error.timeout': 'That took too long.' };
  const host = readerConversationHost({
    sessionId: PERSON,
    store: createMemoryConversationStore(),
    profile: { ...PROFILE, labels },
    clientEvents: undefined,
  });
  const [block] = conversationView(host, {
    ...emptyConversation(),
    transcript: [failed],
  }).transcript;
  const state = block?.kind === 'tool' ? block.tool.state : undefined;
  assertEquals(state?.phase === 'error' ? state.failure.error : undefined, 'That took too long.');
  assertEquals(
    state?.phase === 'error' ? state.failure.message : undefined,
    'the upstream model took 61s',
  );
});
