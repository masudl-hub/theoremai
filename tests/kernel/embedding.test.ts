import { assertEquals, assertRejects, assertThrows } from '@std/assert';
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
    'attachments_not_accepted',
  );
});

function mediaScope() {
  const value = createKernelScope();
  value.providers.register(localProvider, {
    connection: { baseUrl: 'http://localhost:11434/v1' },
  });
  value.profiles.register(
    defineProfile({
      id: 'media-embeddings',
      type: 'embedding',
      identity: { handle: 'Media embeddings' },
      inputs: {
        text: true,
        attachments: { accept: ['image/*'] },
        maxFiles: 1,
        maxBytes: 4,
        maxTurnBytes: 4,
      },
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

Deno.test('an embedding profile that takes media must set its limits', () => {
  const refused = assertThrows(
    () =>
      defineProfile({
        id: 'unbounded-embeddings',
        type: 'embedding',
        identity: { handle: 'Unbounded' },
        inputs: { attachments: { accept: ['image/*'] } },
        models: {
          embeddinggemma: {
            protocol: 'ollamaEmbedding',
            provider: 'local',
            apiId: 'embeddinggemma',
          },
        },
      }),
    TheoremError,
    'must set maxFiles, maxBytes, and maxTurnBytes',
  );
  assertEquals(refused.kind, 'config');
});

Deno.test('runEmbedding holds media to the profile limits across the whole request', async () => {
  const image = (data: string) => ({
    parts: [{ type: 'media' as const, mimeType: 'image/png', data }],
  });
  const cases: [Parameters<ReturnType<typeof mediaScope>['runEmbedding']>[0]['input'], string][] = [
    [[image('AAAA'), image('AAAA')], 'too_many_files'],
    [image('AAAAAAAA'), 'file_too_large'],
    [{ parts: [{ type: 'media', mimeType: 'audio/wav', data: 'AAAA' }] }, 'mime_not_allowed'],
    [image('not base64!'), 'attachment data must be base64'],
  ];
  for (const [input, expected] of cases) {
    let called = false;
    await assertRejects(
      () =>
        mediaScope().runEmbedding(
          { profile: 'media-embeddings', input },
          {
            fetch: () => {
              called = true;
              return Promise.reject(new Error('unreachable'));
            },
          },
        ),
      TheoremError,
      expected,
    );
    assertEquals(called, false);
  }
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

Deno.test('runEmbedding refuses a task that is not query or document', async () => {
  await assertRejects(
    () =>
      scope().runEmbedding({
        profile: 'local-embeddings',
        input: 'one',
        task: 'answer' as never,
      }),
    TheoremError,
    "Embedding task must be 'query' or 'document'",
  );
});
