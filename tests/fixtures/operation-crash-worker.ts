import { registerTool, z } from '../../mod.ts';
import { createTheoremHostHandler } from '../../web/src/server/mod.ts';
import { sqliteSessionStore } from './sqlite-session-store.ts';

const [path, phase, endpoint, encodedAnswer, name] = Deno.args;
async function barrier() {
  console.log('CRASH_BARRIER');
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}
registerTool({
  type: 'function',
  name,
  description: 'Count an external effect',
  category: 'test',
  access: 'read-write',
  permission: 'always_confirm',
  loadTier: 'T0',
  paths: ['*'],
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  handler: async () => {
    const response = await fetch(endpoint, { method: 'POST' });
    if (phase === 'in_flight') await barrier();
    await response.text();
    if (phase === 'effect') await barrier();
    return { ok: true };
  },
});
const durable = sqliteSessionStore(path);
const handler = createTheoremHostHandler({
  profile: { id: name, type: 'host', tools: { allow: [name] } },
  session: () => name,
  sessionStore: {
    capacity: durable.capacity,
    load: durable.load,
    async compareAndSwap(id, revision, state) {
      if (
        phase === 'before_ready' &&
        Object.values(state.operations).some((operation) => operation.status === 'ready')
      )
        await barrier();
      const result = await durable.compareAndSwap(id, revision, state);
      if (
        result.written &&
        Object.values(state.operations).some((operation) => operation.status === phase)
      )
        await barrier();
      return result;
    },
  },
});
if (phase === 'race') await (await fetch(`${endpoint}/ready`)).text();
const response = await handler(
  new Request('https://crash.test/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: encodedAnswer,
  }),
);
const text = await response.text();
if (phase === 'race') console.log(JSON.stringify({ status: response.status, text }));
else throw new Error('The controlled crash barrier was not reached');
