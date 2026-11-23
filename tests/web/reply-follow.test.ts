import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type TurnModel,
  z,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import {
  type ChatLine,
  type ConversationView,
  createHttpTransport,
  type RunningReply,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import {
  type ConversationCore,
  type CoreContext,
  createMemoryConversationStore,
  createMemoryNotifier,
  createMemoryReplyFeed,
  createMemorySessionStore,
  createTheoremConversationCore,
  createTheoremHandler,
  type Reply,
  type ReplyLine,
  type TheoremConversationStore,
  type TheoremNotifier,
  type TheoremReplyFeed,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

const KEEPER = 'person-1';
const LEASE_MS = 60_000;
const NOTE_TOOL = 'web_follow_note';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-follow',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

registerFixtureProviders(defaultKernelScope);
registerTool({
  type: 'function',
  name: NOTE_TOOL,
  description: 'Reads a note.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  input: z.strictObject({ name: z.string() }),
  output: z.object({ body: z.string() }),
  handler: () => Promise.resolve({ body: 'secret-fern' }),
});

/** What the next reply's model waits on: it says a first part, waits for `free`, then the rest. */
type Held = { until: Promise<void>; free(): void; reached: Promise<void>; reach(): void };

function held(): Held {
  let free = () => {};
  let reach = () => {};
  const until = new Promise<void>((resolve) => {
    free = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { until, free, reached, reach };
}

/** A model that answers at once, unless `script.held` is set: then it stops half way. */
function scripted(script: { held?: Held; tool?: boolean }): TurnModel {
  let calls = 0;
  return {
    complete: () =>
      (async function* () {
        calls += 1;
        const wait = script.held;
        if (script.tool && calls % 2 === 1) {
          yield {
            type: 'tool' as const,
            tool: { name: NOTE_TOOL, callId: `call_${calls}`, arguments: { name: 'secret-fern' } },
          };
          return;
        }
        yield { type: 'text' as const, text: wait ? 'Part one. ' : 'Sure.' };
        if (wait) {
          wait.reach();
          await wait.until;
          yield { type: 'text' as const, text: 'Part two.' };
        }
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
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

function at(sessionId = KEEPER): CoreContext {
  return { sessionId, signal: new AbortController().signal };
}

async function drain(lines: AsyncIterable<ReplyLine>): Promise<ReplyLine[]> {
  const seen: ReplyLine[] = [];
  for await (const line of lines) seen.push(line);
  return seen;
}

async function drainReply(reply: Reply): Promise<ReplyLine[]> {
  const seen: ReplyLine[] = [];
  for (;;) {
    const next = await reply.next();
    if (next.done) return seen;
    seen.push(next.value);
  }
}

function refOf(lines: readonly ReplyLine[]): string {
  let ref = '';
  for (const line of lines) if (line.type === 'conversation') ref = line.ref;
  assert(ref !== '', 'the run named no conversation');
  return ref;
}

/** A notifier that remembers what is published under each session. */
function countingNotifier(): TheoremNotifier & { published: string[] } {
  const base = createMemoryNotifier();
  const published: string[] = [];
  return {
    published,
    subscribe: (sessionId, changed) => base.subscribe(sessionId, changed),
    publish: (sessionId) => {
      published.push(sessionId);
      return base.publish(sessionId);
    },
  };
}

type Note = InboxItem<'note'>;
type CoreOptions = Partial<Parameters<typeof createTheoremConversationCore<Note>>[0]>;

function coreFor(script: { held?: Held; tool?: boolean }, options: CoreOptions = {}) {
  const notifier = countingNotifier();
  const feed = createMemoryReplyFeed();
  const core = createTheoremConversationCore<Note>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(scripted(script)),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    notifier,
    replyFeed: feed,
    ...options,
  });
  return { core, notifier, feed };
}

/** A conversation with one finished reply in it, and its ref. */
async function started(core: ConversationCore): Promise<string> {
  return refOf(await drainReply(await core.message(at(), { input: { text: 'first' } })));
}

Deno.test('the memory feed replays a reply from its first line, then goes live, then ends', async () => {
  const feed = createMemoryReplyFeed();
  const heard: string[] = [];
  const hear = (name: string) => ({
    line: (line: ReplyLine) => heard.push(`${name}:${line.type}`),
    end: () => heard.push(`${name}:end`),
  });
  await feed.start('c1', 'r1');
  await feed.append('c1', 'r1', { type: 'text', text: 'a' });
  const stopEarly = await feed.follow('c1', hear('early'));
  await feed.append('c1', 'r1', { type: 'text', text: 'b' });
  const stopLate = await feed.follow('c1', hear('late'));
  stopEarly();
  await feed.append('c1', 'r1', { type: 'text', text: 'c' });
  await feed.end('c1', 'r1');
  stopLate();
  assertEquals(heard, [
    'early:text',
    'early:text',
    'late:text',
    'late:text',
    'late:text',
    'late:end',
  ]);
  await feed.follow('c1', hear('after'));
  assertEquals(heard.at(-1), 'after:end', 'no reply runs: the follower is told at once');
});

Deno.test("the memory feed's new reply ends the old one's followers, and an old reply's end ends nothing new", async () => {
  const feed = createMemoryReplyFeed();
  const heard: string[] = [];
  await feed.start('c1', 'r1');
  await feed.follow('c1', { line: () => {}, end: () => heard.push('old') });
  await feed.start('c1', 'r2');
  await feed.follow('c1', { line: () => {}, end: () => heard.push('new') });
  await feed.end('c1', 'r1');
  await feed.append('c1', 'r1', { type: 'text', text: 'stale' });
  assertEquals(heard, ['old']);
  await feed.end('c1', 'r2');
  assertEquals(heard, ['old', 'new']);
});

Deno.test("a follower gets the starting reply's own lines from the first, joined mid-reply or not; the pages are told at its start and end", async () => {
  const script: { held?: Held } = {};
  const { core, notifier } = coreFor(script);
  const ref = await started(core);
  const before = notifier.published.length;
  script.held = held();
  const wait = script.held;
  const own = drainReply(await core.message(at(), { ref, input: { text: 'second' } }));
  await wait.reached;
  assertEquals(notifier.published.length, before + 1, 'the pages are told when the reply starts');
  const joined = drain(await core.follow(at(), { ref }));
  wait.free();
  const ownLines = await own;
  assertEquals(await joined, ownLines);
  assert(ownLines.some((line) => line.type === 'text'));
  assertEquals(notifier.published.length, before + 2, 'and when it ends');
});

Deno.test('a follower that joins when no reply runs is ended at once', async () => {
  const { core } = coreFor({});
  const ref = await started(core);
  assertEquals(await drain(await core.follow(at(), { ref })), []);
});

Deno.test("a follower does not read another session's conversation, and the follow stops when its request does", async () => {
  const { core } = coreFor({});
  const ref = await started(core);
  await assertRejects(() => core.follow(at('someone-else'), { ref }));
  const script: { held?: Held } = { held: held() };
  const second = coreFor(script);
  const secondRef = await (async () => {
    script.held = undefined;
    const made = await started(second.core);
    script.held = held();
    return made;
  })();
  const abort = new AbortController();
  const own = drainReply(await second.core.message(at(), { ref: secondRef, input: { text: 'x' } }));
  await script.held?.reached;
  const follower = await second.core.follow(
    { sessionId: KEEPER, signal: abort.signal },
    { ref: secondRef },
  );
  const read = drain(follower);
  abort.abort();
  await read;
  script.held?.free();
  await own;
});

Deno.test("a feed that throws never changes the reply, and its error goes to the app's onError", async () => {
  const errors: unknown[] = [];
  const broken: TheoremReplyFeed = {
    start: () => Promise.reject(new Error('feed down')),
    append: () => {
      throw new Error('feed down');
    },
    end: () => Promise.reject(new Error('feed down')),
    follow: () => () => {},
  };
  const { core } = coreFor({}, { replyFeed: broken, onError: (err) => errors.push(err) });
  const lines = await drainReply(await core.message(at(), { input: { text: 'hello' } }));
  assert(lines.some((line) => line.type === 'text'));
  assert(errors.length >= 3);
});

Deno.test('a reply the caller stops reading still ends in the feed', async () => {
  const script: { held?: Held } = { held: held() };
  const { core, feed } = coreFor(script);
  const reply = await core.message(at(), { input: { text: 'hello' } });
  await reply.next();
  const ends: string[] = [];
  const sink = { line: () => {}, end: () => ends.push('end') };
  await reply.return({ outcome: 'released' });
  // why: the conversation id is the feed's key; a follower on a reply that is over is ended at once.
  const first = await feed.follow('unknown', sink);
  first();
  assertEquals(ends, ['end']);
});

Deno.test('a feed with no notifier is refused at setup, and a core without a feed refuses to follow', async () => {
  assertThrows(() =>
    createTheoremHandler({
      operationRetentionMs: TEST_OPERATION_RETENTION_MS,
      profile: PROFILE,
      provider: () => fixtureHostOptions(scripted({})),
      conversationStore: createMemoryConversationStore(),
      replyFeed: createMemoryReplyFeed(),
    }),
  );
  const core = createTheoremConversationCore<Note>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(scripted({})),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
  });
  const ref = await started(core);
  await assertRejects(() => core.follow(at(), { ref }));
});

Deno.test('the conversation read offers the follow only when the host has a feed', async () => {
  const withFeed = coreFor({});
  const ref = await started(withFeed.core);
  const view = await withFeed.core.read(at(), { ref });
  assertEquals(view.follow, true);
  assertEquals(typeof view.notify, 'object');
  const without = coreFor({}, { replyFeed: undefined, notifier: undefined });
  const plain = await without.core.read(at(), { ref: await started(without.core) });
  assertEquals(plain.follow, undefined);
});

Deno.test('a wake the app runs through the core, with no page request, reaches a follower and the pages', async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const script: { held?: Held } = {};
  const { core, notifier } = coreFor(script, {
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items: readonly { id: string }[]) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
    }),
  } as CoreOptions);
  const ref = await started(core);
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const before = notifier.published.length;
  script.held = held();
  const wait = script.held;
  const run = await core.wake(at(), { ref });
  const own = drainReply(run);
  await wait.reached;
  assertEquals(notifier.published.length, before + 1);
  const joined = drain(await core.follow(at(), { ref }));
  wait.free();
  const lines = await own;
  assertEquals(await joined, lines);
  assert(lines.some((line) => line.type === 'text' && line.text === 'Part one. '));
});

