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
import { memorySink } from '../../src/observability/trace.ts';
import { inlineContent, type TraceRecord } from '../../src/observability/trace-record.ts';

function profile(id = 'decision-test') {
  return defineProfile({
    type: 'decision',
    id,
    identity: { handle: 'Decision test' },
    models: {
      jev: { protocol: 'decision', provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 },
    },
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
                legend: { 0: 'low', 1: 'high' },
                probabilities: { 0: 0.1, 1: 0.9 },
              },
            },
            usage: { input_tokens: 2_000_000, output_tokens: 5 },
          }),
          { status: 200 },
        ),
      );
    },
  });
  assertEquals(calls, 1);
  assertEquals(result.model, 'jev-1.13.0');
  assertEquals(result.answers.next.type, 'choice');
  // Jev's fixed price: $0.042 per million input tokens, output free.
  assertEquals(result.usage, { inputTokens: 2_000_000, outputTokens: 5, costUsd: 0.084 });
});

Deno.test('OpenRouter decisions use their binding, provider cost, and trace identity', async () => {
  clearProfiles();
  registerProfile(
    defineProfile({
      ...profile('openrouter-decision'),
      models: {
        span: {
          protocol: 'decision',
          provider: 'openrouter',
          apiId: 'respan/span-01-lite:free',
        },
      },
      guardrails: {
        disclosure: {
          enforce: (_state, context) => {
            assertEquals(context.destination, 'openrouter');
            return { action: 'allow' as const, hits: [] };
          },
        },
      },
    }),
  );
  const records: TraceRecord[] = [];
  const result = await runDecision(
    {
      profile: 'openrouter-decision',
      state: 'The checkout button does nothing.',
      questions: { broken: { type: 'noul', instructions: 'Is a product function broken?' } },
    },
    {
      apiKey: 'test-key',
      sink: memorySink(records),
      fetch: (url, init) => {
        assertEquals(url, 'https://openrouter.ai/api/alpha/decisions');
        assertEquals(
          init?.headers && new Headers(init.headers).get('Authorization'),
          'Bearer test-key',
        );
        assertEquals(JSON.parse(String(init?.body)).model, 'respan/span-01-lite:free');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'respan/span-01-lite-20260925',
              answers: { broken: { type: 'noul', noul: 0.95 } },
              usage: { input_tokens: 64, output_tokens: 0, cost: 0 },
            }),
          ),
        );
      },
    },
  );
  assertEquals(result.usage, { inputTokens: 64, outputTokens: 0, costUsd: 0 });
  assertEquals(records[0]?.spans[0]?.attributes['gen_ai.provider.name'], 'openrouter');
  assertEquals(records[0]?.spans[0]?.attributes['theorem.usage.cost_usd'], 0);
});

Deno.test('decision bindings require the decision protocol and a supported provider', async () => {
  for (const [binding, message] of [
    [{ provider: 'typesafe', apiId: 'jev-latest' }, 'must set models.*.protocol'],
    [{ protocol: 'decision', apiId: 'jev-latest' }, 'must set models.*.provider'],
    [
      { protocol: 'openAi', provider: 'openrouter', apiId: 'jev-latest' },
      "cannot use protocol 'openAi'",
    ],
    [
      { protocol: 'decision', provider: 'google', apiId: 'jev-latest' },
      "not valid for provider 'google'",
    ],
  ] as const) {
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          defineProfile({ ...profile('invalid-binding'), models: { one: binding } } as never),
        ),
      Error,
      message,
    );
  }
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
  for (const [status, code, kind] of [
    [400, 'invalid_request', 'request'],
    [401, 'authentication', 'auth'],
    [403, 'permission', 'auth'],
    [429, 'rate_limited', 'rate_limit'],
    [408, 'timeout', 'timeout'],
    [504, 'timeout', 'timeout'],
    [524, 'timeout', 'timeout'],
    [500, 'unavailable', 'unavailable'],
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
    assertEquals(error.kind, kind);
    assertEquals(error.status, status);
  }
});

