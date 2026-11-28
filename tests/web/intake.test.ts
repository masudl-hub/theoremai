import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  TheoremError,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import { clientFailure } from '../../web/src/client/failure.ts';
import {
  type ChatLine,
  createHttpTransport,
  type RunningReply,
  TheoremStreamError,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createTheoremHandler,
  emptyConversation,
  type HoldStop,
  type MessageIntake,
  type TheoremConversationStore,
  type TheoremHandlerOptions,
  type TheoremNotifier,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

const KEEPER = 'person-1';
const LEASE_MS = 60_000;

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'intake',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

registerFixtureProviders(defaultKernelScope);

type Sent = InboxItem<'message'>;
type Script = { until?: Promise<void> };

/** A model that counts its runs, and answers once `until` settles. */
function model(runs: { count: number }, script: Script): TurnModel {
  return {
    complete: () =>
      (async function* () {
        runs.count += 1;
        await script.until;
        yield { type: 'text' as const, text: 'Sure.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

/** A browser on the handler: keeps the session cookie it issues. */
function browserFor(handler: (request: Request) => Promise<Response>): TheoremTransport {
  let cookie = '';
  return createHttpTransport({
    endpoint: 'https://app.test/api/theorem',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      return response;
    },
  });
}

const itemId = (id: string) => `message:${id}`;
const rowId = (id: string) => `row:${id}`;
const landsAs = (id: string) => [itemId(id), rowId(id)];

/**
 * A handler whose app saves each message itself: the message waits as an item in the app's inbox,
 * and joins the transcript with the reply that reads it.
 */
function app(
  script: Script = {},
  more: Partial<TheoremHandlerOptions<Sent>> = {},
  {
    marks = 'marks told',
    stop,
    elsewhere,
  }: {
    marks?: 'marks told' | 'never marks told';
    stop?: HoldStop;
    /** The reply the app's records say runs elsewhere, as its store's read returns it. */
    elsewhere?: { running?: RunningReply };
  } = {},
) {
  const runs = { count: 0 };
  const texts = new Map<string, string>();
  const intakes: string[] = [];
  let ref: string | undefined;
  const inbox = createMemoryInbox<Sent>({ leaseMs: LEASE_MS });
  const memory = createMemoryConversationStore();
  const sessions = new Set<string>();
  /** A store that marks told what the reply told, in its write, as an app's store does. */
  const store: TheoremConversationStore = {
    ...memory,
    read: async (sessionId, at) => {
      sessions.add(sessionId);
      const snapshot = await memory.read(sessionId, at);
      const running = elsewhere?.running;
      return snapshot && running ? { ...snapshot, running } : snapshot;
    },
    write: async (sessionId, at, expected, next, context) => {
      const result = await memory.write(sessionId, at, expected, next, context);
      if (marks === 'marks told' && result.written && context?.hold && context.reply) {
        inbox.settle(KEEPER, context.hold, context.reply, context.told);
      }
      return result;
    },
  };
  const options: TheoremHandlerOptions<Sent> = {
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(model(runs, script)),
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
      ...(stop ? { stop } : {}),
    }),
    intake: async (at, sent): Promise<MessageIntake> => {
      intakes.push(sent.id);
      if (ref === undefined) {
        const made = await store.write(at.sessionId, null, null, emptyConversation());
        assert(made.written, 'the app made no conversation');
        ref = made.ref;
      }
      const names = { ref, landsAs: landsAs(sent.id) };
      if (texts.has(sent.id)) return { outcome: 'saved', ...names };
      texts.set(sent.id, sent.message.text ?? '');
      inbox.arrive(KEEPER, { id: itemId(sent.id), kind: 'message', handovers: [] });
      const hold = `hold:${sent.id}`;
      if ((await inbox.open(KEEPER, hold)).outcome === 'held')
        return { outcome: 'saved', ...names };
      const text = sent.message.text ?? '';
      return {
        outcome: 'opened',
        ...names,
        hold,
        blocks: [{ id: rowId(sent.id), kind: 'user-text', text }],
      };
    },
    beforeSave: (_at, reply) => {
      const told = [
        ...(reply.held?.opened.map((item) => item.id) ?? []),
        ...reply.landed.filter((id) => id.startsWith('message:')),
      ];
      const shown = new Set(reply.blocks.map((block) => block.id));
      // The messages the reply read join the transcript before it, as the app's rows would.
      const read = told.flatMap((id) => {
        const sentId = id.slice('message:'.length);
        return shown.has(rowId(sentId)) || reply.landed.includes(id)
          ? []
          : [{ id: rowId(sentId), kind: 'user-text' as const, text: texts.get(sentId) ?? '' }];
      });
      return Promise.resolve({ blocks: [...read, ...reply.blocks], told });
    },
    ...more,
  };
  const transport = browserFor(createTheoremHandler(options));
  const run = async (send: (onLine: (line: ChatLine) => void) => Promise<void> | undefined) => {
    const lines: ChatLine[] = [];
    await send((line) => lines.push(line));
    return lines;
  };
  return { transport, run, runs, intakes, inbox, memory, sessions, refOf: () => ref ?? '' };
}

/** A notifier that remembers each session a page listens under, so a test can publish to it. */
function listenedNotifier(): TheoremNotifier & { sessions: string[] } {
  const base = createMemoryNotifier();
  const sessions: string[] = [];
  return {
    sessions,
    subscribe: (sessionId, changed) => {
      sessions.push(sessionId);
      return base.subscribe(sessionId, changed);
    },
    publish: (sessionId) => base.publish(sessionId),
  };
}

/**
 * A conversation with one reply in it, then a reply that runs elsewhere on the message `m2`:
 * the app's inbox is held, and its store's read says so.
 */
async function runningElsewhere(
  made: ReturnType<typeof app>,
  elsewhere: { running?: RunningReply },
) {
  await made.run((onLine) => made.transport.turn({ id: 'm1', input: { text: 'first' } }, onLine));
  await made.inbox.open(KEEPER, 'elsewhere');
  elsewhere.running = {
    since: 1_000,
    prompt: [{ id: rowId('m2'), kind: 'user-text', text: 'second' }],
    heldUntil: Date.now() + LEASE_MS,
  };
}

/** The reply elsewhere ends as the app's own reply would: its message and answer saved, the hold let go. */
async function endElsewhere(made: ReturnType<typeof app>, elsewhere: { running?: RunningReply }) {
  const [sessionId] = made.sessions;
  const snapshot = await made.memory.read(sessionId, made.refOf());
  assert(snapshot, 'the conversation is gone');
  const { conversation } = snapshot;
  const answered = [
    { id: rowId('m2'), kind: 'user-text' as const, text: 'second' },
    { id: 'answer-m2', kind: 'text' as const, text: 'Done.' },
  ];
  const next = { ...conversation, transcript: [...conversation.transcript, ...answered] };
  const written = await made.memory.write(sessionId, made.refOf(), snapshot.revision, next);
  assert(written.written, 'the reply elsewhere was not saved');
  elsewhere.running = undefined;
  await made.inbox.release(KEEPER, 'elsewhere', (await made.inbox.read(KEEPER)).version);
}

const said = (blocks: readonly { kind: string; text?: string }[]) =>
  blocks.flatMap((b) => (b.kind === 'user-text' || b.kind === 'text' ? [[b.kind, b.text]] : []));

function gate(): { script: Script; free(): void } {
  let free = () => {};
  const until = new Promise<void>((resolve) => {
    free = resolve;
  });
  return { script: { until }, free };
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > 2000) return reject(new Error('the wait ran out'));
      setTimeout(tick, 1);
    };
    tick();
  });
}

