import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { profileAllowsInject } from '../../src/kernel/stop.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { createProvider } from '../../src/providers/create-provider.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import '../fixtures/test-host.ts';

registerGooglePreset();

Deno.test('pressure-test: type/protocol matrix rejects every illegal pair', () => {
  // type 'live' with protocol 'openAi' must throw
  assertThrows(
    () => {
      defineProfile({
        id: 'invalid_live_openai',
        type: 'live',
        identity: { handle: 'invalid_live' },
        models: {
          'openai/gpt-4o': {
            protocol: 'openAi' as unknown as 'geminiLive',
            provider: 'openrouter',
            apiId: 'openai/gpt-4o',
            efforts: { normal: 'minimal' },
          },
        },
        live: { voice: 'Aoede' },
        tools: { allow: [] },
      });
    },
    TheoremError,
    "type 'live' cannot use protocol 'openAi'",
  );

  // type 'text' with protocol 'geminiLive' must throw
  assertThrows(
    () => {
      defineProfile({
        id: 'invalid_text_gemini_live',
        type: 'text',
        identity: { handle: 'invalid_text' },
        models: {
          'gemini-2.0-flash-exp': {
            protocol: 'geminiLive' as unknown as 'geminiInteractions',
            provider: 'google',
            apiId: 'gemini-2.0-flash-exp',
            efforts: { normal: 'minimal' },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    "type 'text' cannot use protocol 'geminiLive'",
  );

  // type 'image' with protocol 'geminiLive' must throw
  assertThrows(
    () => {
      defineProfile({
        id: 'invalid_image_gemini_live',
        type: 'image',
        identity: { handle: 'invalid_image' },
        models: {
          'gemini-2.0-flash-exp': {
            protocol: 'geminiLive' as unknown as 'geminiInteractions',
            provider: 'google',
            apiId: 'gemini-2.0-flash-exp',
            efforts: { normal: 'minimal' },
          },
        },
        image: { mimeType: 'image/jpeg' },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    "type 'image' cannot use protocol 'geminiLive'",
  );

  // type 'speech' with protocol 'geminiLive' must throw
  assertThrows(
    () => {
      defineProfile({
        id: 'invalid_speech_gemini_live',
        type: 'speech',
        identity: { handle: 'invalid_speech' },
        models: {
          'gemini-2.0-flash-exp': {
            protocol: 'geminiLive' as unknown as 'geminiInteractions',
            provider: 'google',
            apiId: 'gemini-2.0-flash-exp',
            efforts: { normal: 'minimal' },
          },
        },
        speech: { voice: 'Kore', format: 'pcm' },
      });
    },
    TheoremError,
    "type 'speech' cannot use protocol 'geminiLive'",
  );
});

Deno.test('pressure-test: compaction is forbidden on non-text profiles', () => {
  // Register a compaction target profile first
  registerProfile({
    id: 'compactor_agent',
    type: 'text',
    identity: { handle: 'compactor' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
  });

  // Compaction on image profile must throw
  assertThrows(
    () => {
      registerProfile({
        id: 'invalid_image_compaction',
        type: 'image',
        identity: { handle: 'invalid_image' },
        models: {
          gemini31FlashLiteImage: {
            ...HOST_BINDINGS.gemini31FlashLiteImage,
            compaction: {
              maxTokens: 10000,
              compactAt: 0.8,
              previousExchanges: 2,
              profile: 'compactor_agent',
              timing: 'before',
            },
          },
        },
        image: { mimeType: 'image/jpeg' },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    "compaction is only valid on type 'text'",
  );

  // Compaction on speech profile must throw
  assertThrows(
    () => {
      registerProfile({
        id: 'invalid_speech_compaction',
        type: 'speech',
        identity: { handle: 'invalid_speech' },
        models: {
          gemini31FlashTts: {
            ...HOST_BINDINGS.gemini31FlashTts,
            compaction: {
              maxTokens: 10000,
              compactAt: 0.8,
              previousExchanges: 2,
              profile: 'compactor_agent',
              timing: 'before',
            },
          },
        },
        speech: { voice: 'Kore', format: 'pcm' },
      });
    },
    TheoremError,
    "compaction is only valid on type 'text'",
  );
});

Deno.test('pressure-test: compaction spec validations on text profiles', () => {
  // Subprofile not registered before must throw
  assertThrows(
    () => {
      registerProfile({
        id: 'chat_with_unregistered_compactor',
        type: 'text',
        identity: { handle: 'chat_compactor' },
        models: {
          gemini35FlashLite: {
            ...HOST_BINDINGS.gemini35FlashLite,
            compaction: {
              maxTokens: 10000,
              compactAt: 0.8,
              previousExchanges: 2,
              profile: 'non_existent_compactor',
              timing: 'before',
            },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    "compaction profile 'non_existent_compactor' must be registered before",
  );

  // Invalid compactAt (e.g. >= 1) must throw
  assertThrows(
    () => {
      registerProfile({
        id: 'chat_invalid_compact_at',
        type: 'text',
        identity: { handle: 'chat_compactor' },
        models: {
          gemini35FlashLite: {
            ...HOST_BINDINGS.gemini35FlashLite,
            compaction: {
              maxTokens: 10000,
              compactAt: 1.5,
              previousExchanges: 2,
              profile: 'compactor_agent',
              timing: 'before',
            },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    'compactAt must be in (0, 1)',
  );

  // Fractional previousExchanges >= compactAt must throw
  assertThrows(
    () => {
      registerProfile({
        id: 'chat_fractional_exchanges_overflow',
        type: 'text',
        identity: { handle: 'chat_compactor' },
        models: {
          gemini35FlashLite: {
            ...HOST_BINDINGS.gemini35FlashLite,
            compaction: {
              maxTokens: 10000,
              compactAt: 0.5,
              previousExchanges: 0.6,
              profile: 'compactor_agent',
              timing: 'before',
            },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
      });
    },
    TheoremError,
    'previousExchanges as fraction (0.6) must be < compactAt (0.5)',
  );
});

Deno.test('pressure-test: turnBehaviour.resumption maxContinues enforcement', () => {
  registerProfile({
    id: 'capped_continue_profile',
    type: 'text',
    identity: { handle: 'capped_bot' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    turnBehaviour: {
      resumption: {
        maxContinues: 3,
        allowContinue: ['length', 'stream_incomplete'],
      },
    },
  });

  // Valid continuation within bounds (attempt 1, 2, 3)
  for (const continuation of [1, 2, 3]) {
    const { profile, generation } = resolveTurn({
      profile: 'capped_continue_profile',
      continueFrom: { stop: { kind: 'length' } },
      continuation,
      input: { text: 'continue please' },
    });
    assertEquals(profile.id, 'capped_continue_profile');
    assertEquals(generation.transport, 'interactions');
  }

  // Continuation count exceeding maxContinues (attempt 4 > max 3) must throw
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
        continuation: 4,
        input: { text: 'continue please' },
      });
    },
    TheoremError,
    'continuation 4 exceeds turnBehaviour.resumption.maxContinues (3)',
  );

  // Continuation count < 1 must throw
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
        continuation: 0,
        input: { text: 'continue please' },
      });
    },
    TheoremError,
    'continuation must be >= 1',
  );

  // Missing continuation parameter when maxContinues is set must throw
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
        input: { text: 'continue please' },
      });
    },
    TheoremError,
    'continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set',
  );

  // continueFrom on live profile must throw
  registerProfile({
    id: 'live_test_profile',
    type: 'live',
    identity: { handle: 'live_bot' },
    models: {
      'gemini-2.0-flash-exp': {
        protocol: 'geminiLive',
        provider: 'google',
        apiId: 'gemini-2.0-flash-exp',
        efforts: { normal: 'minimal' },
      },
    },
    live: { voice: 'Aoede', sessionResumption: true },
    tools: { allow: [] },
  });

  assertThrows(
    () => {
      resolveTurn({
        profile: 'live_test_profile',
        continueFrom: { stop: { kind: 'length' } },
        input: { text: 'hello' },
      });
    },
    TheoremError,
    "type 'live' uses live.sessionResumption, not turnBehaviour.resumption/continueFrom",
  );
});

Deno.test('pressure-test: turnBehaviour.allowSteering rejected on image', () => {
  assertThrows(
    () => {
      registerProfile({
        id: 'image_steer_illegal',
        type: 'image',
        identity: { handle: 'img' },
        models: {
          'openai/dall-e-3': {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: 'openai/dall-e-3',
            efforts: { normal: 'minimal' },
          },
        },
        image: { mimeType: 'image/png' },
        tools: { allow: [] },
        inputs: { text: true },
        turnBehaviour: { allowSteering: true },
      });
    },
    TheoremError,
    "turnBehaviour.allowSteering is only valid on type 'text' or 'live'",
  );
});

Deno.test('pressure-test: turnBehaviour.allowSteering accepted on live', () => {
  const profile = defineProfile({
    type: 'live',
    id: 'live_steer_ok',
    identity: { handle: 'live' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
    turnBehaviour: { allowSteering: false },
  });
  assertEquals(profile.turnBehaviour?.allowSteering, false);
  assertEquals(profileAllowsInject(profile), false);
});

Deno.test('pressure-test: turnBehaviour.resumption rejects non-ContinueStopKind', () => {
  assertThrows(
    () => {
      registerProfile({
        id: 'continue_kind_illegal',
        type: 'text',
        identity: { handle: 't', system: 's' },
        models: {
          'openai/gpt-4o-mini': {
            protocol: 'openAi',
            provider: 'openrouter',
            apiId: 'openai/gpt-4o-mini',
            efforts: { normal: 'minimal' },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
        turnBehaviour: {
          resumption: {
            // @ts-expect-error intentional illegal kind
            allowContinue: ['cancelled'],
          },
        },
      });
    },
    TheoremError,
    'may only include ContinueStopKind',
  );
});

Deno.test('pressure-test: outputs.streaming.mode resolution', () => {
  // mode = 'sse' -> stream = true
  registerProfile({
    id: 'sse_stream_profile',
    type: 'text',
    identity: { handle: 'sse_bot' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { streaming: { mode: 'sse' } },
  });
  assertEquals(
    resolveTurn({ profile: 'sse_stream_profile', input: { text: 'hi' } }).generation.stream,
    true,
  );

  // mode = 'buffered' -> stream = false
  registerProfile({
    id: 'buffered_stream_profile',
    type: 'text',
    identity: { handle: 'buffered_bot' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { streaming: { mode: 'buffered' } },
  });
  assertEquals(
    resolveTurn({ profile: 'buffered_stream_profile', input: { text: 'hi' } }).generation.stream,
    false,
  );

  // mode omitted -> stream = true (THEOREM SSE default)
  registerProfile({
    id: 'omitted_stream_profile',
    type: 'text',
    identity: { handle: 'omitted_bot' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { streaming: { streamThoughts: true } },
  });
  assertEquals(
    resolveTurn({ profile: 'omitted_stream_profile', input: { text: 'hi' } }).generation.stream,
    true,
  );
});

Deno.test('pressure-test: speech profile ingress restrictions and format validation', () => {
  // Speech profile rejects mp3 format when protocol is geminiInteractions
  registerProfile({
    id: 'speech_invalid_mp3',
    type: 'speech',
    identity: { handle: 'speech_mp3' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'mp3' },
  });

  assertThrows(
    () => {
      resolveTurn({ profile: 'speech_invalid_mp3', input: { text: 'hello' } });
    },
    TheoremError,
    "speech.format 'mp3' requires protocol 'openAi'",
  );

  // Valid speech profile with pcm
  registerProfile({
    id: 'speech_valid_pcm',
    type: 'speech',
    identity: { handle: 'speech_pcm' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'pcm' },
  });

  // Speech requires non-empty text input
  assertThrows(
    () => {
      resolveTurn({ profile: 'speech_valid_pcm', input: { text: '' } });
    },
    TheoremError,
    'Profile speech_valid_pcm (speech) requires text input',
  );
  assertThrows(
    () => {
      resolveTurn({ profile: 'speech_valid_pcm', input: { text: '   ' } });
    },
    TheoremError,
    'Profile speech_valid_pcm (speech) requires text input',
  );

  // Speech rejects media input (attachments or voice)
  assertThrows(
    () => {
      resolveTurn({
        profile: 'speech_valid_pcm',
        input: {
          text: 'speak this',
          attachments: [{ mimeType: 'image/png', data: 'abc' }],
        },
      });
    },
    TheoremError,
    'Profile speech_valid_pcm (speech) does not accept media input',
  );
  assertThrows(
    () => {
      resolveTurn({
        profile: 'speech_valid_pcm',
        input: {
          text: 'speak this',
          voice: [{ mimeType: 'audio/wav', data: 'abc' }],
        },
      });
    },
    TheoremError,
    'Profile speech_valid_pcm (speech) does not accept media input',
  );

  // Valid speech input resolves cleanly
  const { generation } = resolveTurn({
    profile: 'speech_valid_pcm',
    input: { text: 'speak this' },
  });
  assertEquals(generation.speech?.voice, 'Kore');
  assertEquals(generation.speech?.format, 'pcm');
  assertEquals(generation.image, null);
  assertEquals(generation.live, undefined);
});

Deno.test('pressure-test: projectProfile output projections for all 4 types', () => {
  // Text projection
  const chatProj = projectProfile('chat');
  assertEquals(chatProj.type, 'text');
  assertEquals(chatProj.image, null);
  assertEquals(chatProj.speech, null);
  assertEquals(chatProj.live, null);
  assertEquals(chatProj.inputs?.text, true);

  // Image projection
  const imageProj = projectProfile('image');
  assertEquals(imageProj.type, 'image');
  assertEquals(imageProj.image?.mimeType, 'image/jpeg');
  assertEquals(imageProj.speech, null);
  assertEquals(imageProj.live, null);
  assertEquals(imageProj.inputs?.text, true);

  // Speech projection
  const speechProj = projectProfile('speech_valid_pcm');
  assertEquals(speechProj.type, 'speech');
  assertEquals(speechProj.inputs, null);
  assertEquals(speechProj.tools, []);
  assertEquals(speechProj.speech?.voice, 'Kore');
  assertEquals(speechProj.image, null);
  assertEquals(speechProj.live, null);

  // Live projection
  const liveProj = projectProfile('live_test_profile');
  assertEquals(liveProj.type, 'live');
  assertEquals(liveProj.live?.voice, 'Aoede');
  assertEquals(liveProj.live?.sessionResumption, true);
  assertEquals(liveProj.speech, null);
  assertEquals(liveProj.image, null);
});

Deno.test('pressure-test: createProvider type routing and boundary enforcement', () => {
  const speechProfile = getProfile('speech_valid_pcm');
  const imageProfile = getProfile('image');
  const chatProfile = getProfile('chat');
  const liveProfile = getProfile('live_test_profile');

  // Google interactions for speech, image, chat
  const googleTransport = {
    vault: { slotA: 'fake-key', slotB: undefined, slotC: undefined, paid: undefined },
  };
  const googleSpeech = createProvider(speechProfile, { gemini: googleTransport });
  assertEquals(typeof googleSpeech.complete, 'function');

  const googleImage = createProvider(imageProfile, { gemini: googleTransport });
  assertEquals(typeof googleImage.complete, 'function');

  const googleChat = createProvider(chatProfile, { gemini: googleTransport });
  assertEquals(typeof googleChat.complete, 'function');

  assertThrows(
    () => {
      createProvider(liveProfile, { gemini: googleTransport });
    },
    TheoremError,
    "createProvider does not support type 'live' / geminiLive — use runSession(req, { gemini })",
  );

  // OpenRouter speech/image/chat
  const openAiSpeechProfile = defineProfile({
    id: 'openai_speech_prof',
    type: 'speech',
    identity: { handle: 'openai_speech' },
    models: {
      'openai/tts-1': {
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: 'openai/tts-1',
        efforts: { normal: 'minimal' },
      },
    },
    speech: { voice: 'alloy', format: 'mp3' },
  });
  const openRouterSpeech = createProvider(openAiSpeechProfile, {
    openAiGateway: { apiKey: 'fake-key' },
  });
  assertEquals(typeof openRouterSpeech.complete, 'function');

  const openAiImageProfile = defineProfile({
    id: 'openai_image_prof',
    type: 'image',
    identity: { handle: 'openai_image' },
    models: {
      'openai/dall-e-3': {
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: 'openai/dall-e-3',
        efforts: { normal: 'minimal' },
      },
    },
    image: { mimeType: 'image/png' },
    tools: { allow: [] },
    inputs: { text: true },
  });
  const openRouterImage = createProvider(openAiImageProfile, {
    openAiGateway: { apiKey: 'fake-key' },
  });
  assertEquals(typeof openRouterImage.complete, 'function');

  // Local provider with image type must throw
  const localImageProfile = defineProfile({
    id: 'local_image_prof',
    type: 'image',
    identity: { handle: 'local_image' },
    models: {
      'local-sd': {
        protocol: 'openAi',
        provider: 'local',
        apiId: 'local-sd',
        efforts: { normal: 'minimal' },
      },
    },
    image: { mimeType: 'image/png' },
    tools: { allow: [] },
    inputs: { text: true },
  });
  assertThrows(
    () => {
      createProvider(localImageProfile, { local: { baseUrl: 'http://localhost:11434' } });
    },
    TheoremError,
    'createProvider: type image requires openrouter provider for openAi protocol',
  );
});
