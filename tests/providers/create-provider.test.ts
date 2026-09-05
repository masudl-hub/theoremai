import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { Protocol, Provider } from '../../src/kernel/types.ts';
import { createProvider, isImageRole, isSpeechRole } from '../../src/providers/create-provider.ts';
import { stubProfile } from '../fixtures/profiles.ts';

function baseProfile(
  model: { protocol: Protocol; provider: Provider },
  role: 'text' | 'speech' | 'image',
) {
  return stubProfile({ protocol: model.protocol, provider: model.provider, role });
}

Deno.test('isSpeechRole is true when type is speech', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'speech');
  assertEquals(isSpeechRole(profile), true);
});

Deno.test('isSpeechRole is false when type is not speech', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'text');
  assertEquals(isSpeechRole(profile), false);
});

Deno.test('isImageRole is true when type is image', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'image');
  assertEquals(isImageRole(profile), true);
});

Deno.test('isImageRole is false when type is not image', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'text');
  assertEquals(isImageRole(profile), false);
});

Deno.test('createProvider throws when gemini transport is missing for geminiInteractions/google', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'text');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider requires gemini transport for google Interactions',
  );
});

Deno.test('createProvider returns a provider when gemini transport is supplied', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'text');
  const provider = createProvider(profile, {
    gemini: { vault: { freeA: 'a', freeB: 'b', freeC: 'c', paid: 'p' } },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws when openAiGateway config is missing for openAi/openrouter', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'text');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider requires openAiGateway config for openAi/openrouter',
  );
});

Deno.test('createProvider returns a text provider for openAi/openrouter non-speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'text');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider returns an image provider for openAi/openrouter image profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'image');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws for openAi/local image profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'image');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    'createProvider: type image requires openrouter provider for openAi protocol',
  );
});

Deno.test('createProvider returns a speech provider for openAi/openrouter speech profile', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'speech');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key', voice: 'Kore' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('createProvider throws for unsupported protocol/provider pairs', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'google' }, 'text');
  let thrown: unknown;
  try {
    createProvider(profile, {});
  } catch (err) {
    thrown = err;
  }
  assertEquals(thrown instanceof TheorumError, true);
  assertEquals(
    (thrown as Error).message,
    "createProvider: unsupported protocol/provider pair 'openAi'/'google'",
  );
});

Deno.test('createProvider routes openAi/local without requiring options.local', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'text');
  const provider = createProvider(profile, {});
  assertEquals(typeof provider.complete, 'function');
  const withUrl = createProvider(profile, { local: { baseUrl: 'http://127.0.0.1:8080' } });
  assertEquals(typeof withUrl.complete, 'function');
});

Deno.test('create-provider has no eager adapter imports', async () => {
  const src = await Deno.readTextFile(
    new URL('../../src/providers/create-provider.ts', import.meta.url),
  );
  assertEquals(/from\s+['"]\.\/openrouter\//.test(src), false);
  assertEquals(/from\s+['"]\.\/local\/local\.ts['"]/.test(src), false);
  assertEquals(/from\s+['"]\.\/google\/interactions\//.test(src), false);
  assertEquals(/from\s+['"]\.\/google\/live\//.test(src), false);
  assertEquals(src.includes("import('./openrouter/chat.ts')"), true);
  assertEquals(src.includes("import('./google/interactions/mod.ts')"), true);
  assertEquals(src.includes("import('./google/live/mod.ts')"), true);
  assertEquals(src.includes("import('./openrouter/speech.ts')"), true);
  assertEquals(src.includes("import('./openrouter/image.ts')"), true);
  assertEquals(src.includes("import('./local/local.ts')"), true);
});

Deno.test('create-provider loads OpenRouter adapter only via dynamic import', () => {
  // Sync createProvider for openrouter chat must not touch the Vercel graph.
  // This file's suite runs without --allow-sys; an eager openrouter import would throw.
  const profile = baseProfile({ protocol: 'openAi', provider: 'openrouter' }, 'text');
  const provider = createProvider(profile, { openAiGateway: { apiKey: 'key' } });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('create-provider loads Google adapter only via dynamic import', () => {
  const profile = baseProfile({ protocol: 'geminiInteractions', provider: 'google' }, 'text');
  const provider = createProvider(profile, {
    gemini: { vault: { freeA: 'a', freeB: 'b', freeC: 'c', paid: 'p' } },
  });
  assertEquals(typeof provider.complete, 'function');
});

Deno.test('create-provider loads local adapter only via dynamic import', () => {
  const profile = baseProfile({ protocol: 'openAi', provider: 'local' }, 'text');
  const provider = createProvider(profile, {});
  assertEquals(typeof provider.complete, 'function');
});
