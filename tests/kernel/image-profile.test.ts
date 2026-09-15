import '../fixtures/test-host.ts';
import { wrapUserData } from '../../src/guardrails/canary.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { registerProfile } from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/google/interactions/mod.ts';
import { CHAT_MEDIA_LIMITS, geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function* fakeComplete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
  await Promise.resolve();
  yield { type: 'text', text: `${req.model}:${req.thinking}` };
  if (req.image) {
    yield {
      type: 'media',
      media: { mimeType: req.image.mimeType ?? 'image/png', data: 'image-bytes' },
    };
  }
}

const fake: ModelProvider = { complete: fakeComplete };

Deno.test('image oneshot uses image model and image response format', () => {
  const { generation } = resolveTurn({
    profile: 'image',
    input: {
      text: 'sleepy fox',
      attachments: [{ mimeType: 'image/png', data: 'ex' }],
    },
  });
  assertEquals(generation.model, 'gemini31FlashLiteImage');
  assertEquals(generation.keySlot, 'paid');
  assertEquals(generation.thinking, 'minimal');
  assertEquals(generation.structured, null);
  assertEquals(generation.image, {
    type: 'image',
    mimeType: 'image/jpeg',
    aspectRatio: '1:1',
    size: '1K',
    includeText: false,
  });
  assertEquals(generation.input, [
    { type: 'text', text: wrapUserData('sleepy fox') },
    { type: 'image', mimeType: 'image/png', data: 'ex' },
  ]);
  assertEquals(generation.builtins, []);
});

Deno.test('image rejects too many reference images', () => {
  const images = Array.from({ length: CHAT_MEDIA_LIMITS.maxFiles + 1 }, () => ({
    mimeType: 'image/png',
    data: btoa('x'),
  }));
  assertThrows(
    () => resolveTurn({ profile: 'image', input: { text: 'x', attachments: images } }),
    TheorumError,
  );
});

Deno.test('image rejects mime the image model does not take', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'image',
        input: { text: 'x', attachments: [{ mimeType: 'image/gif', data: 'x' }] },
      }),
    TheorumError,
  );
});

function googleImageBody() {
  const { generation } = resolveTurn({
    profile: 'image',
    input: { text: 'fox', attachments: [{ mimeType: 'image/jpeg', data: 'abc' }] },
  });
  return toInteractionsBody({
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
    keySlot: generation.keySlot,
  });
}

function assertImageWireBody(body: Record<string, unknown>): void {
  const turns = body.input as { type: string; content: Record<string, string>[] }[];
  const [turn] = turns;
  const [textPart, part] = turn.content;
  const format = body[camelToSnake('responseFormat')] as Record<string, string>;
  const mimeKey = camelToSnake('mimeType');
  assertEquals(body.model, 'gemini-3.1-flash-lite-image');
  assertEquals(body[camelToSnake('systemInstruction')], 'sys');
  assertEquals(turn.type, 'user_input');
  assertEquals(textPart, { type: 'text', text: wrapUserData('fox') });
  assertEquals(part.type, 'image');
  assertEquals(part.data, 'abc');
  assertEquals(part[mimeKey], 'image/jpeg');
  assertEquals(format.type, 'image');
  assertEquals(format[mimeKey], 'image/jpeg');
  assertEquals(format[camelToSnake('aspectRatio')], '1:1');
  assertEquals(format[camelToSnake('imageSize')], '1K');
  assertEquals(Object.hasOwn(body, camelToSnake('responseModalities')), false);
}

function assertImageWithTextWireBody(body: Record<string, unknown>): void {
  const format = body[camelToSnake('responseFormat')] as Record<string, unknown>[];
  assertEquals(Array.isArray(format), true);
  assertEquals(format[0], { type: 'text' });
  assertEquals(format[1]?.type, 'image');
  assertEquals(format[1]?.[camelToSnake('mimeType')], 'image/jpeg');
  assertEquals(format[1]?.[camelToSnake('aspectRatio')], '1:1');
  assertEquals(format[1]?.[camelToSnake('imageSize')], '1K');
  assertEquals(Object.hasOwn(body, camelToSnake('responseModalities')), false);
}

Deno.test('interactions body places refs in input and image in response format', () => {
  assertImageWireBody(googleImageBody());
});

Deno.test('interactions body requests text and image when includeText is set', () => {
  registerProfile({
    id: 'image_with_text',
    type: 'image',
    identity: { handle: 'image_with_text' },
    ...geminiModels('gemini31FlashLiteImage'),
    image: {
      aspectRatio: '1:1',
      size: '1K',
      mimeType: 'image/jpeg',
      includeText: true,
    },
    tools: { allow: [] },
    inputs: {
      text: true,
    },
    outputs: {
      structured: null,
    },
    guardrails: { quota: { perDay: 10 } },
  });
  const { generation } = resolveTurn({
    profile: 'image_with_text',
    input: { text: 'fox' },
  });
  assertEquals(generation.image?.includeText, true);
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
    keySlot: generation.keySlot,
  });
  assertImageWithTextWireBody(body);
});

