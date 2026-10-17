import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';

registerFixtureProviders(defaultKernelScope);

import { assertEquals, assertStringIncludes } from '@std/assert';
import { createTheoremEmbeddingHandler } from '../../react/src/server/mod.ts';
import { FIXTURE_VAULT } from '../fixtures/registered-runner.ts';

const BASE = 'http://host.test/api/embedding';

function handler(sent: unknown[]) {
  return createTheoremEmbeddingHandler({
    profile: {
      type: 'embedding',
      id: 'embedding-handler-task',
      identity: { handle: 'search' },
      inputs: { text: true },
      models: {
        gemini: { protocol: 'geminiEmbedding', provider: 'gemini', apiId: 'gemini-embedding-2' },
      },
    },
    vault: FIXTURE_VAULT,
    fetch: (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ embeddings: [{ values: [0.1, 0.2] }] }));
    },
  });
}

const embed = (body: unknown) =>
  new Request(`${BASE}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

Deno.test("the embedding handler sends the request's task to the model", async () => {
  const sent: unknown[] = [];
  const response = await handler(sent)(embed({ input: ['tidy my desktop'], task: 'query' }));
  assertEquals(response.status, 200);
  assertStringIncludes(JSON.stringify(sent), 'task: search result | query: tidy my desktop');
});

Deno.test('the embedding handler refuses a task that is not query or document', async () => {
  const sent: unknown[] = [];
  const response = await handler(sent)(embed({ input: ['a'], task: 'summary' }));
  assertEquals(response.status, 400);
  assertEquals(sent, []);
});