// ---- A page on the handler follows a reply another page starts, and one the app runs ----

/** A store that says a reply runs while the test says so, as an app's store does under its hold. */
function runningStore(live: { running?: RunningReply }): TheoremConversationStore {
  const memory = createMemoryConversationStore();
  return {
    ...memory,
    read: async (sessionId, ref) => {
      const snapshot = await memory.read(sessionId, ref);
      return snapshot && live.running ? { ...snapshot, running: live.running } : snapshot;
    },
    write: async (sessionId, ref, expected, next, context) => {
      const result = await memory.write(sessionId, ref, expected, next, context);
      if (result.written && context?.ended) live.running = undefined;
      return result;
    },
  };
}

function pageOn(handler: (request: Request) => Promise<Response>): TheoremTransport {
  return createHttpTransport({
    endpoint: 'https://app.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
}

const textsOf = (blocks: readonly { kind: string; text?: string }[]) =>
  blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []));

function shared(script: { held?: Held; tool?: boolean }, profile: ProfileDefinition = PROFILE) {
  const live: { running?: RunningReply } = {};
  const notifier = countingNotifier();
  const feed = createMemoryReplyFeed();
  const store = runningStore(live);
  const sessionStore = createMemorySessionStore();
  const handler = createTheoremHandler({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile,
    provider: () => fixtureHostOptions(scripted(script)),
    conversationStore: store,
    sessionStore,
    session: () => KEEPER,
    notifier,
    replyFeed: feed,
  });
  return { live, notifier, feed, store, sessionStore, handler };
}

