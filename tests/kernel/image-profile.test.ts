import '../fixtures/test-host.ts';
import { wrapUserData } from '../../src/guardrails/canary.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  projectProfile,
  registerProfile,
  resolveTurn,
  runTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile, type ProfileDefinition } from '../../src/kernel/registry/profiles.ts';
import { providerBuiltins } from '../../src/kernel/registry/provider-request.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { camelToSnake, toInteractionsBody } from '../../src/providers/google/interactions/mod.ts';
import { CHAT_MEDIA_LIMITS, geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import { eventTypesByReply } from '../fixtures/reply.ts';

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
  assertEquals(generation.keySlot, 'slot_b');
  assertEquals(generation.thinking, 'minimal');
  assertEquals(generation.structured, null);
  assertEquals(generation.image, {
    type: 'image',
    mimeType: 'image/jpeg',
    aspectRatio: '1:1',
    resolution: '1K',
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
    TheoremError,
  );
});

Deno.test('image rejects mime the image model does not take', () => {
  assertThrows(
    () =>
      resolveTurn({
        profile: 'image',
        input: { text: 'x', attachments: [{ mimeType: 'image/gif', data: 'x' }] },
      }),
    TheoremError,
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
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
      resolution: '1K',
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
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: 'sys',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: generation.keySlot,
  });
  assertImageWithTextWireBody(body);
});

Deno.test('image runTurn yields media then done', async () => {
  const events = await Array.fromAsync(runTurn({ profile: 'image', input: { text: 'fox' } }, fake));
  assertEquals(eventTypesByReply(events), [
    'stage',
    'text',
    'media',
    'tokens',
    'stage',
    'done',
    'stage',
  ]);
  const media = events.find((e) => e.type === 'media');
  assertEquals(media?.media?.mimeType, 'image/jpeg');
  // The fake reports no usage: both sides are estimated and the image output is uncounted.
  const tokens = events.find((e) => e.type === 'tokens')?.tokens;
  assertEquals(tokens?.estimated, ['input', 'output']);
  assertEquals(tokens?.unknownMedia, { output: 1 });
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
  assertEquals(ui.image?.resolution, '1K');
  assertEquals(ui.models.gemini31FlashLiteImage.summaries, false);
});

Deno.test('media validations allow omitted aspect/resolution; reject structured mixing and invalid mime', () => {
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
    resolution: undefined,
    includeText: false,
  });

  // A structured reply on an image profile is refused when the profile is defined
  assertThrows(
    () =>
      defineProfile({
        id: 'mixed_media_profile',
        type: 'image',
        identity: { handle: 'mixed_media_profile' },
        ...geminiModels('gemini31FlashLiteImage'),
        image: { aspectRatio: '1:1', resolution: '1K', mimeType: 'image/jpeg' },
        tools: { allow: [] },
        inputs: { text: true },
        outputs: {
          structured: 'chatTurn',
        },
        guardrails: { quota: { perDay: 10 } },
      }),
    TheoremError,
    'outputs.structured',
  );

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
      key: 'slot_a',
      image: {
        aspectRatio: '1:1',
        resolution: '1K',
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
      key: 'slot_a',
      image: {
        aspectRatio: '1:1',
        resolution: '1K',
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
    guardrails: { sanitizeInput: false, redactSensitive: false },
  });
  assertEquals(
    resolveTurn({ profile: 'speech_output_test', input: { text: 'hi' } }).generation.speech,
    {
      voice: 'Kore',
      format: 'pcm',
    },
  );
});