const conversationLines = (lines: readonly ChatLine[]) =>
  lines.flatMap((line) => (line.type === 'conversation' ? [line] : []));

Deno.test('a handler with `intake` and no `inbox` is refused at setup', () => {
  assertThrows(() =>
    createTheoremHandler({
      operationRetentionMs: TEST_OPERATION_RETENTION_MS,
      profile: PROFILE,
      provider: () => fixtureHostOptions(model({ count: 0 }, {})),
      conversationStore: createMemoryConversationStore(),
      intake: () => Promise.reject(new Error('unused')),
    }),
  );
});

Deno.test("a message the app's save opened says how replies name it, then its reply runs under the app's hold", async () => {
  const { transport, run, runs, intakes, inbox, refOf } = app();
  const lines = await run((onLine) =>
    transport.turn({ id: 'm1', input: { text: 'hello' } }, onLine),
  );
  assertEquals(intakes, ['m1']);
  assertEquals(lines[0], {
    type: 'conversation',
    ref: refOf(),
    posted: true,
    landsAs: landsAs('m1'),
  });
  assertEquals(runs.count, 1);
  const view = await transport.conversation({ conversation: refOf() });
  assertEquals(
    view.transcript.map((block) => [block.id === rowId('m1'), block.kind]),
    [
      [true, 'user-text'],
      [false, 'text'],
      [false, 'turn-done'],
    ],
  );
  assertEquals(view.wake, undefined);
  assertEquals((await inbox.open(KEEPER, 'next')).outcome, 'opened', 'the reply kept the hold');
});