Deno.test('page B draws the reply page A started, live, with stop and steer still by conversation, then reads the saved conversation', async () => {
  const script: { held?: Held } = {};
  const { live, handler } = shared(script);
  const a = pageOn(handler);
  const b = pageOn(handler);
  let ref = '';
  await a.turn({ input: { text: 'first' } }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  const iface = await b.describe();
  assert(iface.type === 'text');
  const stops: unknown[] = [];
  const chatB = createChatController({
    iface,
    transport: {
      ...b,
      stop: (request) => {
        stops.push(request);
        return b.stop(request);
      },
    },
    conversation: ref,
  });
  const leave = chatB.subscribe(() => {});
  await waitFor(() => chatB.getState().blocks.length > 0);

  script.held = held();
  const wait = script.held;
  live.running = { since: 5_000, prompt: [], heldUntil: Date.now() + LEASE_MS };
  const linesA: ChatLine[] = [];
  const turnA = a.turn({ conversation: ref, input: { text: 'second' } }, (line) =>
    linesA.push(line),
  );
  await wait.reached;
  await waitFor(() => textsOf(chatB.getState().streamBlocks).join('') === 'Part one. ');
  const mid = chatB.getState();
  assertEquals(mid.phase, 'streaming');
  assertEquals(mid.streaming, true);
  assertEquals(mid.runningElsewhere?.since, 5_000);

  wait.free();
  await turnA;
  await waitFor(() => chatB.getState().runningElsewhere === null);
  const after = chatB.getState();
  assertEquals(after.streaming, false);
  assertEquals(textsOf(after.blocks), ['Sure.', 'Part one. Part two.']);
  assertEquals(after.streamBlocks, []);
  assertEquals(stops, []);
  leave();
});

Deno.test("page B's stop goes by the conversation while it follows", async () => {
  const script: { held?: Held } = {};
  const { live, handler } = shared(script);
  const a = pageOn(handler);
  const b = pageOn(handler);
  let ref = '';
  await a.turn({ input: { text: 'first' } }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  const iface = await b.describe();
  assert(iface.type === 'text');
  const stops: unknown[] = [];
  const chatB = createChatController({
    iface,
    transport: {
      ...b,
      stop: (request) => {
        stops.push(request);
        return Promise.reject(new Error('this host does not run it'));
      },
    },
    conversation: ref,
  });
  const leave = chatB.subscribe(() => {});
  script.held = held();
  const wait = script.held;
  live.running = { since: 6_000, prompt: [], heldUntil: Date.now() + LEASE_MS };
  const turnA = a.turn({ conversation: ref, input: { text: 'second' } }, () => {});
  await wait.reached;
  await waitFor(() => textsOf(chatB.getState().streamBlocks).length > 0);
  chatB.stop();
  await waitFor(() => stops.length === 1);
  assertEquals(stops, [{ conversation: ref }]);
  wait.free();
  await turnA;
  leave();
});

Deno.test('page B follows a reply the app runs through the core, with no page request', async () => {
  const script: { held?: Held } = {};
  const { live, handler, notifier, feed, store, sessionStore } = shared(script);
  const b = pageOn(handler);
  const core = createTheoremConversationCore<Note>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(scripted(script)),
    conversationStore: store,
    sessionStore,
    notifier,
    replyFeed: feed,
  });
  const ref = await started(core);
  const iface = await b.describe();
  assert(iface.type === 'text');
  const chatB = createChatController({ iface, transport: b, conversation: ref });
  const leave = chatB.subscribe(() => {});
  await waitFor(() => chatB.getState().blocks.length > 0);

  script.held = held();
  const wait = script.held;
  live.running = { since: 7_000, prompt: [], heldUntil: Date.now() + LEASE_MS };
  const own = drainReply(await core.message(at(), { ref, input: { text: 'from the channel' } }));
  await wait.reached;
  await waitFor(() => textsOf(chatB.getState().streamBlocks).join('') === 'Part one. ');
  wait.free();
  await own;
  await waitFor(() => chatB.getState().runningElsewhere === null);
  assertEquals(textsOf(chatB.getState().blocks), ['Sure.', 'Part one. Part two.']);
  leave();
});

