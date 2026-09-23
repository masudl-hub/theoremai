import '../../../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import { getProfile, registerProfile } from '../../../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../../../src/kernel/registry/resolve.ts';
import type { KeyVault, TurnEvent } from '../../../../src/kernel/types.ts';
import { createProvider } from '../../../../src/providers/create-provider.ts';
import {
  camelToSnake,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import { createInteractionsProvider } from '../../../../src/providers/google/interactions/stream.ts';
import { wrapPcmAsWav } from '../../../../src/providers/shared/pcm.ts';
import { geminiModels } from '../../../fixtures/models.ts';

const vault: KeyVault = {
  slotA: 'free-a-key',
  slotB: 'free-b-key',
  slotC: 'free-c-key',
  paid: 'paid-key',
};

function noWait(): Promise<void> {
  return Promise.resolve();
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

/** A `step.delta` row as the stream sends it (shape recorded 23/09/2026). */
function deltaRow(delta: Record<string, unknown>): Record<string, unknown> {
  return { event_type: 'step.delta', index: 0, delta };
}

const COMPLETED_ROW = {
  event_type: 'interaction.completed',
  interaction: { id: 'v1_tts', status: 'completed' },
};

function sseResponse(events: unknown[]): Response {
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n');
  return new Response(`${payload}\ndata: [DONE]\n`, { status: 200 });
}

Deno.test('speech profile resolves pins and model wire ids', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
  });
  assertEquals(generation.model, 'gemini31FlashTts');
  assertEquals(generation.apiId, 'gemini-3.1-flash-tts-preview');
  assertEquals(generation.speech, { voice: 'Kore', format: 'pcm' });
  assertEquals(generation.image, null);
  assertEquals(generation.structured, null);
});

Deno.test('Interactions body for speech uses audio response_format and speech_config', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Say hello' },
  });
  const body = toInteractionsBody({
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: generation.builtins,
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    keySlot: generation.keySlot,
  });

  const format = body[camelToSnake('responseFormat')] as Record<string, string>;
  const gen = body[camelToSnake('generationConfig')] as Record<string, unknown>;
  assertEquals(body.model, 'gemini-3.1-flash-tts-preview');
  assertEquals(format.type, 'audio');
  assertEquals(gen[camelToSnake('speechConfig')], [{ voice: 'Kore' }]);
  assertEquals(gen[camelToSnake('thinkingLevel')], undefined);
  assertEquals(gen[camelToSnake('thinkingSummaries')], undefined);
});

Deno.test('Interactions speech turn wraps PCM as WAV media', async () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const pcmB64 = btoa(String.fromCharCode(...pcm));
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'hi' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(
        sseResponse([
          // gemini-3.1-flash-tts-preview streams `audio/l16` with the format beside it.
          deltaRow({
            type: 'audio',
            mime_type: 'audio/l16',
            sample_rate: 24000,
            channels: 1,
            data: pcmB64,
          }),
          COMPLETED_ROW,
        ]),
      ),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      speech: generation.speech,
      keySlot: generation.keySlot,
    }),
  );
  assertEquals(
    events.map((ev) => ev.type),
    ['media', 'done'],
  );
  const media = events[0]?.media;
  assertEquals(media?.mimeType, 'audio/wav');
  const wavBytes = wrapPcmAsWav(pcm, { sampleRate: 24000, channels: 1 });
  assertEquals(media?.data, btoa(String.fromCharCode(...wavBytes)));
});

Deno.test('Interactions speech profile errors when model emits text only (no fake PCM)', async () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'say it' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(sseResponse([deltaRow({ type: 'text', text: 'hello' }), COMPLETED_ROW])),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      speech: generation.speech,
      keySlot: generation.keySlot,
    }),
  );
  assertEquals(
    events.map((event) => event.type),
    ['text', 'done', 'error'],
  );
  assertEquals(events[0]?.text, 'hello');
  assertEquals(typeof events[2]?.error, 'string');
});

Deno.test('Interactions non-voice profile does not synthesize speech media from text', async () => {
  const { generation } = resolveTurn({
    profile: 'chat',
    input: { text: 'say it' },
  });
  const provider = createInteractionsProvider({
    vault,
    wait: noWait,
    fetch: () =>
      Promise.resolve(sseResponse([deltaRow({ type: 'text', text: 'hello' }), COMPLETED_ROW])),
  });
  const events = await collect(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: generation.builtins,
      system: '',
      input: generation.input,
      structured: generation.structured,
      image: generation.image,
      speech: undefined,
      keySlot: generation.keySlot,
    }),
  );
  assertEquals(
    events.some((event) => event.type === 'text' && event.text === 'hello'),
    true,
  );
  assertEquals(
    events.some((event) => event.type === 'media'),
    false,
  );
});

Deno.test('Interactions speech profile rejects mp3 format at profile resolution', () => {
  registerProfile({
    id: 'bad-speech',
    type: 'speech',
    identity: { handle: 'bad' },
    ...geminiModels('gemini31FlashTts'),
    speech: {
      voice: 'Kore',
      format: 'mp3',
    },
  });
  assertThrows(() => {
    resolveTurn({ profile: 'bad-speech', input: { text: 'hi' } });
  }, TheoremError);
});

Deno.test('createProvider routes speech-role Interactions to the same adapter', () => {
  registerProfile({
    id: 'speech-test',
    type: 'speech',
    identity: { handle: 'speech' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'pcm' },
  });
  const profile = getProfile('speech-test');
  const provider = createProvider(profile, {
    gemini: { vault },
  });
  assertEquals(typeof provider.complete, 'function');
});