Deno.test('a message saved while another reply holds the conversation streams one line and runs nothing', async () => {
  const { transport, run, runs, inbox, refOf } = app();
  await inbox.open(KEEPER, 'elsewhere');
  const lines = await run((onLine) =>
    transport.turn({ id: 'm1', input: { text: 'hello' } }, onLine),
  );
  assertEquals(lines, [
    { type: 'conversation', ref: refOf(), posted: true, landsAs: landsAs('m1') },
  ]);
  assertEquals(runs.count, 0);
});

Deno.test('a message with no id, or to a conversation the host does not know, is refused before the app saves it', async () => {
  const { transport, run, intakes } = app();
  await assertRejects(() => run((onLine) => transport.turn({ input: { text: 'hello' } }, onLine)));
  await assertRejects(() =>
    run((onLine) =>
      transport.turn({ id: 'm1', conversation: 'no-such', input: { text: 'hello' } }, onLine),
    ),
  );
  await assertRejects(() =>
    transport.steer({ turnId: 't', id: 'm2', conversation: 'no-such', input: { text: 'x' } }),
  );
  assertEquals(intakes, []);
});

Deno.test("a steer the app saves does not go to the running turn: the reply's follow-up opens with it", async () => {
  const { script, free } = gate();
  const { transport, run, runs, refOf } = app(script, { onContinue: () => 'here' });
  const turn = run((onLine) =>
    transport.turn({ id: 'm1', turnId: 'turn-1', input: { text: 'first' } }, onLine),
  );
  await waitFor(() => runs.count === 1);
  const ref = refOf();
  const steered = await transport.steer({
    turnId: 'turn-1',
    id: 'm2',
    conversation: ref,
    input: { text: 'second' },
  });
  assertEquals(steered, { saved: { conversation: ref, landsAs: landsAs('m2') } });
  free();
  const lines = await turn;
  assertEquals(
    lines.flatMap((line) => (line.type === 'stage' ? (line.injected ?? []) : [])),
    [],
    'the steer went to the running turn',
  );
  assertEquals(runs.count, 2, 'no follow-up read the steer');
  assertEquals(
    conversationLines(lines).flatMap((line) => line.opened ?? []),
    [itemId('m1'), itemId('m2')],
  );
});

