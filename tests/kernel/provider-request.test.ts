import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);

import { registerProfile, resolveTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { providerCompleteRequest } from '../../src/kernel/registry/provider-request.ts';

Deno.test('providerCompleteRequest forwards summaries for OpenAI-compatible providers', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'provider_request_openai_summaries_none',
      identity: { handle: 'provider_request' },
      models: {
        'openrouter/free': {
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
  const req = providerCompleteRequest(defaultKernelScope.tools, generation, 'system');
  assertEquals(generation.summaries, 'none');
  assertEquals(req.summaries, 'none');
});
