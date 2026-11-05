import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createKernelScope, defineProfile, memorySink, openRouterProvider } from '../../../mod.ts';
import type { TraceRecord } from '../../../src/observability/trace-record.ts';

const CLIP = { mimeType: 'audio/mp4', data: 'AAEC' };
const LIMITS = { maxFiles: 1, maxBytes: 1024, maxTurnBytes: 1024 };

function transcriber(options: Record<string, unknown> = {}) {
  const scope = createKernelScope();
  const provider = scope.providers.register(openRouterProvider, {
    id: 'router',
    keySlot: 'router',
  });
  scope.profiles.register(
    defineProfile({
      id: 'transcriber',
      type: 'transcription',
      identity: { handle: 'transcriber' },
      models: { stt: provider.model('openRouterTranscriptions', 'stt-fixture', { options }) },
      inputs: { voice: { accept: ['audio/*'] }, ...LIMITS },
    }),
  );
  return scope;
}

function answering(body: unknown, sent: { url?: string; body?: unknown }) {
  return {
    vault: { router: 'fixture-key' },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      sent.url = String(url);
      sent.body = JSON.parse(String(init?.body));
      return await Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', 'x-generation-id': 'gen-stt' },
        }),
      );
    },
  };
}

type Input = { text?: string; voice?: { mimeType: string; data: string }[] };

function run(scope: ReturnType<typeof transcriber>, input: Input, body: unknown) {
  return Array.fromAsync(scope.runTurn({ profile: 'transcriber', input }, answering(body, {})));
}

function texts(events: Awaited<ReturnType<typeof run>>): string {
  return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

Deno.test('a transcription turn sends one clip and gives back its text', async () => {
  const sent: { url?: string; body?: unknown } = {};
  const scope = transcriber({ provider: { zdr: true } });
  const into: TraceRecord[] = [];
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'transcriber', input: { voice: [CLIP] } },
      answering(
        { text: 'Water the fern.', usage: { seconds: 2, input_tokens: 4, cost: 0.0001 } },
        sent,
      ),
      memorySink(into),
    ),
  );
  assertEquals(sent.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
  assertEquals(sent.body, {
    model: 'stt-fixture',
    input_audio: { data: CLIP.data, format: 'm4a' },
    provider: { zdr: true },
  });
  assertEquals(texts(events), 'Water the fern.');
  const call = into[0]?.spans.find(
    (span) => span.attributes['gen_ai.operation.name'] === 'transcribe',
  );
  assertEquals(call?.attributes['gen_ai.response.id'], 'gen-stt');
  const tokens = events.find((event) => event.type === 'tokens');
  assertEquals(tokens?.type === 'tokens' ? tokens.tokens.cost?.usd : undefined, 0.0001);
});

Deno.test('a clip of silence completes with no text', async () => {
  const events = await run(transcriber(), { voice: [CLIP] }, { text: '' });
  assertEquals(texts(events), '');
  assertEquals(
    events.some((event) => event.type === 'error'),
    false,
  );
});

Deno.test('a reply with no text field is a bad response, not silence', async () => {
  const events = await run(transcriber(), { voice: [CLIP] }, { usage: {} });
  assertEquals(
    events.some((event) => event.type === 'error'),
    true,
  );
});

Deno.test('a transcription turn refuses what is not one clip', async () => {
  const scope = transcriber();
  const reply = { text: 'x' };
  await assertRejects(() => run(scope, {}, reply));
  await assertRejects(() => run(scope, { text: 'hello', voice: [CLIP] }, reply));
});

Deno.test('audio with no wire format is refused', async () => {
  const pcm = { mimeType: 'audio/pcm', data: 'AAEC' };
  await assertRejects(() => run(transcriber(), { voice: [pcm] }, { text: 'x' }));
});

Deno.test('a binding refuses the routing fields the endpoint ignores', () => {
  assertThrows(() => transcriber({ provider: { only: ['gmicloud/fp8'] } }));
});

Deno.test('a transcription profile takes no tools, outputs, or text setting', () => {
  const base = {
    id: 'stt',
    type: 'transcription',
    identity: { handle: 'stt' },
    models: { stt: { provider: 'router', apiId: 'stt-fixture' } },
    inputs: { voice: { accept: ['audio/*'] }, ...LIMITS },
  };
  for (const extra of [
    { tools: { allow: [] } },
    { outputs: {} },
    { maxSteps: 2 },
    { inputs: { ...base.inputs, text: true } },
  ]) {
    assertThrows(() => defineProfile({ ...base, ...extra } as never));
  }
});
