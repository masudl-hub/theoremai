import { assertEquals } from '@std/assert';
import {
  createKernelScope,
  defineProfile,
  defineProvider,
  openRouterAdapter,
  z,
} from '../../mod.ts';

function stream(rows: Record<string, unknown>[]): Response {
  return new Response(
    `${rows
      .map(
        (row) =>
          `data: ${JSON.stringify({ id: 'response-test', created: 0, model: 'vendor/model', object: 'chat.completion.chunk', ...row })}\n\n`,
      )
      .join('')}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
Deno.test('registered OpenRouter replays encrypted reasoning with its matching portable tool history', async () => {
  const scope = createKernelScope();
  const provider = defineProvider({
    id: 'router',
    connection: {},
    keySlot: 'router',
    adapter: openRouterAdapter(),
  });
  scope.providers.register(provider);
  scope.tools.register({
    type: 'function',
    name: 'lookup',
    description: 'Find the item.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.strictObject({}),
    output: z.strictObject({ result: z.string() }),
    handler: () => ({ result: 'found' }),
  });
  scope.profiles.register(
    defineProfile({
      id: 'worker',
      type: 'text',
      identity: { handle: 'Worker' },
      models: { main: provider.model('vendor/model') },
      inputs: { text: true },
      tools: { allow: ['lookup'] },
      maxSteps: 2,
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  const send: typeof fetch = async (input, init) => {
    bodies.push(
      input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)),
    );
    if (bodies.length === 1)
      return stream([
        {
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                content: 'Looking it up.',
                reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-', index: 0 }],
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [{ type: 'reasoning.encrypted', data: 'state', index: 0 }],
                tool_calls: [{ index: 0, function: { arguments: '}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]);
    return stream([
      { choices: [{ index: 0, delta: { content: 'Found it.' }, finish_reason: 'stop' }] },
    ]);
  };
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'worker', input: { text: 'find it' } },
      { fetch: send, vault: { router: 'fixture-key' } },
    ),
  );
  assertEquals(
    events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
    true,
    JSON.stringify(events),
  );
  assertEquals(bodies.length, 2);
  const messages = bodies[1].messages as Record<string, unknown>[];
  const assistant = messages.find((message) => Array.isArray(message.tool_calls));
  assertEquals(assistant?.reasoning_details, [
    { type: 'reasoning.encrypted', data: 'opaque-state', index: 0 },
  ]);
  assertEquals((bodies[0].provider as Record<string, unknown>).require_parameters, true);
  assertEquals(
    events.some((event) => event.type === 'provider_warning'),
    false,
  );
});