Deno.test("a steer whose save opened the conversation lets it go, and the page's wake runs the reply", async () => {
  const { transport, run, runs, inbox, refOf } = app();
  await run((onLine) => transport.turn({ id: 'm1', input: { text: 'first' } }, onLine));
  const ref = refOf();
  const steered = await transport.steer({
    turnId: 'gone',
    id: 'm2',
    conversation: ref,
    input: { text: 'second' },
  });
  assertEquals(steered, { saved: { conversation: ref, landsAs: landsAs('m2') } });
  assertEquals(runs.count, 1);
  assertEquals((await transport.conversation({ conversation: ref })).wake, true);
  const woke = await run((onLine) => transport.wake?.({ conversation: ref }, onLine));
  assertEquals(runs.count, 2);
  assertEquals(conversationLines(woke)[0], { type: 'conversation', ref, opened: [itemId('m2')] });
  assertEquals((await inbox.open(KEEPER, 'next')).outcome, 'opened');
});

Deno.test('a steer whose save opened the conversation keeps the hold when the app takes the reply', async () => {
  const taken: { ref: string; hold: string }[] = [];
  const { transport, run, runs, inbox, refOf } = app(
    {},
    {
      onContinue: (held) => {
        taken.push(held);
        return 'taken';
      },
    },
  );
  await run((onLine) => transport.turn({ id: 'm1', input: { text: 'first' } }, onLine));
  const ref = refOf();
  taken.length = 0;
  await transport.steer({ turnId: 'gone', id: 'm2', conversation: ref, input: { text: 'second' } });
  assertEquals(taken, [{ ref, hold: 'hold:m2' }]);
  assertEquals(runs.count, 1);
  assertEquals((await inbox.open(KEEPER, 'next')).outcome, 'held');
});

Deno.test('a page keeps a message the host saved in its pending list until a reply reads it', async () => {
  const { transport, runs, inbox } = app();
  const iface = await transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({ iface, transport });
  const leave = chat.subscribe(() => {});
  await inbox.open(KEEPER, 'elsewhere');
  chat.setDraftText('hello');
  await chat.submit();
  await waitFor(() => chat.getState().phase === 'idle' && !chat.getState().streaming);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = chat.getState();
  assertEquals(runs.count, 0);
  assertEquals(waiting.failure, null);
  assertEquals(waiting.draftText, '');
  assertEquals(waiting.blocks, []);
  assertEquals(
    waiting.pendingMessages.map((m) => [m.kind, m.draft.text, m.saved?.landsAs.length]),
    [['steer', 'hello', 2]],
  );
  const [saved] = waiting.pendingMessages;
  await chat.sendNow(saved);
  await chat.restorePending(saved.id);
  chat.movePending(saved.id, 'up');
  assertEquals(chat.getState().pendingMessages, waiting.pendingMessages, 'an action changed it');
  assertEquals(runs.count, 0, 'the page sent a saved message again');

  // The other reply ends, and the page reads the conversation: it wakes, and the reply reads the message.
  await inbox.release(KEEPER, 'elsewhere', (await inbox.read(KEEPER)).version);
  await chat.refresh();
  await waitFor(() => runs.count === 1 && chat.getState().phase === 'idle');
  await waitFor(() => chat.getState().blocks.some((block) => block.kind === 'text'));
  const read = chat.getState();
  assertEquals(read.pendingMessages, []);
  assertEquals(
    read.blocks.flatMap((b) =>
      b.kind === 'user-text' || b.kind === 'text' ? [[b.kind, b.text]] : [],
    ),
    [
      ['user-text', 'hello'],
      ['text', 'Sure.'],
    ],
  );
  leave();
});