Deno.test('cancelled decisions never dispatch, including cancellation during disclosure', async () => {
  for (const duringDisclosure of [false, true]) {
    clearProfiles();
    const controller = new AbortController();
    if (!duringDisclosure) controller.abort();
    registerProfile(
      defineProfile({
        ...profile(),
        guardrails: {
          disclosure: {
            enforce: () => {
              controller.abort();
              return { action: 'allow' as const };
            },
          },
        },
      }),
    );
    let calls = 0;
    const error = await assertRejects(() =>
      runDecision(
        { ...request(), signal: controller.signal },
        {
          apiKey: 'stub',
          fetch: () => {
            calls++;
            return Promise.resolve(jevAnswer());
          },
        },
      ),
    );
    assertEquals((error as { name: string }).name, 'AbortError');
    assertEquals(calls, 0);
  }
});

Deno.test('decision body reads preserve timeout, cancellation, and network failures', async () => {
  for (const mode of ['timeout', 'cancelled', 'network'] as const) {
    clearProfiles();
    registerProfile(
      defineProfile({
        ...profile(),
        models: {
          jev: { ...profile().models.jev, timeoutMs: 10 },
        },
      }),
    );
    const controller = new AbortController();
    const error = await assertRejects(
      () =>
        runDecision(
          { ...request(), signal: controller.signal },
          {
            apiKey: 'stub',
            fetch: (_url, init) =>
              Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(body) {
                      if (mode === 'network') body.error(new TypeError('connection reset'));
                      else {
                        init?.signal?.addEventListener(
                          'abort',
                          () => body.error(new DOMException('aborted', 'AbortError')),
                          { once: true },
                        );
                        if (mode === 'cancelled') controller.abort();
                      }
                    },
                  }),
                ),
              ),
          },
        ),
      DecisionError,
    );
    assertEquals(error.kind, mode);
  }
});

Deno.test('decision JSON and question validation reject invalid values before dispatch', async () => {
  clearProfiles();
  registerProfile(profile());
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let calls = 0;
  const options = {
    apiKey: 'stub',
    fetch: () => {
      calls++;
      return Promise.resolve(jevAnswer());
    },
  };
  for (const state of [
    NaN,
    Infinity,
    { nested: undefined },
    { nested: 1n },
    cyclic,
    new Date(),
    Array.from({ length: 2 }).fill(1, 1),
  ]) {
    const error = await assertRejects(
      () => runDecision({ ...request(), state } as never, options),
      DecisionError,
    );
    assertEquals(error.kind, 'request');
  }
  for (const question of [
    null,
    { type: 'unknown', instructions: 'q' },
    { type: 'noul', instructions: 'q', criteria: { yes: 1 } },
  ]) {
    const error = await assertRejects(
      () => runDecision({ ...request(), questions: { q: question } } as never, options),
      DecisionError,
    );
    assertEquals(error.kind, 'request');
  }
  assertEquals(calls, 0);
});

Deno.test('decision bindings reject retry and inert turn settings', async () => {
  for (const setting of [
    { retry: { maxRetries: 3 } },
    { temperature: 1 },
    { maxOutputTokens: 10 },
    { efforts: { high: 'high' } },
    { allowEffortSelect: true },
    { builtInTools: ['search'] },
  ]) {
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          defineProfile({
            ...profile(),
            models: { jev: { ...profile().models.jev, ...setting } },
          } as never),
        ),
      Error,
    );
  }
});

