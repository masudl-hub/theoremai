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
