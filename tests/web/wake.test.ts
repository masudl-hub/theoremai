import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type ModelRequest,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnModel,
  z,
} from '../../mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import {
  type ChatLine,
  createHttpTransport,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createMemorySessionStore,
  createTheoremHandler,
  type TheoremHandlerOptions,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_wake_job';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-wake',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const held = { until: Promise.resolve(), free: () => {} };

registerFixtureProviders(defaultKernelScope);
registerTool({
  type: 'function',
  name: TOOL,
  description: 'A slow job.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  background: 'always',
  input: z.strictObject({}),
  output: z.object({ done: z.string() }),
  handler: async () => {
    await held.until;
    return { done: 'the-woken-answer' };
  },
});

/**
 * A model that calls the job on its first step and answers in text after. It keeps every request;
 * `fail` makes the next step after the first throw.
 */
function caller(seen: ModelRequest[], script: { fail: boolean; gate?: Promise<void> }): TurnModel {
  let step = 0;
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        step += 1;
        if (step === 1) {
          yield { type: 'tool' as const, tool: { name: TOOL, callId: 'call_1', arguments: {} } };
          return;
        }
        await script.gate;
        if (script.fail) throw new Error('the-model-broke');
        yield { type: 'text' as const, text: 'It finished.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function harness(options: Partial<TheoremHandlerOptions> = {}) {
  held.until = new Promise<void>((resolve) => {
    held.free = resolve;
  });
  const handles: ToolBackgroundHandle[] = [];
  const seen: ModelRequest[] = [];
  const script: { fail: boolean; gate?: Promise<void> } = { fail: false };
  const model = caller(seen, script);
  const handler = createTheoremHandler({
    profile: PROFILE,
    provider: () => fixtureHostOptions(model),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    session: () => 'one-person',
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
    ...options,
  });
  const transport: TheoremTransport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  return { transport, handles, seen, script };
}

async function say(transport: TheoremTransport, text: string, conversation?: string) {
  let ref = conversation ?? '';
  await transport.turn({ input: { text }, ...(conversation ? { conversation } : {}) }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  return ref;
}

/** Wakes the conversation: its lines, and the ref it left (the same one when it wrote nothing). */
async function wake(transport: TheoremTransport, ref: string) {
  const lines: ChatLine[] = [];
  let next = ref;
  await transport.wake?.({ conversation: ref }, (line) => {
    lines.push(line);
    if (line.type === 'conversation') next = line.ref;
  });
  return { lines, ref: next };
}

const reads = (seen: ModelRequest[], from: number) =>
  seen.slice(from).filter((req) => JSON.stringify(req).includes('the-woken-answer')).length;

const lateBlocks = async (transport: TheoremTransport, ref: string) =>
  (await transport.conversation({ conversation: ref })).transcript.filter(
    (block) => block.kind === 'late-results',
  ).length;

Deno.test('a wake replies to a result that ended, once, with no message', async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    assertEquals((await transport.conversation({ conversation: ref })).wake, undefined);
    held.free();
    await handles[0].done;
    assertEquals((await transport.conversation({ conversation: ref })).wake, true);
    const before = seen.length;
    const woke = await wake(transport, ref);
    assertEquals(seen.length - before, 1, 'the wake ran the model once');
    assert(reads(seen, before) > 0, 'the wake did not read the result');
    assert(woke.lines.some((line) => line.type === 'text'));
    const view = await transport.conversation({ conversation: woke.ref });
    assertEquals(view.wake, undefined);
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
    assertEquals(
      view.transcript.filter((b) => b.kind.startsWith('user-')).length,
      1,
      'a wake posts no message',
    );
    const again = await wake(transport, woke.ref);
    assertEquals(again.lines, []);
    assertEquals(seen.length - before, 1, 'a second wake ran the model');
  } finally {
    held.free();
  }
});