Deno.test('decision response rejects incomplete legends and ignores invalid usage', async () => {
  clearProfiles();
  registerProfile(profile());
  const body = await jevAnswer().json();
  for (const legend of [{}, { 0: 'low' }, { 0: 'low', 1: '' }, { 0: 'low', 2: 'other' }]) {
    await assertRejects(
      () =>
        runDecision(request(), {
          apiKey: 'stub',
          fetch: () =>
            Promise.resolve(
              Response.json({
                ...body,
                answers: { ...body.answers, risk: { ...body.answers.risk, legend } },
              }),
            ),
        }),
      DecisionError,
    );
  }
  const invalid = await runDecision(request(), {
    apiKey: 'stub',
    fetch: () =>
      Promise.resolve(
        Response.json({
          ...body,
          usage: { input_tokens: -1, output_tokens: 2 },
        }),
      ),
  });
  assertEquals(invalid.usage, undefined);
});

Deno.test('decision pricing respects reported cost and estimates only known direct Jev models', async () => {
  for (const [apiId, model, usage, costUsd] of [
    ['jev-latest', 'jev-1.13.0', { input_tokens: 1_000_000, output_tokens: 1, cost: 0.2 }, 0.2],
    ['other-model', 'other-model', { input_tokens: 1_000_000, output_tokens: 1 }, undefined],
    ['jev-latest', 'other-model', { input_tokens: 1_000_000, output_tokens: 1 }, undefined],
  ] as const) {
    clearProfiles();
    registerProfile(
      defineProfile({
        ...profile(),
        models: { d: { protocol: 'decision', provider: 'typesafe', apiId } },
      }),
    );
    const body = await jevAnswer().json();
    const result = await runDecision(request(), {
      apiKey: 'stub',
      fetch: () => Promise.resolve(Response.json({ ...body, model, usage })),
    });
    assertEquals(result.usage?.costUsd, costUsd);
  }
});

