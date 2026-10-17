import '../../../fixtures/test-host.ts';
import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import { registerProfile, resolveTurn } from '../../../../src/kernel/default-scope.ts';
import { providerBuiltins } from '../../../../src/kernel/registry/provider-request.ts';
import { defaultKernelScope } from '../../../../src/kernel/scope.ts';
import {
  camelToSnake,
  toInteractionsBody,
} from '../../../../src/providers/google/interactions/framing.ts';
import { geminiModels } from '../../../fixtures/models.ts';

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

Deno.test('Interactions carries the style beside the script on a model that reads it, and refuses a speed', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
    speech: { style: 'Slow and warm.' },
  });
  const req = { ...speechRequest(generation), apiId: 'gemini-3.8-flash-tts' };
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

Deno.test('a speech model that refuses speech_metadata hears the style as a direction before the script', () => {
  const { generation } = resolveTurn({
    profile: 'speech',
    input: { text: 'Hello there' },
    speech: { style: 'Slow and warm.' },
  });
  const body = toInteractionsBody(speechRequest(generation));
  assertEquals(body.model, 'gemini-3.1-flash-tts-preview');
  assertEquals(body.input, [
    {
      type: 'user_input',
      content: [
        { type: 'text', text: 'Read the following aloud. Slow and warm.\n' },
        { type: 'text', text: 'Hello there' },
      ],
    },
  ]);
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
