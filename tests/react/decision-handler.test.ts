import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { type DecisionQuestion, lexiconDefault } from '../../mod.ts';
import { createTheoremDecisionHandler, createTheoremHandler } from '../../react/src/server/mod.ts';
import type { DecisionProfileDefinition } from '../../src/kernel/mod.ts';

const BASE = 'http://host.test/api/decision';

function profile(id = 'decision-handler-test'): DecisionProfileDefinition {
  return {
    type: 'decision',
    id,
    identity: { handle: 'triage' },
    models: {
      jev: { protocol: 'decision', provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 },
    },
    inputs: { state: 'json', maxStateBytes: 200 },
    decision: { contract: 'test.v1' },
  };
}

const questions: Record<string, DecisionQuestion> = {
  next: {
    type: 'choice',
    instructions: 'SECRET choose the safest next action.',
    criteria: { ask_user: 'Request authorization.', execute: 'Perform the deletion.' },
  },
  risk: { type: 'score', instructions: 'How risky?', criteria: ['low: fine', 'high: not fine'] },
};

const jevReply = {
  model: 'jev-1.13.0',
  answers: {
    next: {
      type: 'choice',
      choice: 'ask_user',
      confidence: 0.9,
      probabilities: { ask_user: 0.9, execute: 0.1 },
    },
    risk: {
      type: 'score',
      score: 1,
      confidence: 0.8,
      legend: { 0: 'low', 1: 'high' },
      probabilities: { 0: 0.1, 1: 0.9 },
    },
  },
  usage: { input_tokens: 1000, output_tokens: 5 },
};

function jev(status = 200, body: unknown = jevReply) {
  const calls: unknown[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetch };
}

function decide(state: unknown): Request {
  return new Request(`${BASE}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
}

Deno.test('GET describes the decision without its instructions', async () => {
  const handler = createTheoremDecisionHandler({
    profile: profile(),
    questions,
    apiKey: 'k',
    fetch: jev().fetch,
  });
  const response = await handler(new Request(BASE));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes('SECRET'), false);
  assertEquals(JSON.parse(text).interface, {
    type: 'decision',
    identity: { handle: 'triage' },
    contract: 'test.v1',
    maxStateBytes: 200,
    questions: [
      { id: 'next', type: 'choice', labels: ['ask_user', 'execute'] },
      { id: 'risk', type: 'score', labels: ['low: fine', 'high: not fine'] },
    ],
  });
});

Deno.test('POST decide asks the host questions about the posted state', async () => {
  const mock = jev();
  const handler = createTheoremDecisionHandler({
    profile: profile(),
    questions,
    apiKey: 'k',
    fetch: mock.fetch,
  });
  const response = await handler(decide({ action: 'delete' }));
  assertEquals(response.status, 200);
  const { result } = await response.json();
  assertEquals(result.model, 'jev-1.13.0');
  assertEquals(result.answers.next.choice, 'ask_user');
  assertEquals(mock.calls.length, 1);
  assertStringIncludes(JSON.stringify(mock.calls[0]), 'SECRET');
});

Deno.test('a null or oversized state is a request error, and Jev is never called', async () => {
  const mock = jev();
  const handler = createTheoremDecisionHandler({
    profile: profile(),
    questions,
    apiKey: 'k',
    fetch: mock.fetch,
  });
  for (const state of [null, { blob: 'x'.repeat(500) }]) {
    const response = await handler(decide(state));
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.errorKind, 'request');
    assertEquals(body.error, lexiconDefault('error.request'));
  }
  const malformed = await handler(
    new Request(`${BASE}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  );
  assertEquals(malformed.status, 400);
  assertEquals(mock.calls.length, 0);
});

Deno.test('decision handlers reject malformed JSON and non-JSON content types', async () => {
  const mock = jev();
  const handler = createTheoremDecisionHandler({
    profile: profile(),
    questions,
    apiKey: 'stub',
    fetch: mock.fetch,
  });
  for (const [type, body] of [
    ['application/json', '{'],
    ['text/plain', '{"state":{}}'],
  ]) {
    const response = await handler(
      new Request(`${BASE}/decide`, { method: 'POST', headers: { 'content-type': type }, body }),
    );
    assertEquals(response.status, 400);
    assertEquals((await response.json()).errorKind, 'request');
  }
  assertEquals(mock.calls.length, 0);
});

Deno.test("Jev's failures reach the page as their kind, in the lexicon's words", async () => {
  const cases = [
    [401, 'auth', 401],
    [429, 'rate_limit', 429],
  ] as const;
  for (const [upstream, kind, status] of cases) {
    const errors: unknown[] = [];
    const handler = createTheoremDecisionHandler({
      profile: profile(),
      questions,
      apiKey: 'k',
      fetch: jev(upstream, {}).fetch,
      onError: (err) => errors.push(err),
    });
    const response = await handler(decide({ action: 'delete' }));
    assertEquals(response.status, status);
    const body = await response.json();
    assertEquals(body.errorKind, kind);
    assertEquals(body.error, lexiconDefault(`error.${kind}`));
    assertEquals(errors.length, 1);
  }
});

Deno.test('other methods and paths are refused', async () => {
  const handler = createTheoremDecisionHandler({
    profile: profile(),
    questions,
    apiKey: 'k',
    fetch: jev().fetch,
  });
  assertEquals((await handler(new Request(`${BASE}/decide`))).status, 405);
  assertEquals((await handler(new Request(BASE, { method: 'POST', body: '{}' }))).status, 405);
});

Deno.test('the turn handler refuses a decision profile and names the decision handler', () => {
  assertThrows(
    () => createTheoremHandler({ profile: profile('decision-handler-turn') } as never),
    Error,
    'createTheoremDecisionHandler',
  );
});
