import { assertEquals, assertRejects } from '@std/assert';
import { defineProvider, openAIChat, type ProfileDefinition, z } from '../../mod.ts';
import { type ProviderAdapterFixture, verifyProviderAdapter } from '../../src/providers/testing.ts';

const provider = defineProvider({
  id: 'external',
  connection: {},
  keySlot: 'primary',
  adapter: {
    apiVersion: 1,
    id: 'independent',
    connectionSchema: z.strictObject({}),
    optionsSchema: z.object({ missing: z.boolean().default(false) }),
    credentialSchema: z.string(),
    capabilities: () => ({
      profileTypes: ['text'],
      features: {
        streaming: 'supported',
        clientTools: 'unsupported',
        parallelTools: 'unsupported',
        structuredOutput: 'unsupported',
        thinking: 'unsupported',
        summaries: 'unsupported',
        storedContinuation: 'unsupported',
      },
      inputKinds: ['text'],
      outputKinds: ['text'],
      builtins: [],
    }),
    validateRequest() {},
    async create(context) {
      await context.resolveCredential('primary');
      return {
        async *complete() {
          yield { type: 'text' as const, text: 'hello' };
          if (!context.providerOptions.missing)
            yield { type: 'done' as const, stop: { kind: 'completed' as const } };
        },
      };
    },
  },
});
function profile(missing = false): Extract<ProfileDefinition, { type: 'text' }> {
  return {
    id: 'fixture',
    type: 'text',
    identity: { handle: 'Fixture' },
    models: {
      default: provider.model('model', { summaries: false, providerOptions: { missing } }),
    },
    tools: { allow: [] },
    inputs: { text: true },
  };
}
function fixture(overrides: Partial<ProviderAdapterFixture> = {}): ProviderAdapterFixture {
  return {
    name: 'success',
    operation: 'complete',
    profile: profile(),
    request: { input: { text: 'hello' } },
    host: {
      vault: {
        primary: 'fixture-key',
        unrelated: () => {
          throw new Error('secret must not be read');
        },
      },
    },
    ...overrides,
  } as ProviderAdapterFixture;
}
Deno.test('public conformance fixtures separate pass, fail, missing evidence and unsupported operations', async () => {
  const report = await verifyProviderAdapter({
    provider,
    model: { apiId: 'model' },
    fixtures: [
      fixture({
        checks: ['terminal', 'credential_isolation'],
        inspect: (observation) => assertEquals(observation.credentialSlots, ['primary']),
      }),
      fixture({
        name: 'missing terminal',
        profile: profile(true),
        checks: ['terminal'],
        expectError: 'bad_response',
      }),
      fixture({
        name: 'cancel',
        abortBeforeStart: true,
        expectError: 'cancelled',
      }),
      fixture({
        name: 'event budget',
        checks: ['budgets'],
        host: { limits: { maxEventBytes: 1 }, vault: { primary: 'key' } },
        expectError: 'bad_response',
        inspect: ({ errorCopy }) => {
          assertEquals(
            errorCopy && 'key' in errorCopy ? errorCopy.key : undefined,
            'provider.budget_exhausted',
          );
        },
      }),
      fixture({ name: 'wrong expectation', expectError: 'auth' }),
    ],
  });
  assertEquals(
    report.fixtures.map((item) => item.status),
    ['pass', 'pass', 'pass', 'pass', 'fail'],
  );
  assertEquals(report.fixtures[4].category, 'expectation');
  assertEquals(report.operations, [
    { operation: 'complete', support: 'supported', status: 'fail' },
    { operation: 'decide', support: 'unsupported', status: 'unverified' },
    { operation: 'openSession', support: 'unsupported', status: 'unverified' },
  ]);
  assertEquals(
    report.checks.map((item) => item.status),
    ['fail', 'unverified', 'pass', 'pass', 'pass'],
  );
  const missing = await verifyProviderAdapter({
    provider,
    model: { apiId: 'model' },
    fixtures: [],
  });
  assertEquals(missing.operations[0], {
    operation: 'complete',
    support: 'supported',
    status: 'unverified',
  });
  assertEquals(
    missing.checks.every((item) => item.status === 'unverified'),
    true,
  );
});
Deno.test('negative fixtures alone do not verify a supported operation', async () => {
  const report = await verifyProviderAdapter({
    provider,
    model: { apiId: 'model' },
    fixtures: [
      fixture({ profile: profile(true), expectError: 'bad_response', checks: ['terminal'] }),
    ],
  });
  assertEquals(report.fixtures[0].status, 'pass');
  assertEquals(report.operations[0].status, 'unverified');
  assertEquals(report.checks[0].status, 'unverified');
});

