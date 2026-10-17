import { assertEquals, assertRejects } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { createKernelScope } from '../../src/kernel/scope.ts';
import { localProvider } from '../../src/providers/local/provider.ts';

function scope() {
  const value = createKernelScope();
  value.providers.register(localProvider, {
    connection: { baseUrl: 'http://localhost:11434/v1' },
  });
  value.profiles.register(
    defineProfile({
      id: 'local-embeddings',
      type: 'embedding',
      identity: { handle: 'Local embeddings' },
      inputs: { text: true },
      models: {
        embeddinggemma: {
          protocol: 'ollamaEmbedding',
          provider: 'local',
          apiId: 'embeddinggemma',
        },
      },
    }),
  );
  return value;
}

Deno.test('runEmbedding uses the selected local embedding protocol', async () => {
  const value = await scope().runEmbedding(
    { profile: 'local-embeddings', input: ['one', 'two'] },
    {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'embeddinggemma',
              embeddings: [
                [0.1, 0.2],
                [0.3, 0.4],
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        ),
    },
  );
  assertEquals(
    value.embeddings.map((item) => item.index),
    [0, 1],
  );
  assertEquals(value.embeddings[0]?.dimensions, 2);
});

Deno.test('runEmbedding rejects media that the selected model does not accept', async () => {
  await assertRejects(
    () =>
      scope().runEmbedding({
        profile: 'local-embeddings',
        input: { parts: [{ type: 'media', mimeType: 'image/png', data: 'AA==' }] },
      }),
    TheoremError,
    'does not accept media',
  );
});

Deno.test('runEmbedding refuses text over the inbound cap before any provider call', async () => {
  let called = false;
  const refused = await assertRejects(
    () =>
      scope().runEmbedding(
        { profile: 'local-embeddings', input: ['short', 'z'.repeat(1_000_001)] },
        {
          fetch: () => {
            called = true;
            return Promise.reject(new Error('unreachable'));
          },
        },
      ),
    TheoremError,
    'over 1000000',
  );
  assertEquals(refused.kind, 'input');
  assertEquals(called, false);
});
