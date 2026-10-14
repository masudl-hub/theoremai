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
Deno.test('an endpoint that is not a URL is refused as one, and one that is not HTTP in its own words', () => {
  const messages = (baseURL: string) =>
    openAIChat()
      .connectionSchema.safeParse({ baseURL })
      .error?.issues.map((issue) => issue.message);
  assertEquals(messages('nowhere'), ['Invalid URL']);
  assertEquals(messages('ftp://files.test'), ['Endpoints must use HTTP and exclude credentials']);
  assertEquals(messages('https://user:secret@gateway.test/v1'), [
    'Endpoints must use HTTP and exclude credentials',
  ]);
  assertEquals(messages('https://gateway.test/v1'), undefined);
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

Deno.test('unverified Gemini models need an explicit capability declaration', () => {
  const model = { apiId: 'new-model-with-new-rules', connection: {}, providerOptions: {} };
  const unknown = googleAdapter().capabilities(model);
  assertEquals(unknown.features.clientTools, 'unknown');
  assertEquals(unknown.features.structuredOutput, 'unknown');
  assertEquals(unknown.inputKinds, []);
  const known = googleAdapter().capabilities({ ...model, apiId: 'gemini-3.5-flash-lite' });
  assertEquals(googleAdapter({ [model.apiId]: known }).capabilities(model), known);
  assertEquals(typesafeAdapter().capabilities(model).features.clientTools, 'unsupported');
});
