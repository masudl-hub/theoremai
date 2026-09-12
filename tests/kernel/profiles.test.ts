import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheorumError } from '../../src/guardrails/error.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import {
  clearProfiles,
  defineProfile,
  getProfile,
  hasProfile,
  listProfiles,
  registerProfile,
  registerProfiles,
} from '../../src/kernel/registry/profiles.ts';
import { projectProfile, resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { registerTool } from '../../src/kernel/tools/mod.ts';
import { resolveTurnTools } from '../../src/kernel/tools/resolve.ts';
import type { ModelProvider } from '../../src/kernel/types.ts';
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
  assertEquals(profile.type, 'text');
  if (profile.type !== 'text') throw new Error('Expected text profile');
  assertEquals(profile.identity.handle, 'minimal_host_bot');
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

Deno.test("registerProfile accepts T1/T2 tools on type 'live' and wires all of them", () => {
  registerTool({
    type: 'function',
    name: 'live_t1_probe',
    description: 'T1 tool wired at live setup',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerTool({
    type: 'function',
    name: 'live_t2_probe',
    description: 'T2 tool wired at live setup',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerTool({
    type: 'function',
    name: 'live_t0_probe',
    description: 'T0 tool wired at live setup',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });

  registerProfile(
    defineProfile({
      id: 'live_tier_bot',
      type: 'live',
      identity: { handle: 'live_tier_bot' },
      models: modelBindings('gemini31FlashLive'),
      live: { voice: 'Aoede' },
      tools: { allow: ['live_t0_probe', 'live_t1_probe', 'live_t2_probe'] },
    }),
  );

  const profile = getProfile('live_tier_bot');
  const snapshot = resolveTurnTools(profile, { profile: profile.id }, 'gemini31FlashLive');
  const allow = ['live_t0_probe', 'live_t1_probe', 'live_t2_probe'];
  assertEquals(snapshot.gated, allow);
  assertEquals(snapshot.visible, allow);
  assertEquals(snapshot.executable, allow);
  assertEquals(
    snapshot.wire.map((w) => w.name),
    allow,
  );
});

Deno.test('live snapshot turns on every gated builtin regardless of loadTier', () => {
  registerTool({
    type: 'builtin',
    name: 'live_builtin_t1',
    description: 'T1 builtin',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    wire: { live: 'live_builtin_t1' },
  });
  registerProfile(
    defineProfile({
      id: 'live_builtin_bot',
      type: 'live',
      identity: { handle: 'live_builtin_bot' },
      models: {
        gemini31FlashLive: {
          ...HOST_BINDINGS.gemini31FlashLive,
          builtInTools: ['live_builtin_t1'],
        },
      },
      live: { voice: 'Aoede' },
      tools: { allow: [] },
    }),
  );
  const profile = getProfile('live_builtin_bot');
  const snapshot = resolveTurnTools(profile, { profile: profile.id }, 'gemini31FlashLive');
  assertEquals(snapshot.gated, ['live_builtin_t1']);
  assertEquals(snapshot.builtins, ['live_builtin_t1']);
});

Deno.test("registerProfile accepts a 'host' profile with only tools, guardrails, observability", () => {
  registerTool({
    type: 'function',
    name: 'host_probe',
    description: 'Host-invoked tool',
    category: 'test',
    access: 'read-only',
    paths: ['web'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerProfile({
    type: 'host',
    id: 'host_ceiling',
    tools: { allow: ['host_probe'] },
    guardrails: { sanitizeInput: true },
    observability: { writeTo: false },
  });
  const profile = getProfile('host_ceiling');
  assertEquals(profile.type, 'host');
  if (profile.type !== 'host') throw new Error('Expected host profile');
  assertEquals(profile.tools.allow, ['host_probe']);
  assertEquals(profile.guardrails?.sanitizeInput, true);
  assertEquals(profile.observability?.writeTo, false);
  assertEquals('models' in profile, false);
  assertEquals('identity' in profile, false);

  // No tiers, no path gating: gated = visible = executable = allow; no builtins.
  const snapshot = resolveTurnTools(profile, { profile: profile.id }, undefined);
  assertEquals(snapshot.gated, ['host_probe']);
  assertEquals(snapshot.visible, ['host_probe']);
  assertEquals(snapshot.executable, ['host_probe']);
  assertEquals(snapshot.builtins, []);
  assertEquals(
    snapshot.wire.map((w) => w.name),
    ['host_probe'],
  );
});

Deno.test('host profile accepts only the guardrails that fire on the invokeTool path', () => {
  registerProfile({
    type: 'host',
    id: 'host_guardrails_live',
    tools: { allow: [] },
    guardrails: {
      sanitizeInput: false,
      redactSensitive: true,
      network: { allowPrivateNetworks: true, allowedHosts: ['example.test'] },
      taint: { afterRemoteRead: 'write' },
    },
  });
  const profile = getProfile('host_guardrails_live');
  if (profile.type !== 'host') throw new Error('Expected host profile');
  assertEquals(profile.guardrails?.sanitizeInput, false);
  assertEquals(profile.guardrails?.redactSensitive, true);
  assertEquals(profile.guardrails?.network?.allowedHosts, ['example.test']);
  assertEquals(profile.guardrails?.taint?.afterRemoteRead, 'write');
});

Deno.test('host profile rejects guardrails that only a model turn can run', () => {
  const base = { type: 'host' as const, id: 'host_guardrails_bad', tools: { allow: [] } };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['quota', { quota: { perDay: 10 } }],
    ['canary', { canary: true }],
    ['egress', { egress: { enforce: () => ({ blocked: false }) } }],
  ];
  for (const [field, guardrails] of cases) {
    assertThrows(
      () => registerProfile({ ...base, guardrails } as Parameters<typeof registerProfile>[0]),
      TheorumError,
      `type 'host' must not set guardrails.${field}`,
    );
  }
});

Deno.test('host profile rejects models, identity, inputs, outputs, turnBehaviour, key, maxSteps', () => {
  const base = { type: 'host' as const, id: 'host_bad', tools: { allow: [] } };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['models', { models: modelBindings('gemini35FlashLite') }],
    ['identity', { identity: { handle: 'x' } }],
    ['inputs', { inputs: { text: true } }],
    ['outputs', { outputs: {} }],
    ['turnBehaviour', { turnBehaviour: {} }],
    ['key', { key: 'slotA' }],
    ['maxSteps', { maxSteps: 1 }],
  ];
  for (const [field, extra] of cases) {
    assertThrows(
      () => registerProfile({ ...base, ...extra } as Parameters<typeof registerProfile>[0]),
      Error,
      `type 'host' must not set ${field}`,
    );
  }
  assertThrows(
    () =>
      registerProfile({
        ...base,
        tools: { allow: ['load_tools'], t2Loader: 'load_tools' },
      } as Parameters<typeof registerProfile>[0]),
    Error,
    "not supported on type 'host'",
  );
  assertThrows(
    () => registerProfile({ ...base, tools: { allow: ['googleSearch'] } }),
    Error,
    "type 'host' never runs a model",
  );
});

Deno.test("resolveTurn, runTurn, runSession and projectProfile refuse a 'host' profile", async () => {
  registerProfile({ type: 'host', id: 'host_refusals', tools: { allow: [] } });
  assertThrows(() => resolveTurn({ profile: 'host_refusals' }), TheorumError, "type 'host'");
  assertThrows(() => projectProfile('host_refusals'), TheorumError, "type 'host'");
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'text', text: 'never' };
    },
  };
  await assertRejects(
    async () => {
      for await (const _ of runTurn({ profile: 'host_refusals' }, provider)) {
        // drain
      }
    },
    TheorumError,
    "type 'host'",
  );
  await assertRejects(
    () =>
      runSession(
        { profile: 'host_refusals' },
        { gemini: { vault: { slotA: 'k', slotB: undefined, slotC: undefined, paid: undefined } } },
      ),
    TheorumError,
    "type 'host'",
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
