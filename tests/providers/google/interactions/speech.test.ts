import '../../../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import { getProfile, registerProfile, resolveTurn } from '../../../../src/kernel/default-scope.ts';
import { providerBuiltins } from '../../../../src/kernel/registry/provider-request.ts';
import { defaultKernelScope } from '../../../../src/kernel/scope.ts';
import type { KeyVault } from '../../../../src/kernel/types.ts';
import { createProvider } from '../../../../src/providers/create-provider.ts';
import {
  camelToSnake,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import { createInteractionsProvider } from '../../../../src/providers/google/interactions/stream.ts';
import { wrapPcmAsWav } from '../../../../src/providers/shared/pcm.ts';
import { firstOf } from '../../../fixtures/events.ts';
import { geminiModels } from '../../../fixtures/models.ts';

const vault: KeyVault = {
  slot_a: 'free-a-key',
  slot_b: 'free-b-key',
  slot_c: 'free-c-key',
  spare: 'spare-key',
};

function noWait(): Promise<void> {
  return Promise.resolve();
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

/** The provider request a resolved speech turn makes. */
function speechRequest(generation: ReturnType<typeof resolveTurn>['generation']) {
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: generation.summaries,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    speech: generation.speech,
    keySlot: generation.keySlot,
  };
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

Deno.test("a turn's speech settings replace the profile's, field by field", () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
    speech: { voice: 'Aoede', style: 'Slow and warm.', speed: undefined },
  });
  assertEquals(generation.speech, { voice: 'Aoede', style: 'Slow and warm.', format: 'pcm' });
});

Deno.test('the script reaches a speech model as written, with no fence around it', () => {
  const { generation } = resolveTurn({ profile: 'speech', input: { text: 'Hello there' } });
  assertEquals(generation.input, [{ type: 'text', text: 'Hello there' }]);
});

Deno.test('speech settings on a profile that does not speak are refused', () => {
  assertThrows(
    () => resolveTurn({ profile: 'chat', input: { text: 'hi' }, speech: { voice: 'Aoede' } }),
    TheoremError,
    'takes no speech settings',
  );
});

Deno.test('Interactions carries the style beside the script, and refuses a speed', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
    speech: { style: 'Slow and warm.' },
  });
  const req = speechRequest(generation);
  assertEquals(toInteractionsBody(req).input, [
    {
      type: 'user_input',
      content: [
        {
          type: 'text',
          text: 'Hello there',
          annotations: [{ type: 'speech_metadata', style: 'Slow and warm.' }],
        },
      ],
    },
  ]);
  assertThrows(
    () => toInteractionsBody({ ...req, speech: { ...req.speech, speed: 1.5 } }),
    TheoremError,
    'no speed field',
  );
});

Deno.test('Interactions body for speech uses audio response_format and speech_config', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Say hello' },
  });
  const body = toInteractionsBody(speechRequest(generation));

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
  const events = await Array.fromAsync(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
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
    ['media', 'response', 'done'],
  );
  const media = firstOf(events, 'media')?.media;
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
  const events = await Array.fromAsync(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
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
    ['text', 'response', 'done', 'error'],
  );
  assertEquals(firstOf(events, 'text')?.text, 'hello');
  assertEquals(firstOf(events, 'error')?.errorKind, 'bad_response');
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
  const events = await Array.fromAsync(
    provider.complete({
      model: generation.model,
      apiId: generation.apiId,
      thinking: generation.thinking,
      summaries: generation.summaries,
      maxOutputTokens: generation.maxOutputTokens,
      temperature: generation.temperature,
      builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
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

Deno.test('Interactions speech profile carries mp3 to the provider, which refuses it', () => {
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
  const { generation } = resolveTurn({ profile: 'bad-speech', input: { text: 'hi' } });
  assertEquals(generation.speech?.format, 'mp3');
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
    vault: vault,
  });
  assertEquals(typeof provider.complete, 'function');
});
