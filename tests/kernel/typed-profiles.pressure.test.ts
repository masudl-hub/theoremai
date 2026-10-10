import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { projectProfile, registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { type MediaTurnBehaviourSpec, profileAllowsInject } from '../../src/kernel/stop.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import '../fixtures/test-host.ts';

registerGooglePreset();
Deno.test('pressure-test: registration rejects unsupported provider operations', () => {
  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          id: 'invalid_live',
          type: 'live',
          identity: { handle: 'Live' },
          models: { main: { provider: 'openrouter', apiId: 'model' } },
          tools: { allow: [] },
          live: { voice: 'Aoede' },
        }),
      ),
    TheoremError,
    'cannot run',
  );
});
Deno.test('pressure-test: image and speech profiles may compact', () => {
  registerProfile({
    id: 'compactor_agent',
    type: 'text',
    identity: { handle: 'compactor' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
  });
  registerProfile({
    id: 'image_compaction',
    type: 'image',
    identity: { handle: 'image' },
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
  registerProfile({
    id: 'speech_compaction',
    type: 'speech',
    identity: { handle: 'speech' },
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
});
Deno.test('pressure-test: compaction spec validations on text profiles', () => {
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
  for (const continuation of [1, 2, 3]) {
    const { profile, generation } = resolveTurn({
      profile: 'capped_continue_profile',
      continueFrom: { stop: { kind: 'length' } },
      continuation,
    });
    assertEquals(profile.id, 'capped_continue_profile');
    assertEquals(generation.transport, 'turn');
  }
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
        continuation: 4,
      });
    },
    TheoremError,
    'continuation 4 exceeds turnBehaviour.resumption.maxContinues (3)',
  );
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
        continuation: 0,
      });
    },
    TheoremError,
    'continuation must be >= 1',
  );
  assertThrows(
    () => {
      resolveTurn({
        profile: 'capped_continue_profile',
        continueFrom: { stop: { kind: 'length' } },
      });
    },
    TheoremError,
    'continueFrom requires TurnRequest.continuation when turnBehaviour.resumption.maxContinues is set',
  );
  registerProfile({
    id: 'live_test_profile',
    type: 'live',
    identity: { handle: 'live_bot' },
    models: {
      'gemini-2.0-flash-exp': {
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
            provider: 'openrouter',
            apiId: 'openai/dall-e-3',
            efforts: { normal: 'minimal' },
          },
        },
        image: { mimeType: 'image/png' },
        tools: { allow: [] },
        inputs: { text: true },
        // The image type omits allowSteering; an untyped host can still send it.
        turnBehaviour: { allowSteering: true } as MediaTurnBehaviourSpec,
      });
    },
    TheoremError,
    "type 'image' must not set turnBehaviour.allowSteering",
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
        keySlot: 'main',
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
            provider: 'openrouter',
            apiId: 'openai/gpt-4o-mini',
            efforts: { normal: 'minimal' },
          },
        },
        tools: { allow: [] },
        inputs: { text: true },
        turnBehaviour: {
          resumption: {
            allowContinue: ['cancelled'],
          },
        },
      } as never);
    },
    TheoremError,
    'may only include ContinueStopKind',
  );
});
Deno.test('pressure-test: outputs.streaming.mode resolution', () => {
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
  registerProfile({
    id: 'speech_mp3_resolves',
    type: 'speech',
    identity: { handle: 'speech_mp3' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'mp3' },
  });
  resolveTurn({ profile: 'speech_mp3_resolves', input: { text: 'hello' } });
  registerProfile({
    id: 'speech_valid_pcm',
    type: 'speech',
    identity: { handle: 'speech_pcm' },
    ...geminiModels('gemini31FlashTts'),
    speech: { voice: 'Kore', format: 'pcm' },
  });
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
  const chatProj = projectProfile('chat');
  assertEquals(chatProj.type, 'text');
  assertEquals(chatProj.image, null);
  assertEquals(chatProj.speech, null);
  assertEquals(chatProj.live, null);
  assertEquals(chatProj.inputs?.text, true);
  const imageProj = projectProfile('image');
  assertEquals(imageProj.type, 'image');
  assertEquals(imageProj.image?.mimeType, 'image/jpeg');
  assertEquals(imageProj.speech, null);
  assertEquals(imageProj.live, null);
  assertEquals(imageProj.inputs?.text, true);
  const speechProj = projectProfile('speech_valid_pcm');
  assertEquals(speechProj.type, 'speech');
  assertEquals(speechProj.inputs, null);
  assertEquals(speechProj.tools, []);
  assertEquals(speechProj.speech?.voice, 'Kore');
  assertEquals(speechProj.image, null);
  assertEquals(speechProj.live, null);
  const liveProj = projectProfile('live_test_profile');
  assertEquals(liveProj.type, 'live');
  assertEquals(liveProj.live?.voice, 'Aoede');
  assertEquals(liveProj.live?.sessionResumption, true);
  assertEquals(liveProj.speech, null);
  assertEquals(liveProj.image, null);
});
