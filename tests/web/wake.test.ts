import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type LateResultEnded,
  labelText,
  type ModelRequest,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnEvent,
  type TurnModel,
  z,
} from '../../mod.ts';
import type { PolicyMoment } from '../../src/conversation/mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import {
  type ChatLine,
  createHttpTransport,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import { issuedOperationId } from '../../web/src/client/turn-client.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createMemorySessionStore,
  createTheoremHandler,
  type TheoremHandlerOptions,
  tellEveryResult,
} from '../../web/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_wake_job';
const ASK = 'web_wake_ask';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-wake',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL, ASK] },
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

registerTool({
  type: 'function',
  name: ASK,
  description: 'Asks first.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.strictObject({}),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

type Script = { fail: boolean; gate?: Promise<void>; askAt?: number };

/**
 * A model that calls the job on its first step and answers in text after. It keeps every request;
 * `fail` makes the next step after the first throw; `askAt` calls the gated tool on that step.
 */
function caller(seen: ModelRequest[], script: Script): TurnModel {
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
        if (step === script.askAt) {
          yield { type: 'tool' as const, tool: { name: ASK, callId: 'ask_1', arguments: {} } };
          return;
        }
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
  const script: Script = { fail: false };
  const model = caller(seen, script);
  const handler = createTheoremHandler({
    profile: PROFILE,
    provider: () => fixtureHostOptions(model),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    session: () => 'one-person',
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
    lateResultsDecider: tellEveryResult,
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

/** A failure the handler reported for results the policy gave up. */
const givenUp = (err: unknown) =>
  err instanceof Error &&
  typeof err.cause === 'object' &&
  err.cause !== null &&
  'code' in err.cause &&
  err.cause.code === 'late_results_given_up';

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

Deno.test('a wake that fails lets its result go: the chat wakes again and reads it once', async () => {
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
    assertEquals(view.wake, true, 'a failed wake kept its result from waking the chat');
    const before = seen.length;
    const woke = await wake(transport, left);
    assert(reads(seen, before) > 0, 'the second wake did not read the result');
    assertEquals(await lateBlocks(transport, woke.ref), 1);
  } finally {
    held.free();
  }
});

Deno.test('a result the model keeps failing on is read twice, then given up and reported once', async () => {
  const errors: unknown[] = [];
  const { transport, handles, seen, script } = harness({ onError: (err) => errors.push(err) });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    script.fail = true;
    const before = seen.length;
    let left = ref;
    for (let tries = 0; tries < 2; tries += 1) {
      assertEquals((await transport.conversation({ conversation: left })).wake, true);
      await transport
        .wake?.({ conversation: left }, (line) => {
          if (line.type === 'conversation') left = line.ref;
        })
        .catch(() => {});
    }
    assertEquals(reads(seen, before), 2, 'the result was not read exactly twice');
    const view = await transport.conversation({ conversation: left });
    assertEquals(view.wake, undefined, 'a given-up result still wakes the chat');
    assertEquals((await wake(transport, left)).lines, []);
    assertEquals(seen.length - before, 2, 'the model ran again after the result was given up');
    const given = errors.filter(givenUp);
    assertEquals(given.length, 1, 'the give-up was not reported once');
  } finally {
    held.free();
  }
});

Deno.test('a server wake whose model keeps failing tries twice, then gives the result up', async () => {
  let ref = '';
  let woken: Promise<void> | undefined;
  const errors: unknown[] = [];
  const { transport, handles, seen, script } = harness({
    onError: (err) => errors.push(err),
    lateResultsDecider: {
      ...tellEveryResult,
      ended: (end) => {
        woken = end.wake(ref);
        return woken;
      },
    },
  });
  try {
    ref = await say(transport, 'start the job');
    script.fail = true;
    const before = seen.length;
    held.free();
    await handles[0].done;
    await waitFor(() => woken !== undefined);
    await woken?.catch(() => {});
    assertEquals(reads(seen, before), 2, 'the server wake did not read the result exactly twice');
    const after = await transport.conversation({ conversation: ref });
    assertEquals(after.wake, undefined);
    const given = errors.filter(givenUp);
    assertEquals(given.length, 1);
  } finally {
    held.free();
  }
});

Deno.test('a server wake that finds a reply running is told once that reply ends, with no page and no message', async () => {
  let ref = '';
  let woken: Promise<void> | undefined;
  const { transport, handles, seen, script } = harness({
    conversationLeaseMs: 150,
    lateResultsDecider: {
      ...tellEveryResult,
      ended: (end) => {
        woken = end.wake(ref);
        return woken;
      },
    },
  });
  try {
    ref = await say(transport, 'start the job');
    let release = () => {};
    script.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked = seen.length;
    const sent = say(transport, 'hello?', ref);
    await waitFor(() => seen.length > asked);
    held.free();
    await handles[0].done;
    await waitFor(() => woken !== undefined);
    await woken;
    script.gate = undefined;
    release();
    ref = await sent;
    await waitFor(() => reads(seen, asked) > 0);
    assertEquals(await lateBlocks(transport, ref), 1);
  } finally {
    held.free();
  }
});

Deno.test('with no decider, nothing tells the model: no wake, and no message reads the result', async () => {
  const { transport, handles, seen } = harness({ lateResultsDecider: undefined });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    assertEquals((await transport.conversation({ conversation: ref })).wake, undefined);
    const before = seen.length;
    assertEquals((await wake(transport, ref)).lines, []);
    assertEquals(seen.length, before, 'a wake ran the model');
    const next = await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0, 'the message read the result');
    assertEquals(await lateBlocks(transport, next), 0);
  } finally {
    held.free();
  }
});

Deno.test('the decider gives each reply its results, and what it holds back stays for later', async () => {
  const asked: (PolicyMoment & { items: number })[] = [];
  let giving = false;
  const { transport, handles, seen } = harness({
    lateResultsDecider: {
      policy: (items, moment) => {
        asked.push({ ...moment, items: items.length });
        return { tell: giving ? items.map((item) => item.id) : [] };
      },
    },
  });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    assertEquals((await transport.conversation({ conversation: ref })).wake, undefined);
    assertEquals(asked.at(-1), { stage: 'pre_turn', step: 0, opening: 'wake', items: 1 });
    const before = seen.length;
    assertEquals((await wake(transport, ref)).lines, []);
    assertEquals(seen.length, before, 'a wake given nothing ran the model');
    asked.length = 0;
    const held1 = await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0, 'a message read a result the decider held back');
    assertEquals(asked[0], { stage: 'pre_turn', step: 0, opening: 'message', items: 1 });
    assertEquals(asked.at(-1), { stage: 'pre_turn', step: 0, opening: 'follow_up', items: 1 });
    giving = true;
    assertEquals((await transport.conversation({ conversation: held1 })).wake, true);
    const woke = await wake(transport, held1);
    assert(reads(seen, before) > 0, 'the wake did not read the result');
    assertEquals(await lateBlocks(transport, woke.ref), 1);
  } finally {
    held.free();
  }
});

