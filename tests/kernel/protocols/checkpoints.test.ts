import { assertEquals, assertExists, assertThrows } from '@std/assert';
import { z } from 'zod';
import { defineProtocol } from '../../../src/kernel/protocols/protocol.ts';
import {
  bearer,
  createProviderRegistry,
  defineProvider,
} from '../../../src/kernel/protocols/provider.ts';
import {
  assertHistoryKept,
  checkpointProviderState,
  restoreProviderState,
} from '../../../src/kernel/provider-runtime.ts';
import type { TurnHistoryMessage } from '../../../src/kernel/types.ts';

const kept = defineProtocol({
  id: 'kept',
  name: 'Kept',
  description: 'Keeps a conversation id between calls.',
  endpoints: { text: '/turn' },
  options: z.strictObject({
    store: z.boolean().optional().describe('Keep the conversation upstream.'),
    loud: z.boolean().optional().describe('Shout.'),
  }),
  continuation: { version: 1, schema: z.strictObject({ id: z.string() }), keyOptions: ['store'] },
  create: () => ({}),
});
const host = defineProvider({
  id: 'host',
  name: 'Host',
  description: 'A test host.',
  connection: z.strictObject({ region: z.string() }),
  key: z.string(),
  authorize: bearer(),
  serves: () => [{ protocol: kept, baseUrl: 'https://host.test' }],
});
const registry = createProviderRegistry();
const us = registry.register(host, { connection: { region: 'us' }, keySlot: 'slot_a' });
const eu = registry.register(host, { id: 'eu', connection: { region: 'eu' }, keySlot: 'slot_a' });
const binding = us.model(kept, 'm-1', { options: { store: true } });
const history: TurnHistoryMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];

Deno.test('a checkpoint is reused for the same call and covers the history it was written after', async () => {
  const checkpoint = await checkpointProviderState(us, binding, 'slot_a', { id: 'c-1' }, history);
  assertEquals(
    checkpoint?.compatibilityKey,
    '{"connection":{"region":"us"},"options":[["store",true]]}',
  );
  const later = [...history, { role: 'user', content: 'more' } as TurnHistoryMessage];
  assertEquals(await restoreProviderState(us, binding, checkpoint, later), {
    state: { id: 'c-1' },
    covered: 2,
  });
  assertEquals(await checkpointProviderState(us, binding, 'slot_a', undefined, history), undefined);
});

Deno.test('a checkpoint written for anything else is dropped with the reason', async () => {
  const checkpoint = await checkpointProviderState(us, binding, 'slot_a', { id: 'c-1' }, history);
  assertExists(checkpoint);
  const reason = async (
    ...args: Parameters<typeof restoreProviderState>
  ): Promise<string | undefined> => (await restoreProviderState(...args)).warning?.reason;
  assertEquals(
    await reason(eu, eu.model(kept, 'm-1', { options: { store: true } }), checkpoint, history),
    'provider_changed',
  );
  assertEquals(
    await reason(us, { ...binding, apiId: 'm-2' }, checkpoint, history),
    'model_changed',
  );
  assertEquals(
    await reason(us, binding, { ...checkpoint, version: 2 }, history),
    'version_changed',
  );
  assertEquals(
    await reason(us, { ...binding, options: { store: false } }, checkpoint, history),
    'connection_changed',
  );
  assertEquals(
    await reason(us, { ...binding, keySlot: 'slot_b' }, checkpoint, history),
    'key_changed',
  );
  assertEquals(
    await reason(us, binding, checkpoint, [{ role: 'user', content: 'edited' }, history[1]]),
    'history_changed',
  );
  assertEquals(await reason(us, binding, checkpoint, history.slice(1)), 'history_changed');
  assertEquals(
    await reason(us, { ...binding, options: { store: true, loud: true } }, checkpoint, history),
    undefined,
  );
});

Deno.test('a provider-held conversation is the checkpoint alone; a stateless one carries none', async () => {
  const checkpoint = await checkpointProviderState(us, binding, 'slot_a', { id: 'c-1' }, history);
  const policy = { history: 'provider' } as const;
  assertEquals(await restoreProviderState(us, binding, checkpoint, [], policy), {
    state: { id: 'c-1' },
    covered: 0,
  });
  assertEquals(
    (await restoreProviderState(us, binding, checkpoint, history, policy)).warning?.reason,
    'history_changed',
  );
  assertHistoryKept({ history: 'stateless' }, undefined, []);
  assertThrows(() => assertHistoryKept({ history: 'stateless' }, undefined, history));
  assertThrows(() => assertHistoryKept({ history: 'stateless' }, checkpoint, []));
});