Deno.test('conformance refuses fixture claims without the required evidence configuration', async () => {
  const invalid = [
    fixture({ profile: { id: 'host', type: 'host', tools: { allow: [] } } }),
    fixture({
      profile: { ...profile(), models: { default: { provider: 'foreign', apiId: 'model' } } },
    }),
    fixture({ checks: ['cancellation'], abortBeforeStart: true, expectError: 'cancelled' }),
    fixture({ checks: ['cancellation'], expectError: 'cancelled', inspect() {} }),
    fixture({ checks: ['cancellation'], cancel() {}, expectError: 'auth', inspect() {} }),
    fixture({ checks: ['cancellation'], cancel() {}, expectError: 'cancelled' }),
    fixture({ checks: ['budgets'], expectError: 'bad_response', inspect() {} }),
    fixture({ checks: ['budgets'], host: { limits: { maxEventBytes: 1 } }, inspect() {} }),
    fixture({
      checks: ['budgets'],
      host: { limits: { maxEventBytes: 1 } },
      expectError: 'bad_response',
    }),
    fixture({ checks: ['credential_isolation'] }),
    {
      ...fixture(),
      operation: 'decide' as const,
      checks: ['terminal' as const],
      request: { state: {}, questions: {} },
    },
  ];
  const report = await verifyProviderAdapter({
    provider,
    fixtures: invalid.map((entry, index) => ({ ...entry, name: `invalid-${index}` })),
  });
  assertEquals(
    report.fixtures.map((result) => [result.status, result.category]),
    invalid.map(() => ['fail' as const, 'configuration' as const]),
  );
});
Deno.test('fixture deadlines bound uncooperative host setup and failures omit sensitive diagnostics', async () => {
  const report = await verifyProviderAdapter({
    provider,
    timeoutMs: 10,
    fixtures: [fixture({ setup: () => new Promise(() => {}) })],
  });
  assertEquals(report.fixtures[0].errorKind, 'timeout');
  const sensitive = await verifyProviderAdapter({
    provider,
    fixtures: [
      fixture({
        inspect: () => {
          throw new Error('secret-fixture-key');
        },
      }),
    ],
  });
  assertEquals(sensitive.fixtures[0].category, 'inspection');
  assertEquals(JSON.stringify(sensitive).includes('secret-fixture-key'), false);
  await assertRejects(() => verifyProviderAdapter({ provider, fixtures: [fixture(), fixture()] }));
});
Deno.test('compatible endpoints use the same public conformance runner', async () => {
  const compatible = defineProvider({
    id: 'compatible',
    connection: {
      baseURL: 'https://fixture.test/v1',
    },
    adapter: openAIChat(),
  });
  const report = await verifyProviderAdapter({
    provider: compatible,
    fixtures: [
      {
        name: 'chat endpoint',
        operation: 'complete',
        profile: {
          id: 'fixture',
          type: 'text',
          identity: { handle: 'Fixture' },
          models: { default: compatible.model('model', { summaries: false }) },
          inputs: { text: true },
          tools: { allow: [] },
        },
        request: { input: { text: 'hello' } },
        host: {
          fetch: () =>
            Promise.resolve(
              new Response(
                'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } },
              ),
            ),
        },
      },
    ],
  });
  assertEquals(report.fixtures[0].status, 'pass');
});

