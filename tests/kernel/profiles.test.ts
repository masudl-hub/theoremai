import { assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from '../../src/kernel/registry/profiles.ts';
import { registerTool } from '../../src/kernel/tools/mod.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { geminiModels, HOST_BINDINGS, modelBindings } from '../fixtures/models.ts';

registerGooglePreset();

Deno.test('defineProfile preserves explicit typed fields without defaults', () => {
  const profile = defineProfile({
    id: 'host_profile',
    type: 'text',
    identity: { handle: 'host_profile' },
    models: {
      gemini35FlashLite: {
        ...HOST_BINDINGS.gemini35FlashLite,
        efforts: { normal: 'low' },
        allowEffortSelect: false,
      },
    },
    maxSteps: 1,
    key: 'slotA',
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null },
    guardrails: { canary: true, sanitizeInput: true },
    observability: { writeTo: false, sampleRate: 0.5 },
  });

  assertEquals(profile.id, 'host_profile');
  assertEquals(profile.type, 'text');
  assertEquals(profile.models.gemini35FlashLite.protocol, 'geminiInteractions');
  assertEquals(profile.observability?.writeTo, false);
  assertEquals(profile.observability?.sampleRate, 0.5);
  assertEquals(profile.models.gemini35FlashLite.provider, 'google');
  assertEquals(profile.maxSteps, 1);
  assertEquals(profile.key, 'slotA');
  assertEquals(profile.identity.handle, 'host_profile');
  if (profile.type !== 'text') throw new Error('Expected text profile');
  assertEquals(profile.tools.allow, []);
  assertEquals(profile.inputs.text, true);
  assertEquals(profile.outputs?.structured, null);
  assertEquals(profile.guardrails?.canary, true);
  assertEquals(profile.observability?.writeTo, false);
  assertEquals(profile.observability?.sampleRate, 0.5);
});

Deno.test('defineProfile rejects observability.sampleRate outside 0–1', () => {
  assertThrows(
    () =>
      defineProfile({
        id: 'bad_obs',
        type: 'text',
        identity: { handle: 'bad_obs' },
        models: modelBindings('gemini35FlashLite'),
        key: 'slotA',
        tools: { allow: [] },
        inputs: { text: true },
        observability: { writeTo: false, sampleRate: 2 },
      }),
    Error,
    'sampleRate',
  );
});

Deno.test('defineProfile rejects illegal protocol/provider pairs', () => {
  assertThrows(
    () =>
      defineProfile({
        id: 'bad_pair',
        type: 'text',
        identity: { handle: 'bad_pair' },
        models: {
          gemini35FlashLite: {
            ...modelBindings('gemini35FlashLite').gemini35FlashLite,
            protocol: 'openAi',
            provider: 'google',
          },
        },
        key: 'slotA',
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
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
  });

  assertEquals(profile.models.gemini35FlashLite.defaultEffort, 'normal');
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
    ...geminiModels('gemini35FlashLite'),
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
    ...geminiModels('gemini35FlashLite'),
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
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 10 } },
  });
  const p2 = defineProfile({
    id: 'bot_beta',
    type: 'text',
    identity: { handle: 'bot_beta' },
    ...geminiModels('gemini35FlashLite'),
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
    ...geminiModels('gemini35FlashLite'),
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
    models: modelBindings('gemini31FlashLive'),
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

Deno.test("registerProfile rejects T1/T2 tools on type 'live'", () => {
  registerTool({
    type: 'function',
    name: 'live_t1_probe',
    description: 'T1 tool must not be allowlisted on live',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'nope' }),
  });
  registerTool({
    type: 'function',
    name: 'live_t2_probe',
    description: 'T2 tool must not be allowlisted on live',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'nope' }),
  });

  const liveBase = {
    id: 'live_tier_bot',
    type: 'live' as const,
    identity: { handle: 'live_tier_bot' },
    models: modelBindings('gemini31FlashLive'),
    live: { voice: 'Aoede' },
  };

  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          ...liveBase,
          id: 'live_t1_bot',
          tools: { allow: ['live_t1_probe'] },
        }),
      ),
    Error,
    "tools.allow 'live_t1_probe' has loadTier 'T1'",
  );

  assertThrows(
    () =>
      registerProfile(
        defineProfile({
          ...liveBase,
          id: 'live_t2_bot',
          tools: { allow: ['live_t2_probe'] },
        }),
      ),
    Error,
    "tools.allow 'live_t2_probe' has loadTier 'T2'",
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
    ...geminiModels('gemini35FlashLite'),
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