Deno.test('image runTurn yields media then done', async () => {
  const events = await collect(runTurn({ profile: 'image', input: { text: 'fox' } }, fake));
  assertEquals(
    events.map((e) => e.type),
    ['stage', 'text', 'media', 'stage', 'tokens', 'done', 'stage'],
  );
  const media = events.find((e) => e.type === 'media');
  assertEquals(media?.media?.mimeType, 'image/jpeg');
});

Deno.test('chat profile does not attach image response format', () => {
  const { generation } = resolveTurn({ profile: 'chat', input: { text: 'hi' } });
  assertEquals(generation.image, null);
  assertEquals(generation.input, [{ type: 'text', text: wrapUserData('hi') }]);
});

Deno.test('image projection exposes image pins not tools', () => {
  const ui = projectProfile('image');
  assertEquals(ui.tools, []);
  assertEquals(ui.outputs?.structured, null);
  assertEquals(ui.image?.mimeType, 'image/jpeg');
  assertEquals(ui.image?.size, '1K');
  assertEquals(ui.image?.maxInputImages, 14);
  assertEquals(ui.models.gemini31FlashLiteImage.summaries, false);
});

Deno.test('media validations allow omitted aspect/size; reject structured mixing and invalid mime', async () => {
  const { registerProfile, defineProfile } = await import('../../src/kernel/registry/profiles.ts');

  // Image pins without aspect/size — provider defaults apply
  registerProfile(
    defineProfile({
      id: 'image_defaults_profile',
      type: 'image',
      identity: { handle: 'image_defaults_profile' },
      ...geminiModels('gemini31FlashLiteImage'),
      image: { mimeType: 'image/jpeg' },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: null },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const defaults = resolveTurn({
    profile: 'image_defaults_profile',
    input: { text: 'test' },
  }).generation;
  assertEquals(defaults.image, {
    type: 'image',
    mimeType: 'image/jpeg',
    aspectRatio: undefined,
    size: undefined,
    includeText: false,
  });

  // Image pins with responseFormat-enforced structured output
  registerProfile(
    defineProfile({
      id: 'mixed_media_profile',
      type: 'image',
      identity: { handle: 'mixed_media_profile' },
      ...geminiModels('gemini31FlashLiteImage'),
      image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg' },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: 'chatTurn',
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertThrows(
    () => resolveTurn({ profile: 'mixed_media_profile', input: { text: 'test' } }),
    TheorumError,
  );

  // Prompt-enforced structured + image is allowed (no competing responseFormat)
  registerProfile(
    defineProfile({
      id: 'image_with_prompt_schema',
      type: 'image',
      identity: { handle: 'image_with_prompt_schema' },
      ...geminiModels('gemini31FlashLiteImage'),
      image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg' },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: 'promptTurn',
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const promptImage = resolveTurn({
    profile: 'image_with_prompt_schema',
    input: { text: 'fox' },
  }).generation;
  assertEquals(promptImage.structured, 'promptTurn');
  assertEquals(promptImage.image?.type, 'image');

  // codeExecution on image profiles is a host/model choice — kernel does not block it
  registerProfile(
    defineProfile({
      id: 'image_with_code_exec',
      type: 'image',
      identity: { handle: 'image_with_code_exec' },
      models: {
        gemini31FlashLiteImage: {
          ...HOST_BINDINGS.gemini31FlashLiteImage,
          builtInTools: ['codeExecution'],
        },
      },
      key: 'slotA',
      image: {
        aspectRatio: '1:1',
        size: '1K',
        mimeType: 'image/jpeg',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: null,
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'image_with_code_exec', input: { text: 'plot' } }).generation.builtins,
    ['codeExecution'],
  );

  // googleSearch on image profiles is a host/model choice — kernel does not block it
  registerProfile(
    defineProfile({
      id: 'image_with_search',
      type: 'image',
      identity: { handle: 'image_with_search' },
      models: {
        gemini31FlashLiteImage: {
          ...HOST_BINDINGS.gemini31FlashLiteImage,
          builtInTools: ['googleSearch'],
        },
      },
      key: 'slotA',
      image: {
        aspectRatio: '1:1',
        size: '1K',
        mimeType: 'image/jpeg',
      },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {
        structured: null,
      },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  assertEquals(
    resolveTurn({ profile: 'image_with_search', input: { text: 'search image' } }).generation
      .builtins,
    ['googleSearch'],
  );
});

Deno.test('speech profiles use top-level speech pins', () => {
  registerProfile({
    id: 'speech_output_test',
    type: 'speech',
    identity: { handle: 'speech_output_test' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'pcm' },
    guardrails: { canary: false, sanitizeInput: false, redactSensitive: false },
  });
  assertEquals(
    resolveTurn({ profile: 'speech_output_test', input: { text: 'hi' } }).generation.speech,
    {
      voice: 'Kore',
      format: 'pcm',
    },
  );
});
