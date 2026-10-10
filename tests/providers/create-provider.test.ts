import { assertEquals, assertThrows } from '@std/assert';
import {
  createKernelScope,
  defineProfile,
  defineProvider,
  googleAdapter,
  openAIChat,
  openRouterAdapter,
  typesafeAdapter,
} from '../../mod.ts';

Deno.test('built-in provider factories are lazy and bindings are serializable', () => {
  for (const provider of [
    defineProvider({ id: 'deployment', connection: {}, adapter: openRouterAdapter() }),
    defineProvider({ id: 'deployment', connection: {}, adapter: googleAdapter() }),
    defineProvider({ id: 'deployment', connection: {}, adapter: typesafeAdapter() }),
  ]) {
    assertEquals(provider.model('model').provider, 'deployment');
    assertEquals(typeof JSON.stringify(provider.model('model')), 'string');
  }
});
Deno.test('compatible endpoints require declarations for unverified tools', () => {
  const provider = defineProvider({
    id: 'deployment',
    connection: { baseURL: 'https://gateway.test/v1' },
    adapter: openAIChat(),
  });
  assertEquals(
    provider.adapter.capabilities({
      apiId: 'model',
      connection: provider.connection,
      providerOptions: {},
    }).features.clientTools,
    'unknown',
  );
});
Deno.test('profiles require registration and reject unavailable profile operations', () => {
  const scope = createKernelScope();
  const provider = defineProvider({
    id: 'deployment',
    connection: { baseURL: 'https://gateway.test/v1' },
    adapter: openAIChat(),
  });
  const profile = defineProfile({
    id: 'profile',
    type: 'speech',
    identity: { handle: 'voice' },
    models: { default: provider.model('model') },
    speech: { voice: 'test' },
  });
  assertThrows(() => scope.profiles.register(profile), Error, 'Unknown provider');
  scope.providers.register(provider);
  assertThrows(() => scope.profiles.register(profile), Error, 'cannot run');
});
