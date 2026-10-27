/**
 * Sell-bar proof: binary `/audio/speech` with `X-Generation-Id` → call span
 * `gen_ai.response.id`, through provider registration and `runTurn` (not only
 * `callProtocol` events).
 */
import { assertEquals } from '@std/assert';
import { createKernelScope, defineProfile, memorySink, openRouterProvider } from '../../../mod.ts';
import type { TraceRecord } from '../../../src/observability/trace-record.ts';

Deno.test('speech X-Generation-Id lands on the call span as gen_ai.response.id', async () => {
  const scope = createKernelScope();
  const provider = scope.providers.register(openRouterProvider, {
    id: 'router',
    keySlot: 'router',
  });
  scope.profiles.register(
    defineProfile({
      id: 'speaker',
      type: 'speech',
      identity: { handle: 'speaker' },
      models: { tts: provider.model('openRouterOpenAi', 'tts-fixture') },
      speech: { format: 'mp3' },
    }),
  );
  const into: TraceRecord[] = [];
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'speaker', input: { text: 'Hello from the call span.' } },
      {
        vault: { router: 'fixture-key' },
        fetch: () =>
          Promise.resolve(
            new Response(new Uint8Array([1, 2, 3]), {
              headers: {
                'content-type': 'audio/mpeg',
                'x-generation-id': 'gen-tts-call-span',
              },
            }),
          ),
      },
      memorySink(into),
    ),
  );
  assertEquals(
    events.some((event) => event.type === 'media'),
    true,
    JSON.stringify(events.map((event) => event.type)),
  );
  const call = into[0]?.spans.find((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  assertEquals(call?.attributes['gen_ai.response.id'], 'gen-tts-call-span');
  assertEquals(call?.attributes['gen_ai.output.type'], 'speech');
  // why: header attrs stay on the POST try; OTel stores them as string[].
  const httpTry = into[0]?.spans.find((span) => span.name === 'POST');
  assertEquals(httpTry?.attributes['http.response.header.x-generation-id'], ['gen-tts-call-span']);
});

Deno.test('speech with no X-Generation-Id leaves gen_ai.response.id unset', async () => {
  const scope = createKernelScope();
  const provider = scope.providers.register(openRouterProvider, {
    id: 'router',
    keySlot: 'router',
  });
  scope.profiles.register(
    defineProfile({
      id: 'speaker-plain',
      type: 'speech',
      identity: { handle: 'speaker' },
      models: { tts: provider.model('openRouterOpenAi', 'tts-fixture') },
      speech: { format: 'mp3' },
    }),
  );
  const into: TraceRecord[] = [];
  await Array.fromAsync(
    scope.runTurn(
      { profile: 'speaker-plain', input: { text: 'No generation header.' } },
      {
        vault: { router: 'fixture-key' },
        fetch: () =>
          Promise.resolve(
            new Response(new Uint8Array([9]), { headers: { 'content-type': 'audio/mpeg' } }),
          ),
      },
      memorySink(into),
    ),
  );
  const call = into[0]?.spans.find((span) => span.kind === 'CLIENT');
  assertEquals(Object.hasOwn(call?.attributes ?? {}, 'gen_ai.response.id'), false);
});