Deno.test('the follow stream is the reply stream line for line, and under showData: false it sends no call data', async () => {
  const script: { held?: Held; tool?: boolean } = { tool: true };
  const { handler } = shared(script, {
    ...PROFILE,
    id: 'web-follow-hidden',
    tools: { allow: [NOTE_TOOL], showData: false },
  });
  const a = pageOn(handler);
  const b = pageOn(handler);
  let ref = '';
  await a.turn({ input: { text: 'first' } }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  script.held = held();
  const wait = script.held;
  const own: ChatLine[] = [];
  const turnA = a.turn({ conversation: ref, input: { text: 'second' } }, (line) => own.push(line));
  await wait.reached;
  const followed: ChatLine[] = [];
  const follow = b.follow?.({ conversation: ref }, (line) => followed.push(line));
  wait.free();
  await turnA;
  await follow;
  assertEquals(followed, own);
  assertEquals(JSON.stringify(followed).includes('secret-fern'), false);
});

Deno.test('a handler with no feed refuses /follow', async () => {
  const handler = createTheoremHandler({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(scripted({})),
    conversationStore: createMemoryConversationStore(),
    session: () => KEEPER,
  });
  const b = pageOn(handler);
  await assertRejects(() => b.follow?.({ conversation: 'x' }, () => {}) ?? Promise.reject());
});

// ---- The chat on a fake host ----

type FakeHost = {
  transport: TheoremTransport;
  reads: number;
  follows: { onLine: (line: ChatLine) => void; end(): void; signal?: AbortSignal }[];
  stops: unknown[];
  view: ConversationView;
  ping(): void;
};

function fakeHost(view: ConversationView, features: { follow?: boolean } = {}): FakeHost {
  const pings: (() => void)[] = [];
  const host: FakeHost = {
    reads: 0,
    follows: [],
    stops: [],
    view,
    ping: () => {
      for (const changed of pings) changed();
    },
    transport: {
      describe: () => Promise.reject(new Error('unused')),
      turn: () => Promise.reject(new Error('unused')),
      invoke: () => Promise.reject(new Error('unused')),
      steer: () => Promise.resolve({}),
      stop: (request) => {
        host.stops.push(request);
        return Promise.resolve();
      },
      conversation: () => {
        host.reads += 1;
        return Promise.resolve(host.view);
      },
      rewind: () => Promise.reject(new Error('unused')),
      notify: (changed, signal) =>
        new Promise<void>((resolve) => {
          pings.push(changed);
          signal.addEventListener('abort', () => resolve());
        }),
      ...(features.follow === false
        ? {}
        : {
            follow: (_request, onLine, signal) =>
              new Promise<void>((resolve) => {
                host.follows.push({ onLine, end: resolve, signal });
                signal?.addEventListener('abort', () => resolve());
              }),
          }),
    },
  };
  return host;
}

async function textInterface() {
  const handler = createTheoremHandler({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(scripted({})),
    conversationStore: createMemoryConversationStore(),
  });
  const iface = await pageOn(handler).describe();
  assert(iface.type === 'text');
  return iface;
}

const RUNNING: RunningReply = {
  since: 9_000,
  prompt: [{ id: 'u1', kind: 'user-text', text: 'ask' }],
  heldUntil: Date.now() + LEASE_MS,
};
const OFFERED: ConversationView = {
  transcript: [],
  running: RUNNING,
  notify: {},
  follow: true,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

Deno.test('a page that sees a reply it did not start follows its lines over the prompt, and reads the conversation when they end', async () => {
  const host = fakeHost(OFFERED);
  const chat = createChatController({
    iface: await textInterface(),
    transport: host.transport,
    conversation: 'ref-1',
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => host.follows.length === 1);
  host.follows[0].onLine({ type: 'text', text: 'Hel' });
  host.follows[0].onLine({ type: 'text', text: 'lo' });
  await waitFor(() => textsOf(chat.getState().streamBlocks).join('') === 'Hello');
  const state = chat.getState();
  assertEquals(state.streaming, true);
  assertEquals(state.phase, 'streaming');
  assertEquals(state.runningElsewhere?.since, 9_000);
  assertEquals(state.streamBlocks[0].kind, 'user-text');
  const reads = host.reads;
  host.view = { transcript: [{ id: 't1', kind: 'text', text: 'Hello' }], follow: true, notify: {} };
  host.follows[0].end();
  await waitFor(() => chat.getState().runningElsewhere === null);
  assertEquals(host.reads, reads + 1);
  assertEquals(chat.getState().streaming, false);
  assertEquals(textsOf(chat.getState().blocks), ['Hello']);
  leave();
});

Deno.test('a page stops a followed reply by the conversation, and does not follow when the host offers no follow', async () => {
  const host = fakeHost(OFFERED);
  const chat = createChatController({
    iface: await textInterface(),
    transport: host.transport,
    conversation: 'ref-1',
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => host.follows.length === 1);
  chat.stop();
  await waitFor(() => host.stops.length === 1);
  assertEquals(host.stops, [{ conversation: 'ref-1' }]);
  leave();

  const plain = fakeHost({ transcript: [], running: RUNNING, notify: {} });
  const unoffered = createChatController({
    iface: await textInterface(),
    transport: plain.transport,
    conversation: 'ref-1',
  });
  const leaveUnoffered = unoffered.subscribe(() => {});
  await waitFor(() => plain.reads > 0);
  await settle();
  assertEquals(plain.follows.length, 0);
  assertEquals(unoffered.getState().runningElsewhere?.since, 9_000);
  leaveUnoffered();

  const none = fakeHost(OFFERED, { follow: false });
  const noTransport = createChatController({
    iface: await textInterface(),
    transport: none.transport,
    conversation: 'ref-1',
  });
  const leaveNone = noTransport.subscribe(() => {});
  await waitFor(() => none.reads > 0);
  await settle();
  assertEquals(noTransport.getState().runningElsewhere?.since, 9_000);
  leaveNone();
});

Deno.test('a follow that ends with no line does not read again by itself, and the push that comes later follows', async () => {
  const host = fakeHost(OFFERED);
  const chat = createChatController({
    iface: await textInterface(),
    transport: host.transport,
    conversation: 'ref-1',
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => host.follows.length === 1);
  const reads = host.reads;
  host.follows[0].end();
  await settle();
  assertEquals(host.reads, reads, 'no line came, so nothing changed to read');
  assertEquals(host.follows.length, 1);
  host.ping();
  await waitFor(() => host.follows.length === 2);
  host.follows[1].onLine({ type: 'text', text: 'Hi' });
  await waitFor(() => textsOf(chat.getState().streamBlocks).join('') === 'Hi');
  leave();
});

Deno.test('a page follows only while someone is here to see it, and stops when the reply is gone from the read', async () => {
  const host = fakeHost(OFFERED);
  const chat = createChatController({
    iface: await textInterface(),
    transport: host.transport,
    conversation: 'ref-1',
  });
  const leave = chat.subscribe(() => {});
  await waitFor(() => host.follows.length === 1);
  host.follows[0].onLine({ type: 'text', text: 'Hi' });
  await waitFor(() => chat.getState().streaming);
  leave();
  assertEquals(host.follows[0].signal?.aborted, true);
  assertEquals(chat.getState().streaming, false);
  const again = chat.subscribe(() => {});
  assertEquals(host.follows.length, 1, 'the same reply is not read twice');
  host.view = { transcript: [], follow: true, notify: {} };
  await chat.refresh();
  assertEquals(chat.getState().runningElsewhere, null);
  again();
});
