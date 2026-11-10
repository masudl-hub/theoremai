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
import { createHttpTransport, type TheoremTransport } from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremHandler,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_late_result_job';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-late-results',
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
    return { done: 'the-late-answer' };
  },
});

/** A model that calls the tool on its first step and answers in text after; it keeps every request. */
function caller(seen: ModelRequest[]): TurnModel {
  let step = 0;
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        await Promise.resolve();
        step += 1;
        if (step === 1) {
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