Deno.test("a page's steer the host saved stays pending, never requeues, and lands when the follow-up opens with it", async () => {
  const { script, free } = gate();
  const { transport, runs } = app(script, { onContinue: () => 'here' });
  const iface = await transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({ iface: { ...iface, allowSteering: true }, transport });
  const leave = chat.subscribe(() => {});
  chat.setDraftText('first');
  const sent = chat.submit();
  await waitFor(() => runs.count === 1);
  chat.setDraftText('second');
  await chat.enqueue('steer');
  assertEquals(
    chat.getState().pendingMessages.map((m) => [m.kind, m.saved !== undefined]),
    [['steer', true]],
  );
  free();
  await sent;
  await waitFor(() => chat.getState().phase === 'idle' && !chat.getState().streaming);
  const state = chat.getState();
  assertEquals(runs.count, 2);
  assertEquals(state.pendingMessages, []);
  assertEquals(
    state.blocks.flatMap((b) =>
      b.kind === 'user-text' || b.kind === 'text' ? [[b.kind, b.text]] : [],
    ),
    [
      ['user-text', 'first'],
      ['text', 'Sure.'],
      ['user-text', 'second'],
      ['text', 'Sure.'],
    ],
  );
  leave();
});

Deno.test('a saved message whose reply cannot start lets the conversation go', async () => {
  const fixture = app(
    {},
    {
      intake: async () => {
        fixture.inbox.arrive(KEEPER, { id: itemId('m1'), kind: 'message', handovers: [] });
        await fixture.inbox.open(KEEPER, 'hold:m1');
        return {
          outcome: 'opened',
          ref: 'no-such-conversation',
          landsAs: landsAs('m1'),
          hold: 'hold:m1',
          blocks: [{ id: rowId('m1'), kind: 'user-text', text: 'hello' }],
        };
      },
    },
  );
  const { transport, run, runs, inbox } = fixture;
  const lines: ChatLine[] = [];
  await assertRejects(() =>
    run((onLine) =>
      transport.turn({ id: 'm1', input: { text: 'hello' } }, (line) => {
        lines.push(line);
        onLine(line);
      }),
    ),
  );
  assertEquals(conversationLines(lines).length, 1, 'the page did not learn the message was saved');
  assertEquals(runs.count, 0);
  assertEquals((await inbox.open(KEEPER, 'next')).outcome, 'opened', 'the hold was kept');
});

Deno.test('a steer the app saves lands in the running reply when the app takes it from its inbox', async () => {
  const { script, free } = gate();
  const fixture = app(script, {
    prepare: (turn, run) => ({
      ...turn,
      onStage: async ({ stage, step }) => {
        if (!run || stage !== 'before_end') return {};
        const taken = await run.take({ stage, step });
        return {
          injects: taken.map((item) => ({
            id: item.id,
            messages: [{ role: 'user' as const, content: 'second' }],
          })),
        };
      },
    }),
  });
  const { transport, run, runs, inbox, refOf } = fixture;
  const turn = run((onLine) =>
    transport.turn({ id: 'm1', turnId: 'turn-1', input: { text: 'first' } }, onLine),
  );
  await waitFor(() => runs.count === 1);
  await transport.steer({
    turnId: 'turn-1',
    id: 'm2',
    conversation: refOf(),
    input: { text: 'second' },
  });
  free();
  const lines = await turn;
  assertEquals(
    lines.flatMap((line) => (line.type === 'stage' ? (line.injected ?? []) : [])).map((i) => i.id),
    [itemId('m2')],
  );
  assertEquals(runs.count, 2, 'the model did not read the steer in the same reply');
  assertEquals(
    conversationLines(lines).flatMap((line) => line.opened ?? []),
    [itemId('m1')],
  );
  assertEquals(inbox.states(KEEPER).get(itemId('m2')), 'told');
});

