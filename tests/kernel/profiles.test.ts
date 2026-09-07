import { assertEquals, assertThrows } from '@std/assert';
import {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from '../../src/kernel/registry/profiles.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { geminiModel, modelAllow } from '../fixtures/models.ts';

registerGooglePreset();

Deno.test('defineProfile preserves explicit typed fields without defaults', () => {
  const profile = defineProfile({
    id: 'host_profile',
    type: 'text',
    identity: { handle: 'host_profile' },
    model: {
      ...geminiModel('gemini35FlashLite'),
      thinking: 'low',
      maxSteps: 1,
      key: 'slotA',
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null },
    guardrails: { canary: true, sanitizeInput: true },
  });

  assertEquals(profile.id, 'host_profile');
  assertEquals(profile.type, 'text');
  assertEquals(profile.model.protocol, 'geminiInteractions');
  assertEquals(profile.model.provider, 'google');
  assertEquals(profile.model.maxSteps, 1);
  assertEquals(profile.model.key, 'slotA');
  assertEquals(profile.identity.handle, 'host_profile');
  if (profile.type !== 'text') throw new Error('Expected text profile');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs?.structured, null);
  assertEquals(profile.guardrails?.canary, true);
});

Deno.test('defineProfile rejects illegal protocol/provider pairs', () => {
  assertThrows(
    () =>
      defineProfile({
        id: 'bad_pair',
        type: 'text',
        identity: { handle: 'bad_pair' },
        model: {
          protocol: 'openAi',
          provider: 'google',
          key: 'slotA',
          ...modelAllow('gemini35FlashLite'),
        },
        tools: { allow: [] },
        inputs: { text: true },
      }),
    Error,
    "protocol 'openAi' is not valid for provider 'google'",
  );
});

Deno.test('defineProfile keeps omitted optional fields omitted', () => {
  const profile = defineProfile({
    id: 'bare_host_profile',
    type: 'text',
    identity: { handle: 'bare_host_profile' },
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      key: 'slotA',
      ...modelAllow('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
  });

  assertEquals(profile.model.thinking, undefined);
  if (profile.type !== 'text') throw new Error('Expected text profile');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs, undefined);
  assertEquals(profile.guardrails, undefined);
});

Deno.test('registerProfile accepts explicit typed profile definitions', () => {
  registerProfile({
    id: 'minimal_host_bot',
    type: 'text',
    identity: { handle: 'minimal_host_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
  });

  const profile = getProfile('minimal_host_bot');
  assertEquals(profile.identity.handle, 'minimal_host_bot');
  assertEquals(profile.type, 'text');
  if (profile.type !== 'text') throw new Error('Expected text profile');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs, undefined);
  assertEquals(profile.guardrails, undefined);
});

Deno.test('registerProfile and getProfile manage runtime profile lifecycle', () => {
  const profile = defineProfile({
    id: 'custom_bot',
    type: 'text',
    identity: { handle: 'custom_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 50 } },
  });

  registerProfile(profile);
  assertEquals(hasProfile('custom_bot'), true);
  assertEquals(getProfile('custom_bot').id, 'custom_bot');
  assertEquals(
    listProfiles().some((p) => p.id === 'custom_bot'),
    true,
  );
});

Deno.test('registerProfiles handles batch registration', () => {
  const p1 = defineProfile({
    id: 'bot_alpha',
    type: 'text',
    identity: { handle: 'bot_alpha' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10 } },
  });
  const p2 = defineProfile({
    id: 'bot_beta',
    type: 'text',
    identity: { handle: 'bot_beta' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 20 } },
  });

  registerProfiles([p1, p2]);
  assertEquals(hasProfile('bot_alpha'), true);
  assertEquals(hasProfile('bot_beta'), true);
});

Deno.test('registerProfile validates media limits if attachments are enabled', () => {
  const invalidProfile = defineProfile({
    id: 'invalid_media_bot',
    type: 'text',
    identity: { handle: 'invalid_media_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true, attachments: { accept: ['image/png'] } },
    guardrails: { quota: { perDay: 10 } },
  });

  assertThrows(
    () => {
      registerProfile(invalidProfile);
    },
    Error,
    'must set maxFiles, maxBytes, and maxTurnBytes',
  );
});

Deno.test('defineProfile rejects inputs, outputs, and t2Loader on live profiles', () => {
  const liveBase = {
    id: 'live_shape_bot',
    type: 'live' as const,
    identity: { handle: 'live_shape_bot' },
    model: {
      protocol: 'geminiLive' as const,
      provider: 'google' as const,
      allow: ['gemini31FlashLive'],
      config: {
        gemini31FlashLive: {
          apiId: 'gemini-3.1-flash-live-preview',
          thinking: { on: 'none', off: 'none' },
          thinkingLevels: ['none'],
          summaries: { on: 'none', off: 'none' },
          maxOutputTokens: 256,
          temperature: 0,
          builtInTools: [],
        },
      },
    },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
  };

  assertThrows(
    () =>
      defineProfile({
        ...liveBase,
        inputs: { text: true },
      } as Parameters<typeof defineProfile>[0]),
    Error,
    "type 'live' must not set inputs",
  );

  assertThrows(
    () =>
      defineProfile({
        ...liveBase,
        outputs: { structured: null },
      } as Parameters<typeof defineProfile>[0]),
    Error,
    "type 'live' must not set outputs",
  );

  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          ...liveBase,
          tools: { allow: ['load_tools'], t2Loader: 'load_tools' },
        } as never),
      ),
    Error,
    "tools.t2Loader is not supported on type 'live'",
  );

  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          ...liveBase,
          tools: { allow: ['deferred_tool'], t1Policy: () => ['deferred_tool'] },
        } as never),
      ),
    Error,
    'tools.t1Policy is not supported on type',
  );
});

Deno.test('getProfile throws for unknown profile', () => {
  assertThrows(
    () => {
      getProfile('non_existent_profile');
    },
    Error,
    "Unknown profile 'non_existent_profile'",
  );
});

Deno.test('clearProfiles empties the process-local registry', () => {
  const prior = listProfiles();
  registerProfile({
    id: 'temp_clear_bot',
    type: 'text',
    identity: { handle: 'temp_clear_bot' },
    model: {
      ...geminiModel('gemini35FlashLite'),
    },
    tools: { allow: [] },
    inputs: { text: true },
  });
  assertEquals(hasProfile('temp_clear_bot'), true);
  clearProfiles();
  assertEquals(listProfiles().length, 0);
  for (const profile of prior) {
    registerProfile(profile);
  }
  assertEquals(hasProfile('temp_clear_bot'), false);
});
