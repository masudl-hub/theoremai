import { assertEquals, assertRejects } from '@std/assert';
import type { JsonObject } from '../../src/kernel/json.ts';
import { resolveProviderLimits } from '../../src/kernel/protocols/limits.ts';
import type { ProtocolContext } from '../../src/kernel/protocols/protocol.ts';
import { bytesToBase64 } from '../../src/kernel/util/base64.ts';
import { geminiEmbeddings } from '../../src/providers/gemini/embeddings-protocol.ts';
import { ollamaEmbeddings } from '../../src/providers/local/embeddings-protocol.ts';
import { openRouterEmbeddings } from '../../src/providers/openrouter/embeddings-protocol.ts';

function context<O>(
  apiId: string,
  send: (body: JsonObject, path?: string) => JsonObject,
): ProtocolContext<O> {
  return {
    profileType: 'embedding',
    apiId,
    options: {} as O,
    builtInTools: [],
    limits: resolveProviderLimits({}),
    send(body, init) {
      return (async function* () {
        yield send(body, init.path);
      })();
    },
    connect() {
      throw new Error('not used');
    },
    tapUpstream() {},
  };
}

Deno.test('Gemini embedding encodes media and batch requests', async () => {
  const sent: { body: JsonObject; path?: string }[] = [];
  const call = geminiEmbeddings.create(
    context<{
      taskType?:
        | 'RETRIEVAL_QUERY'
        | 'RETRIEVAL_DOCUMENT'
        | 'SEMANTIC_SIMILARITY'
        | 'CLASSIFICATION'
        | 'CLUSTERING'
        | 'QUESTION_ANSWERING'
        | 'FACT_VERIFICATION'
        | 'CODE_RETRIEVAL_QUERY';
      outputDimensionality?: 768 | 1536 | 3072;
    }>('gemini-embedding-2', (body, path) => {
      sent.push({ body, path });
      return {
        embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }],
      };
    }),
  );
  const result = await call.embed?.({
    apiId: 'gemini-embedding-2',
    input: [
      { parts: [{ type: 'text', text: 'one' }] },
      { parts: [{ type: 'media', mimeType: 'image/png', data: 'AA==' }] },
    ],
  });
  assertEquals(sent[0]?.path, '/models/gemini-embedding-2:batchEmbedContents');
  const request = sent[0];
  if (!request) throw new Error('Gemini request was not sent');
  assertEquals((request.body.requests as JsonObject[]).length, 2);
  assertEquals(result?.embeddings.length, 2);
});

Deno.test('OpenRouter embedding encodes text and media batches', async () => {
  let body: JsonObject | undefined;
  const call = openRouterEmbeddings.create(
    context<{ encodingFormat?: 'float' | 'base64' }>(
      'nvidia/llama-nemotron-embed-vl-1b-v2:free',
      (sent) => {
        body = sent;
        return {
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        };
      },
    ),
  );
  await call.embed?.({
    apiId: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    input: { parts: [{ type: 'media', mimeType: 'image/png', data: 'AA==' }] },
  });
  assertEquals(body?.input, [
    { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
  ]);
  await call.embed?.({
    apiId: 'nvidia/llama-nemotron-embed-vl-1b-v2:free',
    input: ['a red square', { parts: [{ type: 'text', text: 'red' }] }],
  });
  assertEquals(body?.input, ['a red square', { content: [{ type: 'text', text: 'red' }] }]);
});

Deno.test('OpenRouter embedding decodes base64 vectors', async () => {
  const bytes = new Uint8Array(new Float32Array([0.1, 0.2]).buffer);
  const call = openRouterEmbeddings.create(
    context('nvidia/nemotron-3-embed-1b:free', () => ({
      data: [{ index: 0, embedding: bytesToBase64(bytes) }],
    })),
  );
  const result = await call.embed?.({
    apiId: 'nvidia/nemotron-3-embed-1b:free',
    input: 'hello',
    options: { encodingFormat: 'base64' },
  });
  assertEquals(result?.embeddings[0]?.dimensions, 2);
  assertEquals(
    result?.embeddings[0]?.values.map((value) => Math.round(value * 10)),
    [1, 2],
  );
});

Deno.test('Ollama embedding sends its documented text request', async () => {
  let body: JsonObject | undefined;
  const call = ollamaEmbeddings.create(
    context<{ truncate?: boolean; dimensions?: number }>('embeddinggemma', (sent) => {
      body = sent;
      return { model: 'embeddinggemma', embeddings: [[0.1, 0.2]] };
    }),
  );
  const result = await call.embed?.({
    apiId: 'embeddinggemma',
    input: 'hello',
  });
  assertEquals(body?.input, ['hello']);
  assertEquals(result?.embeddings[0]?.dimensions, 2);
});

function sentParts(body: JsonObject): JsonObject[][] {
  const requests = (body.requests as JsonObject[] | undefined) ?? [body];
  return requests.map((request) => (request.content as JsonObject).parts as JsonObject[]);
}

Deno.test('Gemini Embedding 2 writes the task into text-only inputs and leaves media as sent', async () => {
  const bodies: JsonObject[] = [];
  const call = geminiEmbeddings.create(
    context('gemini-embedding-2', (body) => {
      bodies.push(body);
      return { embeddings: [{ values: [0.1] }, { values: [0.2] }] };
    }),
  );
  await call.embed?.({
    apiId: 'gemini-embedding-2',
    input: [
      'cats',
      {
        parts: [
          { type: 'text', text: 'a dog' },
          { type: 'media', mimeType: 'image/png', data: 'AA==' },
        ],
      },
    ],
    task: 'document',
  });
  await call.embed?.({ apiId: 'gemini-embedding-2', input: 'pets', task: 'query' });
  assertEquals(sentParts(bodies[0])[0], [{ text: 'title: none | text: cats' }]);
  assertEquals(sentParts(bodies[0])[1]?.[0], { text: 'a dog' });
  assertEquals(sentParts(bodies[1])[0], [{ text: 'task: search result | query: pets' }]);
  assertEquals(bodies[1]?.taskType, undefined);
});

Deno.test('Gemini Embedding 001 sends the task as its taskType, over the binding default', async () => {
  let body: JsonObject | undefined;
  const call = geminiEmbeddings.create(
    context('gemini-embedding-001', (sent) => {
      body = sent;
      return { embedding: { values: [0.1] } };
    }),
  );
  await call.embed?.({
    apiId: 'gemini-embedding-001',
    input: 'pets',
    task: 'query',
    options: { taskType: 'CLUSTERING' },
  });
  assertEquals(body?.taskType, 'RETRIEVAL_QUERY');
  assertEquals(sentParts(body ?? {})[0], [{ text: 'pets' }]);
});

Deno.test('Gemini Embedding 2 refuses a binding taskType', async () => {
  const call = geminiEmbeddings.create(context('gemini-embedding-2', () => ({})));
  await assertRejects(
    async () =>
      await call.embed?.({
        apiId: 'gemini-embedding-2',
        input: 'pets',
        options: { taskType: 'RETRIEVAL_QUERY' },
      }),
    Error,
    'takes no taskType',
  );
});
