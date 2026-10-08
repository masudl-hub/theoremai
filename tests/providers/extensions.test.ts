import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModelEvent,
  TraceRecord,
  TurnEvent,
} from '../../mod.ts';
import {
  contentOf,
  createKernelScope,
  defineProfile,
  defineProvider,
  memorySink,
  modelBindingSchema,
  openAIChat,
} from '../../mod.ts';

const capabilities: ProviderCapabilities = {
  profileTypes: ['text', 'image', 'speech', 'live', 'decision'],
  features: {
    streaming: 'supported',
    clientTools: 'supported',
    parallelTools: 'supported',
    structuredOutput: 'supported',
    thinking: 'supported',
    summaries: 'supported',
    storedContinuation: 'supported',
  },
  inputKinds: ['text', 'image', 'audio', 'video', 'document'],
  outputKinds: ['text', 'image', 'audio'],
  builtins: [],
};
function fixture(
  events: readonly unknown[] = [
    { type: 'text', text: 'hello' },
    { type: 'done', stop: { kind: 'completed' } },
  ],
) {
  let creates = 0;
  const adapter: ProviderAdapter<
    {
      deployment: string;
    },
    {
      style?: string;
    },
    {
      token: string;
    },
    {
      cursor: string;
    }
  > = {
    apiVersion: 1,
    id: 'external-fixture',
    connectionSchema: z.strictObject({ deployment: z.string() }),
    optionsSchema: z.strictObject({ style: z.string().optional() }),
    credentialSchema: z.strictObject({ token: z.string() }),
    capabilities: () => capabilities,
    validateRequest() {},
    continuation: {
      version: 1,
      schema: z.strictObject({ cursor: z.string() }),
      compatibilityKey: (model) => `${model.apiId}:${model.connection.deployment}`,
    },
    create(context) {
      return Promise.resolve().then(() => {
        creates++;
        return {
          async *complete() {
            for (const event of events)
              yield event as ProviderModelEvent<{
                cursor: string;
              }>;
          },
          decide() {
            return Promise.resolve().then(() => {
              return { model: context.apiId, answers: {} };
            });
          },
        };
      });
    },
  };
  const provider = defineProvider({ id: 'company', connection: { deployment: 'east' }, adapter });
  const scope = createKernelScope();
  scope.providers.register(provider);
  scope.profiles.register(
    defineProfile({
      id: 'worker',
      type: 'text',
      identity: { handle: 'worker' },
      models: { default: provider.model('new-model') },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: null },
    }),
  );
  return { scope, provider, adapter, creates: () => creates };
}
Deno.test('external provider uses only public entrypoints and stays lazy', async () => {
  const { scope, provider, creates } = fixture();
  assertEquals(creates(), 0);
  assertEquals(
    JSON.parse(JSON.stringify(provider.model('model', { providerOptions: { style: 'brief' } }))),
    { provider: 'company', apiId: 'model', providerOptions: { style: 'brief' } },
  );
  const result = await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
  assertEquals(
    result.some((event) => event.type === 'text' && event.text === 'hello'),
    true,
  );
  assertEquals(creates(), 1);
  assertThrows(() =>
    modelBindingSchema.parse({ provider: 'company', apiId: 'model', obsolete: {} }),
  );
  assertEquals(createKernelScope().providers.has('company'), false);
});
Deno.test('adapter cannot forge approvals or execute tools', async () => {
  for (const event of [
    { type: 'stage', stage: 'pre_tool' },
    { type: 'tool', tool: { phase: 'complete' } },
  ]) {
    const { scope } = fixture([event]);
    await assertRejects(
      () => Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } })),
      Error,
      'Provider cannot emit',
    );
  }
});
Deno.test('terminal state is checkpointed and incompatible state rebuilds', async () => {
  const { scope } = fixture([
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'one' } },
  ]);
  const events = await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
  const done = events.find((event) => event.type === 'done');
  if (done?.type !== 'done' || !done.providerState) throw new Error('Checkpoint missing');
  const resumed = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      input: { text: 'again' },
      providerState: { ...done.providerState, providerId: 'previous' },
    }),
  );
  assertEquals(
    resumed.some((event) => event.type === 'provider_warning'),
    true,
  );
});
Deno.test('client tools require a complete successful step with no events after termination', async () => {
  const call = { type: 'tool_call', call: { name: 'write', callId: 'call-1', arguments: {} } };
  const good = { type: 'done', stop: { kind: 'tool' } };
  for (const events of [
    [call],
    [call, good, { type: 'text', text: 'late' }],
    [call, call, good],
    [call, { type: 'error', errorKind: 'network' }, good],
    [call, { type: 'done', stop: { kind: 'length' } }],
    [call, good],
  ]) {
    const { scope } = fixture(events);
    let executions = 0;
    scope.tools.register({
      type: 'function',
      name: 'write',
      description: 'Write fixture',
      category: 'test',
      access: 'read-write',
      permission: 'auto',
      paths: ['*'],
      loadTier: 'T0',
      input: z.strictObject({}),
      output: z.strictObject({ ok: z.boolean() }),
      handler() {
        executions++;
        return { ok: true };
      },
    });
    const profile = scope.profiles.get('worker');
    if (profile.type !== 'text') throw new Error('Wrong fixture type');
    scope.profiles.register({ ...profile, maxSteps: 1, tools: { allow: ['write'] } });
    try {
      await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
    } catch (error) {
      assertEquals(error instanceof Error, true);
    }
    assertEquals(executions, events.length === 2 && events[1] === good ? 1 : 0);
  }
});
Deno.test('object credentials and resolvers are validated without exposing resolver failures', async () => {
  const { scope, provider, adapter } = fixture();
  const seen: string[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'identity',
    adapter: {
      ...adapter,
      async create(context) {
        const credential = await context.resolveCredential('primary');
        seen.push(credential?.token ?? '');
        return {
          async *complete() {
            yield { type: 'done', stop: { kind: 'completed' } };
          },
        };
      },
    },
  });
  await Array.fromAsync(
    scope.runTurn(
      { profile: 'worker', input: { text: 'go' } },
      {
        vault: {
          identity: (context) => {
            return Promise.resolve().then(() => {
              assertEquals(context.providerId, 'company');
              assertEquals(context.apiId, 'new-model');
              return { token: 'refreshed' };
            });
          },
        },
      },
    ),
  );
  assertEquals(seen, ['refreshed']);
  await assertRejects(
    () =>
      Array.fromAsync(
        scope.runTurn(
          { profile: 'worker', input: { text: 'go' } },
          {
            vault: {
              identity: () => {
                throw new Error('secret-value');
              },
            },
          },
        ),
      ),
    Error,
    'Provider credential resolution failed',
  );
});