/**
 * A turn on a provider that keeps a cursor: it writes, calls a tool, answers, takes a before_end
 * inject that the user has `released` characters of the reply for, and answers again.
 */
async function continuedTurn(suffix: string, released?: number) {
  await import('../../fixtures/test-host.ts');
  const { defaultKernelScope } = await import('../../../src/kernel/scope.ts');
  const { registerProfile, registerProvider } = await import(
    '../../../src/kernel/default-scope.ts'
  );
  const { defineProfile } = await import('../../../src/kernel/registry/profiles.ts');
  // What each call after the first sends: the saved state, and the history it does not cover.
  const sent: { state: unknown; uncovered: TurnHistoryMessage[] }[] = [];
  let call = 0;
  const continued = defineProtocol({
    id: `continuedFixture${suffix}`,
    name: 'Continued fixture',
    description:
      'Writes, calls a tool, answers, and answers again, keeping a cursor between calls.',
    endpoints: { text: '/turn' },
    options: z.strictObject({}),
    continuation: { version: 1, schema: z.strictObject({ cursor: z.string() }) },
    create: () => ({
      async *complete(request) {
        call++;
        if (call > 1) {
          sent.push({
            state: request.state,
            uncovered: (request.history ?? []).slice(request.stateHistoryLength ?? 0),
          });
        }
        if (call === 1) {
          yield { type: 'text', text: 'Let me check.' };
          yield {
            type: 'tool_call',
            call: { callId: 'c1', name: 'stub_tool', arguments: { value: 1 } },
          };
          yield { type: 'done', stop: { kind: 'tool' }, state: { cursor: 'one' } };
          return;
        }
        yield { type: 'text', text: call === 2 ? 'First answer.' : 'Second answer.' };
        yield { type: 'done', stop: { kind: 'completed' }, state: { cursor: `c${call}` } };
      },
    }),
  });
  const deployment = registerProvider(
    defineProvider({
      id: `continued-fixture${suffix}`,
      name: 'Continued fixture',
      description: 'Serves the continued fixture with no key.',
      serves: () => [{ protocol: continued, baseUrl: 'https://continued.test' }],
    }),
  );
  registerProfile(
    defineProfile({
      id: `continued-worker${suffix}`,
      type: 'text',
      identity: { handle: 'Worker' },
      models: { main: deployment.model(continued, 'model') },
      maxSteps: 4,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { detect: 'ignore' },
    }),
  );
  let injected = false;
  const events = await Array.fromAsync(
    defaultKernelScope.runTurn(
      {
        profile: `continued-worker${suffix}`,
        input: { text: 'check it' },
        onStage: ({ stage }) => {
          if (stage !== 'before_end' || injected) return undefined;
          injected = true;
          return {
            inject: [{ role: 'user', content: 'and the fern?' }],
            injectId: 'late',
            ...(released === undefined ? {} : { released }),
          };
        },
      },
      {},
    ),
  );
  return { events, sent };
}

Deno.test('a turn keeps its checkpoint across a step that wrote text before its calls, and a before_end inject', async () => {
  const { events, sent } = await continuedTurn('');
  assertEquals(
    events.filter((event) => event.type === 'provider_warning'),
    [],
  );
  assertEquals(
    sent.map(({ state, uncovered }) => [state, uncovered.map((m) => [m.role, m.content])]),
    [
      [{ cursor: 'one' }, [['tool', sent[0]?.uncovered[0]?.content]]],
      [{ cursor: 'c2' }, [['user', 'and the fern?']]],
    ],
  );
});

Deno.test('a turn rebuilds its checkpoint once an inject drops a draft the user does not have', async () => {
  const { events, sent } = await continuedTurn('2', 'Let me check.\n\n'.length);
  assertEquals(
    events.flatMap((event) => (event.type === 'provider_warning' ? [event.warning.reason] : [])),
    ['history_changed'],
  );
  // The last call sends no cursor: its history no longer holds the dropped answer.
  assertEquals(sent[1]?.state, undefined);
  assertEquals(
    sent[1]?.uncovered
      .slice(1)
      .filter((m) => m.role !== 'tool')
      .map((m) => [m.role, m.content ?? null]),
    [
      ['assistant', 'Let me check.'],
      ['assistant', null],
      ['user', 'and the fern?'],
    ],
  );
});