Deno.test('a wake does nothing while the call still runs', async () => {
  const { transport, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    const before = seen.length;
    assertEquals((await wake(transport, ref)).lines, []);
    assertEquals(seen.length, before);
  } finally {
    held.free();
  }
});

Deno.test('two wakes at once run the model once', async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    const [one, two] = await Promise.all([wake(transport, ref), wake(transport, ref)]);
    assertEquals(seen.length - before, 1);
    assertEquals([one.lines.length > 0, two.lines.length > 0].filter(Boolean).length, 1);
  } finally {
    held.free();
  }
});

Deno.test('a wake that fails is not tried again, and the next message reads the result', async () => {
  const { transport, handles, seen, script } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    script.fail = true;
    let left = ref;
    await transport
      .wake?.({ conversation: ref }, (line) => {
        if (line.type === 'conversation') left = line.ref;
      })
      .catch(() => {});
    script.fail = false;
    const view = await transport.conversation({ conversation: left });
    assertEquals(view.wake, undefined, 'a failed wake would wake again');
    const before = seen.length;
    assertEquals((await wake(transport, left)).lines, []);
    assertEquals(seen.length, before);
    const next = await say(transport, 'any news?', left);
    assertEquals(await lateBlocks(transport, next), 1);
  } finally {
    held.free();
  }
});

Deno.test('a wake the host refuses runs nothing, and the next message reads the result', async () => {
  const { transport, handles, seen } = harness({ authorizeWake: () => false });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    assertEquals((await wake(transport, ref)).lines, []);
    assertEquals(seen.length, before);
    assertEquals((await transport.conversation({ conversation: ref })).wake, undefined);
    const next = await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0);
    assertEquals(await lateBlocks(transport, next), 1);
  } finally {
    held.free();
  }
});

Deno.test('a message sent while a wake runs keeps the conversation; the wake writes nothing', async () => {
  const { transport, handles, seen, script } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    let release = () => {};
    script.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waking = wake(transport, ref).then(
      () => 'committed',
      () => 'refused',
    );
    while (seen.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    script.gate = undefined;
    const sent = say(transport, 'hello?', ref);
    release();
    const next = await sent;
    assertEquals(await waking, 'committed', 'the wake failed instead of ending quietly');
    const view = await transport.conversation({ conversation: next });
    assertEquals(view.transcript.filter((b) => b.kind === 'user-text').length, 2);
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    held.free();
  }
});

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

const texts = (chat: ReturnType<typeof createChatController>) =>
  chat.getState().blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : []));

Deno.test('an open page wakes on its own when a call ends, and draws the reply', async () => {
  const { transport, handles, seen } = harness({ notifier: createMemoryNotifier() });
  try {
    const iface = await transport.describe();
    assert(iface.type === 'text');
    const chat = createChatController({ iface, transport });
    const leave = chat.subscribe(() => {});
    await chat.sendText('start the job');
    await waitFor(() => chat.getState().phase === 'idle');
    const before = seen.length;
    held.free();
    await handles[0].done;
    await waitFor(
      () =>
        chat.getState().blocks.some((block) => block.kind === 'late-results') &&
        chat.getState().phase === 'idle' &&
        !chat.getState().streaming,
    );
    assertEquals(reads(seen, before), 1, 'the page woke more than once, or never');
    assertEquals(texts(chat).at(-1), 'It finished.');
    assertEquals(chat.getState().failure, null);
    await chat.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(seen.length - before, 1, 'a read after the wake woke it again');
    leave();
  } finally {
    held.free();
  }
});

Deno.test('a page opened after the call ended wakes once it draws the conversation', async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const iface = await transport.describe();
    assert(iface.type === 'text');
    const before = seen.length;
    const chat = createChatController({ iface, transport, conversation: ref });
    const leave = chat.subscribe(() => {});
    await waitFor(
      () =>
        chat.getState().blocks.some((block) => block.kind === 'late-results') &&
        !chat.getState().streaming,
    );
    assertEquals(seen.length - before, 1);
    leave();
  } finally {
    held.free();
  }
});