Deno.test('compatible checkpoints resume from portable history, while edited history and malformed state fail safely', async () => {
  const { scope, provider, adapter } = fixture();
  const seen: unknown[] = [];
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create(): Promise<import('../../mod.ts').ProviderOperations<{ cursor: string }>> {
        return Promise.resolve().then(() => {
          return {
            async *complete(request) {
              seen.push(request.state);
              yield { type: 'text', text: 'hello' };
              yield { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } };
            },
          };
        });
      },
    },
  });
  const initial = await Array.fromAsync(
    scope.runTurn({ profile: 'worker', input: { text: 'go' } }),
  );
  const checkpoint = initial.find((event) => event.type === 'done')?.providerState;
  if (!checkpoint) throw new Error('Missing checkpoint');
  const history = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: 'hello' },
  ];
  const resumed = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      providerState: checkpoint,
      input: { text: 'again', history },
    }),
  );
  assertEquals(seen[1], { cursor: 'saved' });
  assertEquals(
    resumed.some((event) => event.type === 'provider_warning'),
    false,
  );
  const edited = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      providerState: checkpoint,
      input: { text: 'again', history: [{ ...history[0], content: 'edited' }, history[1]] },
    }),
  );
  assertEquals(
    edited.find((event) => event.type === 'provider_warning')?.warning.reason,
    'history_changed',
  );
  await assertRejects(() =>
    Array.fromAsync(
      scope.runTurn({
        profile: 'worker',
        providerState: { ...checkpoint, data: { cursor: 1 } },
        input: { text: 'again', history },
      }),
    ),
  );
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong profile');
  scope.profiles.register({ ...profile, providerContinuation: { onMismatch: 'error' } });
  await assertRejects(
    () =>
      Array.fromAsync(
        scope.runTurn({
          profile: 'worker',
          providerState: { ...checkpoint, version: 2 },
          input: { history },
        }),
      ),
    Error,
    'incompatible',
  );
});