Deno.test('runDecision reports a transport failure as a network error', async () => {
  clearProfiles();
  registerProfile(profile());
  const error = await assertRejects(
    () =>
      runDecision(request(), {
        apiKey: 'test-key',
        fetch: () => Promise.reject(new TypeError('connection reset')),
      }),
    DecisionError,
  );
  assertEquals(error.code, 'network');
  assertEquals(error.kind, 'network');
  assertEquals(error.status, undefined);
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

Deno.test('a state over maxStateBytes makes no network request', async () => {
  clearProfiles();
  registerProfile(profile());
  let calls = 0;
  await assertRejects(
    () =>
      runDecision(
        { ...request(), state: { note: 'x'.repeat(1000) } },
        {
          apiKey: 'test-key',
          fetch: () => {
            calls += 1;
            return Promise.resolve(new Response('{}'));
          },
        },
      ),
    DecisionError,
    'Decision state exceeds 1000 bytes',
  );
  assertEquals(calls, 0);
});

Deno.test('decision profile declares exactly one model', () => {
  const counts: Record<string, DecisionModelBinding>[] = [
    {},
    {
      a: { protocol: 'decision', provider: 'typesafe', apiId: 'jev-a' },
      b: { protocol: 'decision', provider: 'typesafe', apiId: 'jev-b' },
    },
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

Deno.test('decision profile rejects turn inputs', () => {
  for (const inputs of [{ text: true }, { slots: { tone: ['plain'] } }, { maxFiles: 1 }]) {
    assertRejects(
      () =>
        Promise.resolve().then(() =>
          defineProfile({
            ...profile('turn-inputs'),
            inputs: { state: 'json', ...inputs },
          } as never),
        ),
      Error,
      `type 'decision' must not set inputs.${Object.keys(inputs)[0]}`,
    );
  }
});

Deno.test('decision maxStateBytes is a positive integer', () => {
  for (const maxStateBytes of [0, -1, 1.5, Number.NaN]) {
    assertRejects(
      () =>
        Promise.resolve().then(() =>
          defineProfile({ ...profile('state-cap'), inputs: { state: 'json', maxStateBytes } }),
        ),
      Error,
      'decision inputs.maxStateBytes must be a positive integer',
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

function jevAnswer(): Response {
  return new Response(
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
          legend: { 0: 'low', 1: 'high' },
          probabilities: { 0: 0.1, 1: 0.9 },
        },
      },
      usage: { input_tokens: 1_000_000, output_tokens: 5 },
    }),
  );
}

Deno.test('a decision writes one decide record under the host span it names', async () => {
  clearProfiles();
  registerProfile(profile());
  const records: TraceRecord[] = [];
  const parent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
  await runDecision(
    { ...request(), traceparent: parent, metadata: { app: { run: 7 } } },
    { apiKey: 'test-key', fetch: () => Promise.resolve(jevAnswer()), sink: memorySink(records) },
  );
  assertEquals(records.length, 1);
  const [record] = records;
  const [root] = record?.spans ?? [];
  assertEquals(record?.spans.length, 1);
  assertEquals(record?.metadata, { app: { run: 7 } });
  assertEquals(root?.name, 'decide jev-latest');
  assertEquals(root?.traceId, 'a'.repeat(32));
  assertEquals(root?.parentSpanId, 'b'.repeat(16));
  assertEquals(root?.status, { code: 'OK' });
  const attributes = root?.attributes ?? {};
  assertEquals(
    {
      operation: attributes['gen_ai.operation.name'],
      provider: attributes['gen_ai.provider.name'],
      agent: attributes['gen_ai.agent.name'],
      sent: attributes['gen_ai.request.model'],
      alias: attributes['theorem.model.id'],
      answered: attributes['gen_ai.response.model'],
      contract: attributes['theorem.decision.contract'],
      input: attributes['gen_ai.usage.input_tokens'],
      output: attributes['gen_ai.usage.output_tokens'],
      cost: attributes['theorem.usage.cost_usd'],
    },
    {
      operation: 'decide',
      provider: 'typesafe',
      agent: 'decision-test',
      sent: 'jev-latest',
      alias: 'jev',
      answered: 'jev-1.13.0',
      contract: 'test.v1',
      input: 1_000_000,
      output: 5,
      cost: 0.042,
    },
  );
  if (!record) throw new Error('no record');
  assertEquals(inlineContent(record, attributes['theorem.decision.state']), request().state);
  assertEquals(
    inlineContent(record, attributes['theorem.decision.questions']),
    request().questions,
  );
  const answers = inlineContent(record, attributes['theorem.decision.answers']);
  assertEquals((answers as { next: { choice: string } }).next.choice, 'ask_user');
});

Deno.test('a failed decision is recorded with its error kind', async () => {
  clearProfiles();
  registerProfile(profile());
  const records: TraceRecord[] = [];
  await assertRejects(() =>
    runDecision(request(), {
      apiKey: 'test-key',
      fetch: () => Promise.resolve(new Response('{}', { status: 429 })),
      sink: memorySink(records),
    }),
  );
  const root = records[0]?.spans[0];
  assertEquals(root?.status, { code: 'ERROR', message: 'rate_limit' });
  assertEquals(root?.attributes['error.type'], 'rate_limit');
  assertEquals('theorem.decision.answers' in (root?.attributes ?? {}), false);
});

Deno.test('a trace write that fails leaves the decision standing', async () => {
  clearProfiles();
  registerProfile(profile());
  const errors: unknown[] = [];
  const result = await runDecision(request(), {
    apiKey: 'test-key',
    fetch: () => Promise.resolve(jevAnswer()),
    sink: {
      write: () => Promise.reject(new Error('disk full')),
      onError: (error) => errors.push(error),
    },
  });
  assertEquals(result.model, 'jev-1.13.0');
  assertEquals(errors.length, 1);
});

Deno.test('a decision profile names its contract', async () => {
  for (const [decision, message] of [
    [{}, "type 'decision' must set decision.contract"],
    [{ contract: ' ' }, 'decision.contract must be non-empty'],
  ] as const) {
    await assertRejects(
      () =>
        Promise.resolve().then(() =>
          defineProfile({ ...profile('no-contract'), decision } as never),
        ),
      Error,
      message,
    );
  }
});