Deno.test("a store that never marks a reply's told items fails the follow-up, and lets the conversation go", async () => {
  const errors: unknown[] = [];
  const { transport, run, runs, inbox } = app(
    {},
    { onContinue: () => 'here', onError: (err) => errors.push(err) },
    { marks: 'never marks told' },
  );
  await assertRejects(
    () =>
      run((onLine) =>
        transport.turn({ id: 'm1', turnId: 'turn-1', input: { text: 'first' } }, onLine),
      ),
    TheoremStreamError,
  );
  assertEquals(runs.count, 1, 'a follow-up told the same message again');
  assertEquals(
    errors.map((err) => (err instanceof TheoremError ? [err.kind, err.message] : err)),
    [
      [
        'config',
        "the reply's save did not mark its `told` items in the inbox: the store's `write` marks them",
      ],
    ],
  );
  assertEquals((await inbox.open(KEEPER, 'next')).outcome, 'opened', 'the conversation is held');
});

Deno.test('an item that arrives again under an id a reply told is new: the follow-up tells it', async () => {
  const errors: unknown[] = [];
  let again = true;
  const made = app(
    {},
    {
      onContinue: () => 'here',
      onError: (err) => errors.push(err),
      afterSave: () => {
        if (again) made.inbox.arrive(KEEPER, { id: itemId('m1'), kind: 'message', handovers: [] });
        again = false;
        return Promise.resolve();
      },
    },
  );
  await made.run((onLine) =>
    made.transport.turn({ id: 'm1', turnId: 'turn-1', input: { text: 'first' } }, onLine),
  );
  assertEquals(errors, []);
  assertEquals(made.runs.count, 2, 'no follow-up told the item that arrived again');
});

Deno.test("a page's stop reaches the reply under the hold the app's save took", async () => {
  const { script, free } = gate();
  let asked: string | undefined;
  let hear = () => {};
  const heard: string[] = [];
  const stop: HoldStop = {
    ask: () => {
      asked = 'hold:m1';
      hear();
      return Promise.resolve(true);
    },
    stopped: (_conversation, hold, over) => {
      heard.push(hold);
      return new Promise((resolve) => {
        hear = () => {
          if (asked === hold) resolve(true);
        };
        over.addEventListener('abort', () => resolve(false));
        hear();
      });
    },
    clear: () => {
      asked = undefined;
      return Promise.resolve();
    },
  };
  const { transport, run, runs, refOf } = app(script, {}, { stop });
  const turn = run((onLine) =>
    transport.turn({ id: 'm1', turnId: 'turn-1', input: { text: 'first' } }, onLine),
  );
  await waitFor(() => runs.count === 1);
  await transport.stop({ turnId: 'a-turn-the-host-never-ran' });
  await turn;
  free();
  assertEquals(heard, ['hold:m1']);
  assertEquals(asked, undefined, 'the stop outlived its reply');
  const view = await transport.conversation({ conversation: refOf() });
  const last = view.transcript.at(-1);
  assertEquals(last?.kind === 'turn-done' ? last.stop?.kind : undefined, 'cancelled');
});

Deno.test('a page opened while a reply runs elsewhere shows it working with what was said, and sends its queue once told it ended', async () => {
  const elsewhere: { running?: RunningReply } = {};
  const notifier = listenedNotifier();
  const made = app({}, { notifier }, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().runningElsewhere !== null);
  const working = chat.getState();
  assertEquals(working.phase, 'streaming');
  assertEquals(working.runningElsewhere?.since, 1_000);
  assertEquals(said(working.streamBlocks), [['user-text', 'second']]);

  chat.setDraftText('third');
  await chat.submit();
  assertEquals(
    chat.getState().pendingMessages.map((m) => [m.kind, m.draft.text]),
    [['queue', 'third']],
    'a message sent while it works waits in the queue',
  );
  assertEquals(made.runs.count, 1);

  await endElsewhere(made, elsewhere);
  await waitFor(() => notifier.sessions.length > 0);
  await notifier.publish(notifier.sessions[0]);
  await waitFor(() => made.runs.count === 2 && chat.getState().phase === 'idle');
  await waitFor(() => chat.getState().pendingMessages.length === 0);
  const ended = chat.getState();
  assertEquals(ended.runningElsewhere, null);
  assertEquals(said(ended.blocks), [
    ['user-text', 'first'],
    ['text', 'Sure.'],
    ['user-text', 'second'],
    ['text', 'Done.'],
    ['user-text', 'third'],
    ['text', 'Sure.'],
  ]);
  leave();
});