Deno.test('vault overrides, refresh, explicit fallback and cancellation stay within selected slots', async () => {
  const { scope, provider, adapter } = fixture();
  const values: unknown[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'default',
    fallbackKeySlot: 'spare',
    adapter: {
      ...adapter,
      async create(context) {
        values.push(await context.resolveCredential('primary'));
        values.push(await context.resolveCredential('fallback'));
        return {
          async *complete() {
            yield { type: 'done', stop: { kind: 'completed' } };
          },
        };
      },
    },
  });
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong profile');
  scope.profiles.register({
    ...profile,
    models: { default: { ...profile.models.default, keySlot: 'identity' } },
  });
  let refresh = 0;
  const vault = {
    identity: () => ({ token: `fresh-${++refresh}` }),
    spare: { token: 'fallback' },
    unrelated: () => {
      throw new Error('Must not resolve');
    },
    default: { token: 'unused' },
  };
  for (let index = 0; index < 2; index++)
    await Array.fromAsync(scope.runTurn({ profile: 'worker' }, { vault }));
  assertEquals(values, [
    { token: 'fresh-1' },
    { token: 'fallback' },
    { token: 'fresh-2' },
    { token: 'fallback' },
  ]);
  const controller = new AbortController();
  let started = false;
  const run = Array.fromAsync(
    scope.runTurn(
      { profile: 'worker', signal: controller.signal },
      {
        vault: {
          identity: () => {
            started = true;
            controller.abort();
            return new Promise(() => {});
          },
        },
      },
    ),
  );
  const aborted = await run;
  assertEquals(aborted.find((event) => event.type === 'done')?.stop.kind, 'cancelled');
  assertEquals(started, true);
});

Deno.test('unknown required capabilities and unavailable operations fail before provider transport', async () => {
  const { scope, provider, adapter, creates } = fixture();
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      capabilities: () => ({
        ...capabilities,
        features: { ...capabilities.features, streaming: 'unknown' },
      }),
    },
  });
  await assertRejects(
    () => Array.fromAsync(scope.runTurn({ profile: 'worker' })),
    Error,
    'verified',
  );
  assertEquals(creates(), 0);
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create(): Promise<import('../../mod.ts').ProviderOperations<{ cursor: string }>> {
        return Promise.resolve().then(() => {
          return {};
        });
      },
    },
  });
  await assertRejects(
    () => Array.fromAsync(scope.runTurn({ profile: 'worker' })),
    Error,
    'complete operation',
  );
});

Deno.test('an independent adapter serves image, speech, live and decision profiles through public runners', async () => {
  const { scope, provider, adapter } = fixture();
  const sends: string[] = [];
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create(context) {
        return Promise.resolve().then(() => {
          return {
            async *complete(request) {
              yield {
                type: 'media',
                media: {
                  mimeType: request.image ? 'image/png' : 'audio/wav',
                  data: btoa('offline-fixture'),
                },
              };
              yield { type: 'done', stop: { kind: 'completed' } };
            },
            decide() {
              return Promise.resolve().then(() => {
                return {
                  model: context.apiId,
                  answers: {
                    safe: {
                      type: 'choice',
                      choice: 'yes',
                      confidence: 1,
                      probabilities: { yes: 1, no: 0 },
                    },
                  },
                };
              });
            },
            openSession() {
              return Promise.resolve().then(() => {
                return {
                  async *events() {
                    yield { type: 'text', text: 'live reply' };
                    yield { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'live' } };
                  },
                  sendText(text) {
                    return Promise.resolve().then(() => {
                      sends.push(text);
                    });
                  },
                  sendAudio() {
                    return Promise.resolve();
                  },
                  sendVideo() {
                    return Promise.resolve();
                  },
                  sendContext() {
                    return Promise.resolve();
                  },
                  sendToolResult() {
                    return Promise.resolve();
                  },
                  close() {
                    return Promise.resolve().then(() => {
                      sends.push('closed');
                    });
                  },
                };
              });
            },
          };
        });
      },
    },
  });
  scope.profiles.register(
    defineProfile({
      id: 'picture',
      type: 'image',
      identity: { handle: 'Picture' },
      models: { main: provider.model('image') },
      tools: { allow: [] },
      inputs: { text: true },
      image: { mimeType: 'image/png' },
    }),
  );
  scope.profiles.register(
    defineProfile({
      id: 'voice',
      type: 'speech',
      identity: { handle: 'Voice' },
      models: { main: provider.model('speech') },
      speech: { voice: 'custom', format: 'pcm' },
    }),
  );
  scope.profiles.register(
    defineProfile({
      id: 'live',
      type: 'live',
      identity: { handle: 'Live' },
      models: { main: provider.model('live') },
      tools: { allow: [] },
      live: { voice: 'custom', ingress: { text: true, audio: false, video: false } },
    }),
  );
  scope.profiles.register(
    defineProfile({
      id: 'decision',
      type: 'decision',
      identity: { handle: 'Decision' },
      models: { main: provider.model('decision', { timeoutMs: 1000 }) },
      inputs: { state: 'json' },
      decision: { contract: 'custom.v1' },
    }),
  );
  for (const [profile, mime] of [
    ['picture', 'image/png'],
    ['voice', 'audio/wav'],
  ]) {
    const events = await Array.fromAsync(scope.runTurn({ profile, input: { text: 'go' } }));
    assertEquals(events.find((event) => event.type === 'media')?.media.mimeType, mime);
  }
  const decision = await scope.runDecision(
    {
      profile: 'decision',
      state: { approved: true },
      questions: {
        safe: {
          type: 'choice',
          instructions: 'Is it approved?',
          criteria: { yes: 'Approved', no: 'Unapproved' },
        },
      },
    },
    {},
  );
  assertEquals(decision.answers.safe.type, 'choice');
  const live = await scope.runSession({ profile: 'live' }, {});
  await live.sendText('hello');
  const events = await Array.fromAsync(live.events());
  assertEquals(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'live reply',
  );
  assertEquals(
    events.some((event) => event.type === 'provider_checkpoint'),
    true,
    JSON.stringify(events),
  );
  assertEquals(sends[0].includes('hello'), true);
  await live.close();
});

