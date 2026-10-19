import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { TheoremError } from '../../src/guardrails/error.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { createKernelScope } from '../../src/kernel/scope.ts';
import { geminiProvider } from '../../src/providers/gemini/provider.ts';
import { localProvider } from '../../src/providers/local/provider.ts';
import { openRouterProvider } from '../../src/providers/openrouter/provider.ts';

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

/** A profile on the given model that takes images and PDFs, with the given limits. */
function mediaScope(
  model: { protocol: string; provider: string; apiId: string } = {
    protocol: 'openRouterEmbedding',
    provider: 'openrouter',
    apiId: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
  },
  limits = { maxFiles: 1, maxBytes: 4, maxTurnBytes: 4 },
) {
  const value = createKernelScope();
  value.providers.register(localProvider, {
    connection: { baseUrl: 'http://localhost:11434/v1' },
  });
  value.providers.register(openRouterProvider);
  value.providers.register(geminiProvider);
  value.profiles.register(
    defineProfile({
      id: 'media-embeddings',
      type: 'embedding',
      identity: { handle: 'Media embeddings' },
      inputs: { text: true, attachments: { accept: ['image/*', 'application/pdf'] }, ...limits },
      models: { embedding: model },
    }),
  );
  return value;
}

/** Runs the request and expects the kernel to refuse it before any provider call. */
async function refusedUnsent(
  value: ReturnType<typeof mediaScope>,
  input: Parameters<ReturnType<typeof mediaScope>['runEmbedding']>[0]['input'],
  expected: string,
) {
  let called = false;
  await assertRejects(
    () =>
      value.runEmbedding(
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

Deno.test('runEmbedding holds each input to the file count, and the request to the byte limits', async () => {
  const image = (data: string) => ({ type: 'media' as const, mimeType: 'image/png', data });
  const cases: [Parameters<ReturnType<typeof mediaScope>['runEmbedding']>[0]['input'], string][] = [
    [{ parts: [image('AA=='), image('AA==')] }, 'too_many_files'],
    [[{ parts: [image('AAAA')] }, { parts: [image('AAAA')] }], 'turn_too_large'],
    [{ parts: [image('AAAAAAAA')] }, 'file_too_large'],
    [{ parts: [{ type: 'media', mimeType: 'audio/wav', data: 'AAAA' }] }, 'mime_not_allowed'],
    [{ parts: [image('not base64!')] }, 'attachment data must be base64'],
  ];
  for (const [input, expected] of cases) await refusedUnsent(mediaScope(), input, expected);
});

Deno.test('runEmbedding holds each input to what its model takes', async () => {
  const gemini = () =>
    mediaScope(
      { protocol: 'geminiEmbedding', provider: 'gemini', apiId: 'gemini-embedding-2-preview' },
      { maxFiles: 10, maxBytes: 100, maxTurnBytes: 1000 },
    );
  const file = (mimeType: string) => ({ type: 'media' as const, mimeType, data: 'AA==' });
  const images = (count: number) => Array.from({ length: count }, () => file('image/png'));
  await refusedUnsent(gemini(), { parts: images(7) }, 'too_many_of_kind');
  await refusedUnsent(
    gemini(),
    { parts: [file('application/pdf'), file('application/pdf')] },
    'too_many_of_kind',
  );
  await refusedUnsent(gemini(), { parts: [file('image/webp')] }, 'mime_not_allowed');
  await refusedUnsent(
    gemini(),
    Array.from({ length: 101 }, (_, at) => `text ${at}`),
    'takes at most 100 inputs',
  );
  await refusedUnsent(
    mediaScope({ protocol: 'ollamaEmbedding', provider: 'local', apiId: 'embeddinggemma' }),
    { parts: [file('image/png')] },
    'attachments_not_accepted',
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
