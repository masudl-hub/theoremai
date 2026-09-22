import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { providerCompleteRequest } from '../../src/kernel/registry/provider-request.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';

Deno.test('providerCompleteRequest forwards summaries for OpenAI-compatible providers', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'provider_request_openai_summaries_none',
      identity: { handle: 'provider_request' },
      models: {
        'openrouter/free': {
          protocol: 'openAi',
          provider: 'openrouter',
          apiId: 'openrouter/free',
          summaries: false,
        },
      },
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );

  const { generation } = resolveTurn({
    profile: 'provider_request_openai_summaries_none',
    input: { text: 'hi' },
  });
  const req = providerCompleteRequest(generation, 'system');

  assertEquals(generation.summaries, 'none');
  assertEquals(req.summaries, 'none');
});