Deno.test('conformance live and decision operations exercise their public runner boundaries', async () => {
  const sent: string[] = [];
  const multi = defineProvider({
    ...provider,
    id: 'multi',
    adapter: {
      ...provider.adapter,
      capabilities: () => ({
        ...provider.adapter.capabilities({
          apiId: 'model',
          connection: {},
          providerOptions: { missing: false },
        }),
        profileTypes: ['decision', 'live'],
        inputKinds: ['text', 'image', 'audio', 'video', 'document'],
        outputKinds: ['text', 'audio'],
      }),
      create: () =>
        Promise.resolve({
          decide: () =>
            Promise.resolve({
              model: 'model',
              answers: {
                allowed: {
                  type: 'choice' as const,
                  choice: 'yes',
                  confidence: 1,
                  probabilities: { yes: 1, no: 0 },
                },
              },
            }),
          openSession: () => {
            let stop = () => {};
            const closed = new Promise<void>((resolve) => {
              stop = resolve;
            });
            return Promise.resolve({
              async *events() {
                yield { type: 'text' as const, text: 'live' };
                yield { type: 'done' as const, stop: { kind: 'completed' as const } };
                await closed;
              },
              sendText(text: string) {
                sent.push(text);
                return Promise.resolve();
              },
              sendAudio: () => Promise.resolve(),
              sendVideo: () => Promise.resolve(),
              sendContext: () => Promise.resolve(),
              sendToolResult: () => Promise.resolve(),
              close() {
                stop();
                return Promise.resolve();
              },
            });
          },
        }),
    },
  });
  const report = await verifyProviderAdapter({
    provider: multi,
    model: { apiId: 'model' },
    fixtures: [
      {
        name: 'decision',
        operation: 'decide',
        profile: {
          id: 'decision',
          type: 'decision',
          identity: { handle: 'Decision' },
          inputs: { state: 'json' },
          decision: { contract: 'fixture.v1' },
          models: { default: multi.model('model') },
        },
        request: {
          state: { value: 1 },
          questions: {
            allowed: { type: 'choice', instructions: 'Allow?', criteria: { yes: 'Yes', no: 'No' } },
          },
        },
        inspect: ({ value }) =>
          assertEquals(
            (value as { answers: { allowed: { choice: string } } }).answers.allowed.choice,
            'yes',
          ),
      },
      {
        name: 'live',
        operation: 'openSession',
        profile: {
          id: 'live',
          type: 'live',
          identity: { handle: 'Live' },
          models: { default: multi.model('model', { summaries: false }) },
          tools: { allow: [] },
          live: { ingress: { text: true } },
        },
        request: {},
        exercise: (session) => session.sendText('fixture input'),
        inspect: ({ events }) =>
          assertEquals(
            events.some((event) => event.type === 'text' && event.text === 'live'),
            true,
          ),
      },
    ],
  });
  assertEquals(
    report.fixtures.map((fixture) => fixture.status),
    ['pass', 'pass'],
  );
  assertEquals(
    sent.some((text) => text.includes('fixture input')),
    true,
  );
});

Deno.test('active cancellation verifies injected transport cleanup, independently of preflight abort', async () => {
  let entered = () => {};
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const compatible = defineProvider({
    id: 'cancel-endpoint',
    connection: { baseURL: 'https://fixture.test/v1' },
    adapter: openAIChat(),
  });
  const report = await verifyProviderAdapter({
    provider: compatible,
    fixtures: [
      {
        name: 'active cancellation',
        operation: 'complete',
        checks: ['cancellation'],
        expectError: 'cancelled',
        profile: {
          id: 'cancel-fixture',
          type: 'text',
          identity: { handle: 'Fixture' },
          models: { default: compatible.model('model', { summaries: false }) },
          inputs: { text: true },
          tools: { allow: [] },
        },
        request: { input: { text: 'hello' } },
        host: {
          fetch: (_input, init) => {
            signal = init?.signal ?? undefined;
            return Promise.resolve(
              new Response(
                new ReadableStream(
                  {
                    pull() {
                      entered();
                    },
                    cancel() {
                      cancelled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
                { headers: { 'content-type': 'text/event-stream' } },
              ),
            );
          },
        },
        cancel: async (control) => {
          await reading;
          control.abort();
        },
        inspect: () => {
          assertEquals(signal?.aborted, true);
          assertEquals(cancelled, true);
        },
      },
    ],
  });
  assertEquals(report.fixtures[0].status, 'pass');
  assertEquals(report.checks.find((check) => check.check === 'cancellation')?.status, 'pass');
});
