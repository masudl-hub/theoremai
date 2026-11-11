import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type ModelRequest,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnEvent,
  type TurnModel,
  z,
} from '../../mod.ts';
import { createHttpTransport, type TheoremTransport } from '../../web/src/client/transport.ts';
import { issuedOperationId } from '../../web/src/client/turn-client.ts';
import {
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremHandler,
  pageWakes,
} from '../../web/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_late_result_job';
const ASK = 'web_late_result_ask';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-late-results',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL, ASK] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const held = { until: Promise.resolve(), free: () => {}, fail: false };

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
    if (held.fail) throw new Error('the-late-failure');
    return { done: 'the-late-answer' };
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

/** Steps on which the model calls the gated tool instead. */
const askSteps = new Set<number>();

/** Steps besides the first on which the model calls the tool, with the same call id. */
const toolSteps = new Set<number>();

/** A model that calls the tool on its first step and answers in text after; it keeps every request. */
function caller(seen: ModelRequest[]): TurnModel {
  let step = 0;
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        await Promise.resolve();
        step += 1;
        if (askSteps.has(step)) {
          yield {
            type: 'tool' as const,
            tool: { name: ASK, callId: `ask_${step}`, arguments: {} },
          };
          return;
        }
        if (step === 1 || toolSteps.has(step)) {
          yield { type: 'tool' as const, tool: { name: TOOL, callId: 'call_1', arguments: {} } };
          return;
        }
        yield { type: 'text' as const, text: 'Noted.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function harness(authorizeToolReplay?: () => boolean) {
  held.until = new Promise<void>((resolve) => {
    held.free = resolve;
  });
  const handles: ToolBackgroundHandle[] = [];
  const seen: ModelRequest[] = [];
  const model = caller(seen);
  const handler = createTheoremHandler({
    profile: PROFILE,
    provider: () => fixtureHostOptions(model),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    session: () => 'one-person',
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
    lateResultsDecider: pageWakes,
    ...(authorizeToolReplay ? { authorizeToolReplay } : {}),
  });
  const transport: TheoremTransport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  return { transport, handles, seen };
}

async function say(transport: TheoremTransport, text: string, conversation?: string) {
  let ref = conversation ?? '';
  await transport.turn({ input: { text }, ...(conversation ? { conversation } : {}) }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  return ref;
}

/** How many of the model's requests read the late answer. */
const reads = (seen: ModelRequest[], from: number) =>
  seen.slice(from).filter((req) => JSON.stringify(req).includes('the-late-answer')).length;

Deno.test("the next turn reads a background call's result once it settles, and only once", async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0, 'the turn after the call settled did not read its result');
    const view = await transport.conversation({ conversation: ref });
    const late = view.transcript.filter((block) => block.kind === 'late-results');
    assertEquals(late.length, 1);
    await say(transport, 'and now?', ref);
    const after = await transport.conversation({ conversation: ref });
    assertEquals(after.transcript.filter((block) => block.kind === 'late-results').length, 1);
  } finally {
    held.free();
  }
});

Deno.test('a result the host withholds from this request is not read by its turn', async () => {
  const { transport, handles, seen } = harness(() => false);
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0);
  } finally {
    held.free();
  }
});

Deno.test('a second call with the same call id and the same answer is read too', async () => {
  const { transport, handles, seen } = harness();
  toolSteps.add(3);
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    await say(transport, 'again please', ref);
    await handles[1].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0);
    const view = await transport.conversation({ conversation: ref });
    const read = view.transcript.flatMap((b) => (b.kind === 'late-results' ? b.operationIds : []));
    assertEquals(read.length, 2);
    assertEquals(new Set(read).size, 2);
  } finally {
    toolSteps.clear();
    held.free();
  }
});

Deno.test('a call still running at the next turn is read once, after it settles', async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0);
    held.free();
    await handles[0].done;
    await say(transport, 'and now?', ref);
    await say(transport, 'still there?', ref);
    const view = await transport.conversation({ conversation: ref });
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    held.free();
  }
});

Deno.test('a result that settles while a reply waits on an approval is read once, by the next turn', async () => {
  const { transport, handles, seen } = harness();
  askSteps.add(3);
  try {
    const ref = await say(transport, 'start the job');
    const events: TurnEvent[] = [];
    await transport.turn({ conversation: ref, input: { text: 'check first' } }, (line) => {
      if (line.type !== 'conversation' && line.type !== 'unsupported' && line.type !== 'malformed')
        events.push(line);
    });
    const gate = toolEventsOf(events, 'gate').at(-1);
    assert(gate, 'expected the reply to pause on a gate');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await transport.invoke(
      {
        conversation: ref,
        gateId: gate.callId,
        operationId: issuedOperationId(gate),
        decision: 'approve',
      },
      () => {},
    );
    assertEquals(reads(seen, before), 0, 'the reply that went on read it mid-reply');
    await say(transport, 'any news?', ref);
    const view = await transport.conversation({ conversation: ref });
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    askSteps.clear();
    held.free();
  }
});

Deno.test('a call that ends in an error is read by the next turn as its failure', async () => {
  const { transport, handles, seen } = harness();
  held.fail = true;
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done.catch(() => {});
    const before = seen.length;
    await say(transport, 'any news?', ref);
    const view = await transport.conversation({ conversation: ref });
    const late = view.transcript.flatMap((b) => (b.kind === 'late-results' ? [b.text] : []));
    assertEquals(late.length, 1);
    assert(late[0]?.includes(TOOL));
    assert(late[0]?.includes('the-late-failure'));
    assert(seen.slice(before).some((req) => JSON.stringify(req).includes('the-late-failure')));
  } finally {
    held.fail = false;
    held.free();
  }
});