Deno.test('a configured compatible endpoint works through the public provider factory', async () => {
  const scope = createKernelScope();
  const provider = defineProvider({
    id: 'company-deployment',
    connection: { baseURL: 'https://deployment.test/serving-endpoints' },
    keySlot: 'identity',
    adapter: openAIChat(),
  });
  scope.providers.register(provider);
  scope.profiles.register(
    defineProfile({
      id: 'compatible',
      type: 'text',
      identity: { handle: 'Compatible' },
      models: { main: provider.model('deployment-id') },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: null },
    }),
  );
  let requested = '';
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'compatible', input: { text: 'hello' } },
      {
        vault: { identity: 'fixture-key' },
        fetch(input, init) {
          requested = String(input);
          assertEquals(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-key');
          const body = JSON.parse(String(init?.body));
          assertEquals(body.model, 'deployment-id');
          return Promise.resolve(
            new Response(
              'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { 'Content-Type': 'text/event-stream' } },
            ),
          );
        },
      },
    ),
  );
  assertEquals(requested, 'https://deployment.test/serving-endpoints/chat/completions');
  assertEquals(
    events.some((event) => event.type === 'text' && event.text === 'hello'),
    true,
  );
});

Deno.test('resolved vault secrets stay out of upstream tracing and adapter diagnostics', async () => {
  const { scope, provider, adapter } = fixture();
  const records: TraceRecord[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'identity',
    adapter: {
      ...adapter,
      create(context) {
        return Promise.resolve({
          async *complete() {
            const credential = await context.resolveCredential('primary');
            if (!credential) throw new Error('Missing fixture credential');
            context.tapUpstream({
              echoed: credential.token,
              authorization: `Bearer ${credential.token}`,
            });
            yield {
              type: 'error',
              errorKind: 'auth',
              errorInternal: `Rejected ${credential.token}`,
            };
            throw new Error(`Transport rejected ${credential.token}`);
          },
        });
      },
    },
  });
  const events: TurnEvent[] = [];
  await assertRejects(
    async () => {
      for await (const event of scope.runTurn(
        { profile: 'worker', input: { text: 'hello' } },
        { vault: { identity: { token: 'fixture-secret-value' } } },
        memorySink(records),
      ))
        events.push(event);
    },
    Error,
    'Transport rejected [redacted]',
  );
  assertEquals(JSON.stringify(events).includes('fixture-secret-value'), false);
  assertEquals(records.length, 1);
  assertEquals(JSON.stringify(records).includes('fixture-secret-value'), false);
  const rows = records.flatMap((record) =>
    record.spans.flatMap((span) =>
      span.events
        .filter((event) => event.name === 'theorem.upstream.row')
        .map((event) => contentOf(record, event.attributes.row)),
    ),
  );
  assertEquals(
    rows.some((row) => row?.includes('echoed') && row.includes('[redacted]')),
    true,
  );
});