Deno.test("a page stops a reply that runs elsewhere through the app's stop, and its queue waits", async () => {
  const elsewhere: { running?: RunningReply } = {};
  const asked: string[] = [];
  const stop: HoldStop = {
    ask: (conversation) => {
      asked.push(conversation);
      return Promise.resolve(true);
    },
    stopped: (_conversation, _hold, over) =>
      new Promise((resolve) => over.addEventListener('abort', () => resolve(false))),
    clear: () => Promise.resolve(),
  };
  const made = app({}, {}, { elsewhere, stop });
  await runningElsewhere(made, elsewhere);
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  chat.setDraftText('later');
  await chat.submit();
  chat.stop();
  await waitFor(() => asked.length === 1);
  assertEquals(asked, [KEEPER]);

  await endElsewhere(made, elsewhere);
  await chat.refresh();
  await waitFor(() => chat.getState().phase === 'idle');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = chat.getState();
  assertEquals(stopped.failure, null);
  assertEquals(
    stopped.pendingMessages.map((m) => [m.kind, m.draft.text]),
    [['queue', 'later']],
    'a stopped reply sent the queue on',
  );
  assertEquals(made.runs.count, 1);
  leave();
});

Deno.test("a stop by the conversation, with no app stop, can't reach the reply and says so, not that it ended", async () => {
  const elsewhere: { running?: RunningReply } = {};
  const made = app({}, {}, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const refused = await assertRejects(() => made.transport.stop({ conversation: made.refOf() }));
  assert(refused instanceof TheoremStreamError);
  assertEquals(refused.copy, { key: 'session.reply_unreachable' });
});

Deno.test("a page whose stop can't reach the reply elsewhere shows why, keeps it working, sends nothing into it, and sends its queue when it ends", async () => {
  const elsewhere: { running?: RunningReply } = {};
  const made = app({}, {}, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  chat.setDraftText('later');
  await chat.submit();
  chat.stop();
  await waitFor(() => chat.getState().failure !== null);
  assertEquals(
    chat.getState().failure?.error,
    "Sorry, that reply can't be stopped or steered from here.",
  );
  assertEquals(chat.getState().phase, 'streaming', 'the reply it could not stop still runs');

  chat.setDraftText('instead');
  await chat.sendNow();
  assertEquals(
    chat.getState().draftText,
    'instead',
    'send now sent into a reply it could not stop',
  );
  const intakes = made.intakes.length;

  await endElsewhere(made, elsewhere);
  await chat.refresh();
  await waitFor(() => made.runs.count === 2 && chat.getState().phase === 'idle');
  await waitFor(() => chat.getState().pendingMessages.length === 0);
  assertEquals(made.intakes.length, intakes + 1, 'the queue did not send on');
  leave();
});

Deno.test("a page's steer to a reply that runs elsewhere goes by the conversation, and the app saves it", async () => {
  const elsewhere: { running?: RunningReply } = {};
  const made = app({}, {}, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface: { ...iface, allowSteering: true },
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  chat.setDraftText('also this');
  await chat.enqueue('steer');
  const [steered] = chat.getState().pendingMessages;
  assertEquals(chat.getState().failure, null);
  assertEquals([steered?.kind, steered?.saved?.landsAs], ['steer', landsAs(steered?.id ?? '')]);
  assertEquals(made.intakes.at(-1), steered?.id);
  assertEquals(made.runs.count, 1, 'the steer ran a reply of its own');
  leave();
});

Deno.test('a page reads the conversation again once the hold of the reply elsewhere lapses, with no word from the app', async () => {
  const elsewhere: { running?: RunningReply } = {};
  const made = app({}, {}, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const running = elsewhere.running;
  assert(running);
  elsewhere.running = { ...running, heldUntil: Date.now() + 30 };
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  // The server that ran it died: the hold lapses, and nothing is saved or told.
  elsewhere.running = undefined;
  await waitFor(() => chat.getState().phase === 'idle');
  assertEquals(chat.getState().runningElsewhere, null);
  assertEquals(chat.getState().streamBlocks, []);
  leave();
});

Deno.test('a page reads once when a hold it sees has lapsed by its own clock, not again on every read that still shows it', async () => {
  const held: { running?: RunningReply } = {};
  let reads = 0;
  const elsewhere = {
    get running() {
      reads++;
      return held.running;
    },
    set running(value: RunningReply | undefined) {
      held.running = value;
    },
  };
  const made = app({}, {}, { elsewhere });
  await runningElsewhere(made, elsewhere);
  const running = held.running;
  assert(running);
  // The server's clock runs behind the page's: the hold it says lives looks lapsed here.
  held.running = { ...running, heldUntil: Date.now() - 60_000 };
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  const before = reads;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(reads - before <= 1, `the page read ${reads - before} times for one lapsed hold`);
  assertEquals(chat.getState().phase, 'streaming');
  leave();
});

Deno.test("a page's send now stops the reply that runs elsewhere, then sends the message, which the app saves", async () => {
  const elsewhere: { running?: RunningReply } = {};
  const asked: string[] = [];
  const stop: HoldStop = {
    ask: (conversation) => {
      asked.push(conversation);
      return Promise.resolve(true);
    },
    stopped: (_conversation, _hold, over) =>
      new Promise((resolve) => over.addEventListener('abort', () => resolve(false))),
    clear: () => Promise.resolve(),
  };
  const made = app({}, {}, { elsewhere, stop });
  await runningElsewhere(made, elsewhere);
  const iface = await made.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({
    iface,
    transport: made.transport,
    conversation: made.refOf(),
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'streaming');
  chat.setDraftText('instead');
  await chat.sendNow();
  assertEquals(asked, [KEEPER]);
  const intake = made.intakes.at(-1);
  assert(intake !== undefined && intake !== 'm1', 'the app never saved the message');
  assertEquals(
    chat.getState().pendingMessages.map((m) => [m.draft.text, m.saved?.landsAs]),
    [['instead', landsAs(intake)]],
    'the message waits for the stopped reply to let the conversation go',
  );
  assertEquals(made.runs.count, 1);
  leave();
});

const NOT_ALLOWED = () =>
  new TheoremError('request', 'ref names an unusable document', {
    copy: { key: 'reason.not_allowed', params: { name: 'Q3' } },
  });

for (const [titled, labels, words] of [
  [
    'the label the host gives its reason',
    { 'reason.not_allowed': 'You cannot use {name}.' },
    'You cannot use Q3.',
  ],
  ["the host's words for any refusal", { 'request.refused': 'Not that one.' }, 'Not that one.'],
  ["Theorem's words when the reason has none", {}, "Sorry, that couldn't be accepted."],
] as const) {
  Deno.test(`a message the host refuses, sent or steered, reads as ${titled}`, async () => {
    const { transport, run, runs } = app(
      {},
      { profile: { ...PROFILE, labels }, intake: () => Promise.reject(NOT_ALLOWED()) },
    );
    for (const send of [
      () => run((onLine) => transport.turn({ id: 'm1', input: { text: 'hello' } }, onLine)),
      () => transport.steer({ turnId: 't', id: 'm2', input: { text: 'x' } }),
    ]) {
      const refused = await assertRejects(send, TheoremStreamError);
      assertEquals(clientFailure(refused).error, words);
      assertEquals(refused.kind, 'request');
    }
    assertEquals(runs.count, 0);
  });
}
