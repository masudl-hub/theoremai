import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnModel,
  z,
} from '../../mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import { createHttpTransport, type TheoremTransport } from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createMemorySessionStore,
  createTheoremHandler,
  type TheoremHandlerOptions,
  type TheoremNotifier,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_notify_job';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-notify',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

function caller(): TurnModel {
  let step = 0;
  return {
    complete: () =>
      (async function* () {
        await Promise.resolve();
        step += 1;
        if (step === 1) {
          yield {
            type: 'tool' as const,
            tool: { name: TOOL, callId: `call_${step}`, arguments: {} },
          };
          return;
        }
        yield { type: 'text' as const, text: 'Looking into it.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

/** What the tool's body waits on, for the test that runs now. */
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
    return { done: 'late' };
  },
});

type Harness = {
  transport: TheoremTransport;
  handles: ToolBackgroundHandle[];
  release: () => void;
};

/** A chat with one background tool, held until `release`. */
function harness(
  overrides: Partial<TheoremHandlerOptions>,
  sessionId: () => string = () => 'one-person',
): Harness {
  held.until = new Promise<void>((resolve) => {
    held.free = resolve;
  });
  const handles: ToolBackgroundHandle[] = [];
  // why: One model for the chat, so a wake answers in text instead of starting the job again.
  const model = caller();
  const options: TheoremHandlerOptions = {
    profile: PROFILE,
    provider: () => fixtureHostOptions(model),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    session: sessionId,
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
    ...overrides,
  };
  const handler = createTheoremHandler(options);
  const transport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  return { transport, handles, release: () => held.free() };
}

async function startTurn(transport: TheoremTransport): Promise<string> {
  let ref = '';
  await transport.turn({ input: { text: 'hello' } }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  return ref;
}

const phases = (view: Awaited<ReturnType<TheoremTransport['conversation']>>) =>
  view.transcript.flatMap((block) => (block.kind === 'tool' ? [block.tool.state?.phase] : []));

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

Deno.test('the push says changed at once and again when a background call ends', async () => {
  const { transport, handles, release } = harness({ notifier: createMemoryNotifier() });
  try {
    const ref = await startTurn(transport);
    let lines = 0;
    const stop = new AbortController();
    const push = transport.notify?.(() => {
      lines += 1;
    }, stop.signal);
    await waitFor(() => lines === 1);
    release();
    await handles[0].done;
    await waitFor(() => lines === 2);
    assertEquals(phases(await transport.conversation({ conversation: ref })), ['complete']);
    stop.abort();
    await push?.catch(() => {});
  } finally {
    held.free();
  }
});

Deno.test('the page learns of the end only after the store holds it', async () => {
  const { transport, handles, release } = harness({ notifier: createMemoryNotifier() });
  try {
    const ref = await startTurn(transport);
    const read: string[] = [];
    const stop = new AbortController();
    let lines = 0;
    const push = transport.notify?.(() => {
      lines += 1;
      if (lines === 2) {
        void transport
          .conversation({ conversation: ref })
          .then((view) => read.push(...phases(view).map(String)));
      }
    }, stop.signal);
    release();
    await handles[0].done;
    await waitFor(() => read.length === 1);
    assertEquals(read, ['complete']);
    stop.abort();
    await push?.catch(() => {});
  } finally {
    held.free();
  }
});

Deno.test('a view asks for the push only while a call runs and a notifier is set', async () => {
  const on = harness({ notifier: createMemoryNotifier(), notifyRetryMs: 25 });
  try {
    const ref = await startTurn(on.transport);
    assertEquals((await on.transport.conversation({ conversation: ref })).notify, { retryMs: 25 });
    on.release();
    await on.handles[0].done;
    assertEquals((await on.transport.conversation({ conversation: ref })).notify, undefined);
  } finally {
    held.free();
  }
  const off = harness({});
  try {
    const ref = await startTurn(off.transport);
    assertEquals((await off.transport.conversation({ conversation: ref })).notify, undefined);
    off.release();
    await off.handles[0].done;
  } finally {
    held.free();
  }
});

Deno.test('with no notifier the route is refused and the turn runs as before', async () => {
  const { transport, handles, release } = harness({});
  try {
    await startTurn(transport);
    await assertRejects(() =>
      (transport.notify as NonNullable<typeof transport.notify>)(
        () => {},
        new AbortController().signal,
      ),
    );
    release();
    await handles[0].done;
  } finally {
    held.free();
  }
});

Deno.test('a push reaches its own session only', async () => {
  const notifier = createMemoryNotifier();
  let who = 'one';
  const { transport, handles, release } = harness({ notifier }, () => who);
  try {
    await startTurn(transport);
    who = 'two';
    let other = 0;
    const stop = new AbortController();
    const push = transport.notify?.(() => {
      other += 1;
    }, stop.signal);
    await waitFor(() => other === 1);
    release();
    await handles[0].done;
    await notifier.publish('one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(other, 1);
    stop.abort();
    await push?.catch(() => {});
  } finally {
    held.free();
  }
});

Deno.test('a stream that ends leaves no subscriber behind', async () => {
  let live = 0;
  const memory = createMemoryNotifier();
  const notifier: TheoremNotifier = {
    publish: (id) => memory.publish(id),
    async subscribe(id, changed) {
      live += 1;
      const off = await memory.subscribe(id, changed);
      return () => {
        live -= 1;
        off();
      };
    },
  };
  const { transport, handles, release } = harness({ notifier });
  try {
    await startTurn(transport);
    const stop = new AbortController();
    let lines = 0;
    const push = transport.notify?.(() => {
      lines += 1;
    }, stop.signal);
    await waitFor(() => lines === 1);
    assertEquals(live, 1);
    stop.abort();
    await push?.catch(() => {});
    await waitFor(() => live === 0);
    release();
    await handles[0].done;
  } finally {
    held.free();
  }
});

Deno.test('a publish that fails reaches onError and the call still ends', async () => {
  const errors: unknown[] = [];
  const failure = new Error('the bus is down');
  const notifier: TheoremNotifier = {
    subscribe: () => () => {},
    publish: () => Promise.reject(failure),
  };
  const { transport, handles, release } = harness({
    notifier,
    onError: (err) => errors.push(err),
  });
  try {
    const ref = await startTurn(transport);
    release();
    await handles[0].done;
    await waitFor(() => errors.length === 1);
    assertEquals(errors, [failure]);
    assertEquals(phases(await transport.conversation({ conversation: ref })), ['complete']);
  } finally {
    held.free();
  }
});

Deno.test('a read does not show a result that authorizeToolReplay refuses', async () => {
  let allowed = false;
  const { transport, handles, release } = harness({
    authorizeToolReplay: () => allowed,
  });
  try {
    const ref = await startTurn(transport);
    release();
    await handles[0].done;
    const refused = await transport.conversation({ conversation: ref });
    assertEquals(phases(refused), ['error']);
    assert(!JSON.stringify(refused).includes('late'));
    allowed = true;
    assertEquals(phases(await transport.conversation({ conversation: ref })), ['complete']);
  } finally {
    held.free();
  }
});

Deno.test('notifyRetryMs must be a time', () => {
  assertThrows(() => harness({ notifyRetryMs: Number.NaN }));
});

async function chatOn(h: Harness) {
  const iface = await h.transport.describe();
  assert(iface.type === 'text');
  const chat = createChatController({ iface, transport: h.transport });
  return chat;
}

function toolPhase(chat: ReturnType<typeof createChatController>): string | undefined {
  const block = chat.getState().blocks.find((one) => one.kind === 'tool');
  return block?.kind === 'tool' ? block.tool.state?.phase : undefined;
}

Deno.test('an idle open page redraws when the call ends, with no turn or reload', async () => {
  const h = harness({ notifier: createMemoryNotifier() });
  try {
    const chat = await chatOn(h);
    const leave = chat.subscribe(() => {});
    await chat.sendText('hello');
    await waitFor(() => toolPhase(chat) === 'background' && chat.getState().phase === 'idle');
    h.release();
    await h.handles[0].done;
    await waitFor(() => toolPhase(chat) === 'complete');
    leave();
  } finally {
    held.free();
  }
});

Deno.test('the page drops the stream when nobody is listening or nothing runs', async () => {
  let opened = 0;
  let open = 0;
  const h = harness({ notifier: createMemoryNotifier() });
  const inner = h.transport.notify?.bind(h.transport);
  assert(inner);
  h.transport.notify = async (changed, signal) => {
    opened += 1;
    open += 1;
    try {
      await inner(changed, signal);
    } finally {
      open -= 1;
    }
  };
  try {
    const chat = await chatOn(h);
    const leave = chat.subscribe(() => {});
    await chat.sendText('hello');
    await waitFor(() => open === 1);
    leave();
    await waitFor(() => open === 0);
    const back = chat.subscribe(() => {});
    await waitFor(() => open === 1);
    assertEquals(opened, 2);
    h.release();
    await h.handles[0].done;
    await waitFor(() => toolPhase(chat) === 'complete' && open === 0);
    back();
  } finally {
    held.free();
  }
});

Deno.test('a page with a retry reopens a cut stream and catches an end it missed', async () => {
  const h = harness({ notifier: createMemoryNotifier(), notifyRetryMs: 1 });
  const inner = h.transport.notify?.bind(h.transport);
  assert(inner);
  let opens = 0;
  h.transport.notify = async (changed, signal) => {
    opens += 1;
    if (opens === 1) {
      throw new Error('cut');
    }
    await inner(changed, signal);
  };
  try {
    const chat = await chatOn(h);
    const leave = chat.subscribe(() => {});
    await chat.sendText('hello');
    await waitFor(() => opens === 2);
    h.release();
    await h.handles[0].done;
    await waitFor(() => toolPhase(chat) === 'complete');
    leave();
  } finally {
    held.free();
  }
});

Deno.test('a page with no retry stays as it stands after a cut', async () => {
  const h = harness({ notifier: createMemoryNotifier() });
  let opens = 0;
  h.transport.notify = () => {
    opens += 1;
    return Promise.reject(new Error('cut'));
  };
  try {
    const chat = await chatOn(h);
    const leave = chat.subscribe(() => {});
    await chat.sendText('hello');
    await waitFor(() => opens === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(opens, 1);
    assertEquals(chat.getState().failure, null);
    h.release();
    await h.handles[0].done;
    await chat.refresh();
    assertEquals(toolPhase(chat), 'complete');
    leave();
  } finally {
    held.free();
  }
});

Deno.test('a read that sees the end but loses to an older draw reads again', async () => {
  const h = harness({ notifier: createMemoryNotifier() });
  h.transport.notify = undefined;
  const conversation = h.transport.conversation.bind(h.transport);
  let hold: Promise<void> | null = null;
  h.transport.conversation = async (request, signal) => {
    const waited = hold;
    hold = null;
    if (waited) await waited;
    return conversation(request, signal);
  };
  try {
    const chat = await chatOn(h);
    const leave = chat.subscribe(() => {});
    await chat.sendText('hello');
    await waitFor(() => toolPhase(chat) === 'background');
    let free = () => {};
    hold = new Promise((resolve) => {
      free = resolve;
    });
    const read = chat.refresh();
    await chat.sendText('again');
    await waitFor(() => chat.getState().phase === 'idle');
    assertEquals(toolPhase(chat), 'background');
    h.release();
    await Promise.all(h.handles.map((handle) => handle.done));
    free();
    await read;
    assertEquals(toolPhase(chat), 'complete');
    leave();
  } finally {
    held.free();
  }
});