function speechDefinition(overrides: Record<string, unknown>): ProfileDefinition {
  return {
    type: 'speech',
    id: 'speech_contract',
    identity: { handle: 'speech_contract' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore' },
    ...overrides,
  } as ProfileDefinition;
}

Deno.test('speech profiles store canary off and resolve no system prompt or canary', () => {
  const profile = defineProfile(speechDefinition({}));
  assertEquals(profile.type === 'speech' && profile.guardrails, { canary: false });
  registerProfile(profile);
  const { generation } = resolveTurn({ profile: 'speech_contract', input: { text: 'hi' } });
  assertEquals(generation.canary, '');
  assertEquals(generation.resolvedSystem, '');
});

Deno.test('speech profiles reject a system prompt and a canary', () => {
  for (const overrides of [
    { identity: { handle: 'speech_contract', system: 'Speak warmly.' } },
    { identity: { handle: 'speech_contract', systemByRole: { a: 'Speak warmly.' } } },
    { guardrails: { canary: true } },
    { guardrails: { canary: { bindNote: 'token {canary}' } } },
  ]) {
    assertThrows(() => defineProfile(speechDefinition(overrides)), TheoremError);
  }
});

Deno.test('speech turns reject a host system prompt', () => {
  registerProfile(speechDefinition({}));
  assertThrows(
    () =>
      resolveTurn({ profile: 'speech_contract', system: 'Speak warmly.', input: { text: 'hi' } }),
    TheoremError,
  );
});

Deno.test('image and speech continueFrom re-send the request with nothing added', () => {
  registerProfile(speechDefinition({}));
  for (const req of [
    { profile: 'image', input: { text: 'sleepy fox' } },
    { profile: 'speech_contract', input: { text: 'hi' } },
  ]) {
    const fresh = resolveTurn(req).generation;
    const resumed = resolveTurn({
      ...req,
      continueFrom: { stop: { kind: 'provider_error' } },
    }).generation;
    assertEquals(resumed.input, fresh.input);
    assertEquals(resumed.resolvedSystem, fresh.resolvedSystem);
  }
});

Deno.test('image and speech profiles take a lexicon; continueFrom still adds nothing', () => {
  const lexicon = { 'continue.instruction': 'Keep going.', 'error.internal': 'Host copy.' };
  registerProfile(speechDefinition({ id: 'speech_lexicon', lexicon }));
  registerProfile(
    defineProfile({
      type: 'image',
      id: 'image_lexicon',
      identity: { handle: 'image_lexicon' },
      ...geminiModels('gemini31FlashLiteImage'),
      maxSteps: 1,
      image: { aspectRatio: '1:1', resolution: '1K', mimeType: 'image/jpeg' },
      tools: { allow: [] },
      inputs: { text: true },
      lexicon,
    }),
  );
  for (const profile of ['speech_lexicon', 'image_lexicon']) {
    const req = { profile, input: { text: 'hi' } };
    const resumed = resolveTurn({ ...req, continueFrom: { stop: { kind: 'provider_error' } } });
    assertEquals(resumed.generation.input, resolveTurn(req).generation.input);
    assertEquals(JSON.stringify(resumed.generation).includes('Keep going.'), false);
  }
});

function imageWithInputs(id: string, inputs: Record<string, unknown>): ProfileDefinition {
  return {
    id,
    type: 'image',
    identity: { handle: id },
    ...geminiModels('gemini31FlashLiteImage'),
    image: { mimeType: 'image/jpeg' },
    tools: { allow: [] },
    inputs: { text: true, ...CHAT_MEDIA_LIMITS, ...inputs },
  } as ProfileDefinition;
}

Deno.test('image attachments take images, video and PDF', () => {
  const accept = ['image/*', 'video/mp4', 'application/pdf'];
  const profile = defineProfile(imageWithInputs('image_accepts', { attachments: { accept } }));
  assertEquals(profile.type === 'image' && profile.inputs.attachments?.accept, accept);
});

Deno.test('image attachments refuse audio, text and other documents', () => {
  for (const mime of ['audio/wav', 'text/plain', 'application/json', '*/*']) {
    assertThrows(
      () => defineProfile(imageWithInputs('image_refuses', { attachments: { accept: [mime] } })),
      TheoremError,
      `PDF only, not ${mime}`,
    );
  }
});

Deno.test('an image profile takes no voice', () => {
  assertThrows(
    () => defineProfile(imageWithInputs('image_voice', { voice: { accept: ['audio/wav'] } })),
    TheoremError,
    'must not set inputs.voice',
  );
});

Deno.test('image pins reach the resolved image format; unset pins stay unset', () => {
  registerProfile(
    defineProfile({
      ...imageWithInputs('image_pinned', {}),
      image: { quality: 'high', background: 'opaque', n: 2, seed: 7, outputCompression: 60 },
    } as ProfileDefinition),
  );
  const { image } = resolveTurn({ profile: 'image_pinned', input: { text: 'hi' } }).generation;
  assertEquals(image?.quality, 'high');
  assertEquals(image?.background, 'opaque');
  assertEquals(image?.n, 2);
  assertEquals(image?.seed, 7);
  assertEquals(image?.outputCompression, 60);
  const plain = resolveTurn({ profile: 'image', input: { text: 'hi' } }).generation.image;
  assertEquals(plain?.quality, undefined);
  assertEquals(plain?.n, undefined);
});

Deno.test('image pins are checked as whole numbers in range', () => {
  for (const image of [
    { n: 0 },
    { n: 1.5 },
    { seed: 0.5 },
    { outputCompression: 101 },
    { outputCompression: -1 },
  ]) {
    assertThrows(
      () => defineProfile({ ...imageWithInputs('image_bad_pin', {}), image } as ProfileDefinition),
      TheoremError,
      'image.',
    );
  }
});

Deno.test('image references go ahead of the turn attachments, before any wire', () => {
  registerProfile(
    defineProfile({
      ...imageWithInputs('image_refs', { attachments: { accept: ['image/*'] } }),
      image: {
        references: [
          { mimeType: 'image/png', data: 'pinned' },
          { mimeType: 'image/jpg', uri: 'https://example.com/a.jpg' },
        ],
      },
    } as ProfileDefinition),
  );
  const { input } = resolveTurn({
    profile: 'image_refs',
    input: { text: 'hi', attachments: [{ mimeType: 'image/webp', data: 'turn' }] },
  }).generation;
  assertEquals(input.slice(1), [
    { type: 'image', mimeType: 'image/png', data: 'pinned' },
    { type: 'image', mimeType: 'image/jpeg', uri: 'https://example.com/a.jpg' },
    { type: 'image', mimeType: 'image/webp', data: 'turn' },
  ]);
});

Deno.test('image references must be images with a source', () => {
  for (const references of [
    [{ mimeType: 'video/mp4', data: 'x' }],
    [{ mimeType: 'image/png', data: '' }],
    [{ mimeType: 'image/png', uri: '' }],
  ]) {
    assertThrows(
      () =>
        defineProfile({
          ...imageWithInputs('image_bad_ref', {}),
          image: { references },
        } as ProfileDefinition),
      TheoremError,
      'image.references[0]',
    );
  }
});
