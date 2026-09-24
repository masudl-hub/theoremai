import { assertEquals, assertRejects } from '@std/assert';
import {
  clearProfiles,
  DecisionError,
  type DecisionModelBinding,
  type DecisionRequest,
  defineProfile,
  registerProfile,
  runDecision,
} from '../../src/kernel/mod.ts';

function profile(id = 'decision-test') {
  return defineProfile({
    type: 'decision',
    id,
    identity: { handle: 'Decision test' },
    models: { jev: { apiId: 'jev-latest', timeoutMs: 1000 } },
    inputs: { state: 'json', maxStateBytes: 1000 },
    decision: { contract: 'test.v1' },
  });
}

function request(profileId = 'decision-test'): DecisionRequest {
  return {
    profile: profileId,
    state: { action: 'delete', authorization: false },
    questions: {
      next: {
        type: 'choice',
        instructions: 'Choose the safest next action.',
        criteria: { ask_user: 'Request authorization.', execute: 'Perform the deletion.' },
      },
      risk: {
        type: 'score',
        instructions: 'How consequential is a wrong action?',
        criteria: ['low', 'high'],
      },
    },
  };
}

Deno.test('decision profile rejects chat-only fields', () => {
  assertRejects(
    () =>
      Promise.resolve().then(() =>
        defineProfile({
          ...profile('invalid'),
          outputs: {},
        } as never),
      ),
    Error,
    "type 'decision' must not set outputs",
  );
});

Deno.test('decision profile rejects inert turn guardrails', () => {
  assertRejects(
    () =>
      Promise.resolve().then(() =>
        defineProfile({
          ...profile('inert-guardrail'),
          guardrails: { egress: { enforce: () => ({ action: 'allow' as const }) } },
        }),
      ),
    Error,
    "type 'decision' must not set guardrails.egress",
  );
});

Deno.test('runDecision validates and normalizes a Jev response', async () => {
  clearProfiles();
  registerProfile(profile());
  let calls = 0;
  const result = await runDecision(request(), {
    apiKey: 'test-key',
    fetch: (url, init) => {
      calls += 1;
      assertEquals(url, 'https://api.typesafe.ai/v1/systemone');
      assertEquals(init?.method, 'POST');
      return Promise.resolve(
        new Response(
          JSON.stringify({
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
                legend: { 0: 0, 1: 1 },
                probabilities: { 0: 0.1, 1: 0.9 },
              },
            },
            usage: { input_tokens: 12, output_tokens: 5 },
          }),
          { status: 200 },
        ),
      );
    },
  });
  assertEquals(calls, 1);
  assertEquals(result.model, 'jev-1.13.0');
  assertEquals(result.answers.next.type, 'choice');
  assertEquals(result.usage, { inputTokens: 12, outputTokens: 5 });
});

Deno.test('disclosure block prevents the Jev request', async () => {
  clearProfiles();
  registerProfile(
    defineProfile({
      ...profile(),
      guardrails: {
        disclosure: { enforce: () => ({ action: 'block' as const, hits: [], rejection: 'no' }) },
      },
    }),
  );
  let calls = 0;
  await assertRejects(
    () =>
      runDecision(request(), {
        apiKey: 'test-key',
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('{}'));
        },
      }),
    Error,
    'Decision disclosure was blocked',
  );
  assertEquals(calls, 0);
});

Deno.test('runDecision normalizes Jev HTTP failures', async () => {
  clearProfiles();
  registerProfile(profile());
  for (const [status, code] of [
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'permission'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
  ] as const) {
    const error = await assertRejects(
      () =>
        runDecision(request(), {
          apiKey: 'test-key',
          fetch: () => Promise.resolve(new Response('{}', { status })),
        }),
      DecisionError,
    );
    assertEquals(error.code, code);
    assertEquals(error.status, status);
  }
});

Deno.test('invalid local decision questions make no network request', async () => {
  clearProfiles();
  registerProfile(profile());
  let calls = 0;
  await assertRejects(
    () =>
      runDecision(
        {
          ...request(),
          questions: {
            invalid: { type: 'score', instructions: 'Assess this.', criteria: [] },
          },
        },
        {
          apiKey: 'test-key',
          fetch: () => {
            calls += 1;
            return Promise.resolve(new Response('{}'));
          },
        },
      ),
    Error,
    "Decision score 'invalid' must declare criteria",
  );
  assertEquals(calls, 0);
});

Deno.test('decision profile declares exactly one model', () => {
  const counts: Record<string, DecisionModelBinding>[] = [
    {},
    { a: { apiId: 'jev-a' }, b: { apiId: 'jev-b' } },
  ];
  for (const models of counts) {
    assertRejects(
      () => Promise.resolve().then(() => defineProfile({ ...profile('model-count'), models })),
      Error,
      "type 'decision' must declare exactly one model",
    );
  }
});

Deno.test('decision profile rejects model-selection fields', () => {
  for (const field of [{ defaultModel: 'jev' }, { allowModelSelect: true }]) {
    assertRejects(
      () =>
        Promise.resolve().then(() => defineProfile({ ...profile('selection'), ...field } as never)),
      Error,
      `type 'decision' must not set ${Object.keys(field)[0]}`,
    );
  }
});

Deno.test('a decision request that names a model makes no network request', async () => {
  clearProfiles();
  registerProfile(profile());
  let calls = 0;
  await assertRejects(
    () =>
      runDecision({ ...request(), model: 'jev' } as DecisionRequest, {
        apiKey: 'test-key',
        fetch: () => {
          calls += 1;
          return Promise.resolve(new Response('{}'));
        },
      }),
    Error,
    'Decision requests do not select a model',
  );
  assertEquals(calls, 0);
});