Deno.test('a decider wakes the chat from the server when a call ends, with no page', async () => {
  const ended: LateResultEnded[] = [];
  let ref = '';
  let woken: Promise<void> | undefined;
  const { transport, handles, seen } = harness({
    host: () => ({ person: 'the-asker' }),
    lateResultsDecider: {
      ...tellEveryResult,
      ended: (end) => {
        ended.push(end);
        woken = end.wake(ref);
        return woken;
      },
    },
  });
  try {
    ref = await say(transport, 'start the job');
    assertEquals((await transport.conversation({ conversation: ref })).wake, undefined);
    const before = seen.length;
    held.free();
    await handles[0].done;
    await waitFor(() => woken !== undefined);
    await woken;
    assertEquals(ended.length, 1);
    assertEquals(ended[0].host, { person: 'the-asker' });
    assertEquals(ended[0].result.outcome.event.tool.name, TOOL);
    assertEquals(seen.length - before, 1, 'the server wake ran the model once');
    assertEquals(await lateBlocks(transport, ref), 1);
    assertEquals((await wake(transport, ref)).lines, [], 'a page woke it again');
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

/**
 * A message reads the chat, then the wake it takes the chat over from lands its save first.
 * `pauses` makes the wake stop on an approval. Gives the chat as the message left it, or the
 * message's failure, and how the wake ended.
 */
async function messageOverSavingWake(pauses: boolean) {
  const store = createMemoryConversationStore();
  /** Runs once, on the next read, before that read returns what it read. */
  let afterRead: (() => Promise<void>) | undefined;
  const conversationStore: typeof store = {
    ...store,
    async read(sessionId, ref) {
      const snapshot = await store.read(sessionId, ref);
      const hook = afterRead;
      afterRead = undefined;
      if (hook) await hook();
      return snapshot;
    },
  };
  const { transport, handles, seen, script } = harness({ conversationStore });
  if (pauses) script.askAt = 3;
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    let release = () => {};
    script.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = seen.length;
    const waking = wake(transport, ref).then(
      () => 'committed',
      () => 'refused',
    );
    while (seen.length === before) await new Promise((resolve) => setTimeout(resolve, 1));
    script.gate = undefined;
    afterRead = async () => {
      release();
      await waking;
    };
    const sent = await say(transport, 'hello?', ref).then(
      (next) => ({ next }),
      (failure: unknown) => ({ failure }),
    );
    const view = await transport.conversation({
      conversation: 'next' in sent ? sent.next : ref,
    });
    return { sent, view, woke: await waking };
  } finally {
    held.free();
  }
}

Deno.test("a message that reads the chat as a wake saves posts after the wake's reply", async () => {
  const { sent, view, woke } = await messageOverSavingWake(false);
  assert('next' in sent, 'the message failed because the wake saved first');
  assertEquals(woke, 'committed');
  const kinds = view.transcript.map((b) => b.kind);
  assertEquals(kinds.filter((kind) => kind === 'user-text').length, 2);
  assertEquals(kinds.filter((kind) => kind === 'late-results').length, 1);
  assert(kinds.indexOf('late-results') < kinds.lastIndexOf('user-text'));
});

Deno.test('a message that reads the chat as a wake pauses on an approval is refused; the approval waits', async () => {
  const { sent, view, woke } = await messageOverSavingWake(true);
  assert('failure' in sent, 'the message posted over an approval the person never saw');
  assert(sent.failure instanceof Error);
  assertEquals(sent.failure.message, labelText('session.gate_pending'));
  assertEquals(woke, 'committed');
  assert(view.paused, 'the approval the wake stopped on is gone');
  assertEquals(view.transcript.filter((b) => b.kind === 'user-text').length, 1);
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

/** A wake that stops on an approval; then `answer` approves, denies or walks away with a message. */
async function gatedWake(answer: 'approve' | 'deny' | 'message') {
  const { transport, handles, seen, script } = harness();
  script.askAt = 3;
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const woke = await wake(transport, ref);
    const gate = toolEventsOf(
      woke.lines.filter(
        (line): line is TurnEvent =>
          line.type !== 'conversation' && line.type !== 'unsupported' && line.type !== 'malformed',
      ),
      'gate',
    ).at(-1);
    assert(gate, 'expected the wake to pause on a gate');
    const paused = await transport.conversation({ conversation: woke.ref });
    assertEquals(paused.wake, undefined, 'a paused wake asked to wake again');
    let left = woke.ref;
    if (answer === 'message') {
      await transport.turn(
        {
          conversation: woke.ref,
          input: { text: 'never mind' },
          abandon: [{ callId: gate.callId, operationId: issuedOperationId(gate) }],
        },
        (line) => {
          if (line.type === 'conversation') left = line.ref;
        },
      );
    } else {
      await transport.invoke(
        {
          conversation: woke.ref,
          gateId: gate.callId,
          operationId: issuedOperationId(gate),
          decision: answer,
        },
        (line) => {
          if (line.type === 'conversation') left = line.ref;
        },
      );
      left = await say(transport, 'any news?', left);
    }
    const view = await transport.conversation({ conversation: left });
    assertEquals(await lateBlocks(transport, left), 1, 'the result was told more than once');
    assertEquals(view.wake, undefined);
    assert(
      JSON.stringify(seen.at(-1)).includes('the-woken-answer'),
      'the next message lost the result',
    );
  } finally {
    held.free();
  }
}

Deno.test('a wake that stops on an approval goes on once approved, and the result is told once', () =>
  gatedWake('approve'));

Deno.test('a wake that stops on an approval and is denied keeps the result, told once', () =>
  gatedWake('deny'));

Deno.test('a message over a wake waiting on an approval keeps the result, told once', () =>
  gatedWake('message'));
