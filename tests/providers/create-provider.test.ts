import { assertEquals, assertThrows } from '@std/assert';
import { createKernelScope, defineProfile, endpointUrlSchema, localProvider } from '../../mod.ts';

Deno.test('an endpoint that is not a URL is refused as one, and one that is not HTTP in its own words', () => {
  const messages = (baseUrl: string) =>
    endpointUrlSchema.safeParse(baseUrl).error?.issues.map((issue) => issue.message);
  const refused = ['An endpoint must use HTTP and hold no credentials; keys go in the vault'];
  assertEquals(messages('nowhere'), ['Invalid URL']);
  assertEquals(messages('ftp://files.test'), refused);
  assertEquals(messages('https://user:secret@gateway.test/v1'), refused);
  assertEquals(messages('https://gateway.test/v1?api_key=secret'), refused);
  assertEquals(messages('https://gateway.test/v1'), undefined);
});

Deno.test('profiles require registration and reject unavailable profile operations', () => {
  const scope = createKernelScope();
  const profile = defineProfile({
    id: 'profile',
    type: 'image',
    identity: { handle: 'painter' },
    models: { default: { protocol: 'openAi', provider: 'deployment', apiId: 'model' } },
    image: { aspectRatio: '1:1' },
    tools: { allow: [] },
    inputs: { text: true },
  });
  assertThrows(() => scope.profiles.register(profile), Error, "No provider 'deployment'");
  scope.providers.register(localProvider, {
    id: 'deployment',
    connection: { baseUrl: 'https://gateway.test/v1' },
  });
  assertThrows(() => scope.profiles.register(profile), Error, "has no endpoint for 'image'");
});
