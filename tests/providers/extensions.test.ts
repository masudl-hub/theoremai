import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderModelEvent,
  ProviderVault,
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
  TheoremError,
} from '../../mod.ts';
import { PrototypeAdapter } from '../fixtures/prototype-adapter.ts';

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
Deno.test('class adapter and class continuation preserve their receivers on turn resumption', async () => {
  const { scope, provider, adapter } = fixture([
    { type: 'text', text: 'class reply' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
  ]);
  const states: unknown[] = [];
  const create = adapter.create.bind(adapter);
  adapter.create = async (context) => {
    const operations = await create(context);
    return {
      async *complete(request) {
        states.push(request.state);
        if (!operations.complete) throw new Error('Missing complete operation');
        yield* operations.complete(request);
      },
    };
  };
  scope.providers.register({ ...provider, adapter: new PrototypeAdapter(adapter) });
  const initial = await Array.fromAsync(
    scope.runTurn({ profile: 'worker', input: { text: 'go' } }),
  );
  assertEquals(
    initial
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'class reply',
  );
  const checkpoint = initial.find((event) => event.type === 'done')?.providerState;
  if (!checkpoint) throw new Error('Missing class checkpoint');
  const resumed = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      input: {
        text: 'again',
        history: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'class reply' },
        ],
      },
      providerState: checkpoint,
    }),
  );
  assertEquals(
    resumed
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'class reply',
  );
  assertEquals(states, [undefined, { cursor: 'saved' }]);
});
Deno.test('a profile whose provider holds the history resumes from the checkpoint alone', async () => {
  const { scope, provider, adapter } = fixture([
    { type: 'text', text: 'kept' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
  ]);
  const seen: { state: unknown; covered: unknown }[] = [];
  const create = adapter.create.bind(adapter);
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create: async (context) => {
        const operations = await create(context);
        return {
          async *complete(request) {
            seen.push({ state: request.state, covered: request.stateHistoryLength });
            if (!operations.complete) throw new Error('Missing complete operation');
            yield* operations.complete(request);
          },
        };
      },
    },
  });
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong profile');
  scope.profiles.register({
    ...profile,
    providerContinuation: { onMismatch: 'rebuild', history: 'provider' },
  });
  const first = await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
  const checkpoint = first.find((event) => event.type === 'done')?.providerState;
  if (!checkpoint) throw new Error('Missing checkpoint');
  const alone = await Array.fromAsync(
    scope.runTurn({ profile: 'worker', input: { text: 'again' }, providerState: checkpoint }),
  );
  assertEquals(
    alone.some((event) => event.type === 'provider_warning'),
    false,
  );
  const withHistory = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      input: { text: 'again', history: [{ role: 'user', content: 'go' }] },
      providerState: checkpoint,
    }),
  );
  assertEquals(
    withHistory.find((event) => event.type === 'provider_warning'),
    {
      type: 'provider_warning',
      warning: { code: 'provider_state_rebuilt', reason: 'history_changed' },
    },
  );
  assertEquals(seen, [
    { state: undefined, covered: undefined },
    { state: { cursor: 'saved' }, covered: 0 },
    { state: undefined, covered: undefined },
  ]);
});
Deno.test('a stateless profile stands alone: no checkpoint out, no conversation in', async () => {
  const { scope } = fixture([
    { type: 'text', text: 'alone' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
  ]);
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong profile');
  const kept = await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
  const checkpoint = kept.find((event) => event.type === 'done')?.providerState;
  if (!checkpoint) throw new Error('Missing checkpoint');
  scope.profiles.register({
    ...profile,
    providerContinuation: { onMismatch: 'rebuild', history: 'stateless' },
  });
  const alone = await Array.fromAsync(scope.runTurn({ profile: 'worker', input: { text: 'go' } }));
  const done = alone.find((event) => event.type === 'done');
  assertEquals(done?.stop, { kind: 'completed' });
  assertEquals(done?.providerState, undefined);
  for (const carried of [
    { input: { text: 'again', history: [{ role: 'user' as const, content: 'go' }] } },
    { input: { text: 'again' }, providerState: checkpoint },
  ]) {
    const refusal = await assertRejects(
      () => Array.fromAsync(scope.runTurn({ profile: 'worker', ...carried })),
      TheoremError,
      'A stateless profile takes no conversation history',
    );
    assertEquals(refusal.kind, 'request');
  }
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

Deno.test('vault slots require own entries and ignore inherited resolvers', async () => {
  const { scope, provider, adapter } = fixture();
  let inheritedCalls = 0;
  const values: unknown[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'identity',
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
  const vault: ProviderVault = Object.create({
    identity: () => {
      inheritedCalls++;
      return { token: 'inherited-primary' };
    },
    spare: () => {
      inheritedCalls++;
      return { token: 'inherited-fallback' };
    },
  });
  await assertRejects(
    () => Array.fromAsync(scope.runTurn({ profile: 'worker' }, { vault })),
    Error,
    'identity',
  );
  Object.defineProperty(vault, 'identity', { value: { token: 'explicit-primary' } });
  await Array.fromAsync(scope.runTurn({ profile: 'worker' }, { vault }));
  assertEquals(values, [{ token: 'explicit-primary' }, undefined]);
  assertEquals(inheritedCalls, 0);
});

Deno.test('vault property failures do not leak secret-bearing exceptions', async () => {
  const { scope, provider, adapter } = fixture();
  const records: TraceRecord[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'identity',
    adapter: {
      ...adapter,
      async create(context) {
        await context.resolveCredential('primary');
        throw new Error('Credential access must fail');
      },
    },
  });
  const vault: ProviderVault = Object.defineProperty({}, 'identity', {
    get() {
      throw new Error('getter-secret-value');
    },
  });
  const error = await assertRejects(
    () => Array.fromAsync(scope.runTurn({ profile: 'worker' }, { vault }, memorySink(records))),
    Error,
    'Provider credential resolution failed',
  );
  assertEquals(error.message.includes('getter-secret-value'), false);
  assertEquals(JSON.stringify(records).includes('getter-secret-value'), false);
});

Deno.test('credential parsing exceptions remain sanitized before and after adapter validation', async () => {
  for (const transformed of [false, true]) {
    const { scope, provider, adapter } = fixture();
    const records: TraceRecord[] = [];
    const hostile = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        throw new Error('credential-object-secret');
      },
    });
    scope.providers.register({
      ...provider,
      keySlot: 'identity',
      adapter: {
        ...adapter,
        credentialSchema: transformed
          ? adapter.credentialSchema.transform(() => hostile)
          : adapter.credentialSchema,
        async create(context) {
          await context.resolveCredential('primary');
          throw new Error('Credential parsing must fail');
        },
      },
    });
    const error = await assertRejects(
      () =>
        Array.fromAsync(
          scope.runTurn(
            { profile: 'worker' },
            { vault: { identity: () => (transformed ? { token: 'explicit-secret' } : hostile) } },
            memorySink(records),
          ),
        ),
      Error,
      'credential',
    );
    assertEquals(error.message.includes('credential-object-secret'), false);
    assertEquals(error.message.includes('explicit-secret'), false);
    assertEquals(JSON.stringify(records).includes('credential-object-secret'), false);
    assertEquals(JSON.stringify(records).includes('explicit-secret'), false);
  }
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
    adapter: new PrototypeAdapter({
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
    }),
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
              nested: { [credential.token]: { echoed: credential.token } },
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

Deno.test('live ingress and audio output requirements fail before an adapter opens transport', async () => {
  for (const missing of ['audio', 'video', 'output'] as const) {
    const { scope, provider, adapter } = fixture();
    let opened = 0;
    scope.providers.register({
      ...provider,
      adapter: {
        ...adapter,
        capabilities: () => ({
          ...capabilities,
          inputKinds: capabilities.inputKinds.filter((kind) => kind !== missing),
          outputKinds: missing === 'output' ? ['text'] : capabilities.outputKinds,
        }),
        create() {
          opened++;
          return Promise.resolve({});
        },
      },
    });
    scope.profiles.register(
      defineProfile({
        id: 'live',
        type: 'live',
        identity: { handle: 'Live' },
        models: { main: provider.model('live') },
        tools: { allow: [] },
        live: {},
      }),
    );
    await assertRejects(() => scope.runSession({ profile: 'live' }, {}), Error);
    assertEquals(opened, 0);
  }
});

Deno.test('turns snapshot the continuation descriptor before output starts', async () => {
  const { scope, adapter } = fixture([
    { type: 'text', text: 'hello' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'one' } },
  ]);
  const iterator = scope
    .runTurn({ profile: 'worker', input: { text: 'go' } })
    [Symbol.asyncIterator]();
  let first = await iterator.next();
  while (!first.done && first.value.type !== 'text') first = await iterator.next();
  if (!adapter.continuation) throw new Error('Missing continuation');
  adapter.continuation.version = 2;
  const events: TurnEvent[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next())
    events.push(next.value);
  assertEquals(events.find((event) => event.type === 'done')?.providerState?.version, 1);
});

Deno.test('an active class adapter retains captured methods when its registration is replaced', async () => {
  const { scope, provider, adapter } = fixture([
    { type: 'text', text: 'original' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
  ]);
  const prototype = new PrototypeAdapter(adapter);
  scope.providers.register({ ...provider, adapter: prototype });
  const iterator = scope.runTurn({ profile: 'worker', input: { text: 'go' } });
  let next = await iterator.next();
  while (!next.done && next.value.type !== 'text') next = await iterator.next();
  assertEquals(next.value?.type, 'text');
  if (!prototype.continuation) throw new Error('Missing continuation');
  prototype.continuation.compatibilityKey = () => 'replaced';
  scope.providers.register({
    ...provider,
    adapter: new PrototypeAdapter({
      ...adapter,
      create: () =>
        Promise.resolve({
          async *complete() {
            yield { type: 'text', text: 'replacement' };
            yield { type: 'done', stop: { kind: 'completed' } };
          },
        }),
    }),
  });
  const remaining = await Array.fromAsync(iterator);
  assertEquals(
    remaining.find((event) => event.type === 'done')?.providerState?.compatibilityKey,
    'new-model:east',
  );
  const later = await Array.fromAsync(
    scope.runTurn({ profile: 'worker', input: { text: 'again' } }),
  );
  assertEquals(
    later
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'replacement',
  );
});

Deno.test('model and provider changes rebuild native state from portable history', async () => {
  for (const change of ['model', 'provider', 'connection', 'version'] as const) {
    const { scope, provider, adapter } = fixture([
      { type: 'text', text: 'hello' },
      { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
    ]);
    const initial = await Array.fromAsync(
      scope.runTurn({ profile: 'worker', input: { text: 'go' } }),
    );
    const checkpoint = initial.find((event) => event.type === 'done')?.providerState;
    if (!checkpoint) throw new Error('No checkpoint');
    if (!adapter.continuation) throw new Error('Missing continuation');
    let native: unknown = 'not called';
    let history: import('../../mod.ts').TurnHistoryMessage[] | undefined;
    const next = {
      ...provider,
      id: change === 'provider' ? 'new-provider' : provider.id,
      connection: { deployment: change === 'connection' ? 'west' : 'east' },
      adapter: {
        ...adapter,
        continuation: { ...adapter.continuation, version: change === 'version' ? 2 : 1 },
        create: () =>
          Promise.resolve({
            async *complete(request: import('../../mod.ts').ProviderTurnRequest) {
              native = request.state;
              history = request.history;
              yield { type: 'text' as const, text: 'rebuilt' };
              yield { type: 'done' as const, stop: { kind: 'completed' as const } };
            },
          }),
      },
    };
    scope.providers.register(next);
    const profile = scope.profiles.get('worker');
    if (profile.type !== 'text') throw new Error('Wrong type');
    scope.profiles.register({
      ...profile,
      models: {
        default: { provider: next.id, apiId: change === 'model' ? 'different-model' : 'new-model' },
      },
    });
    const portable = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: 'hello' },
    ];
    const events = await Array.fromAsync(
      scope.runTurn({
        profile: 'worker',
        providerState: checkpoint,
        input: { text: 'again', history: portable },
      }),
    );
    assertEquals(native, undefined);
    assertEquals(history?.length, 3);
    assertEquals(
      events.find((event) => event.type === 'provider_warning')?.warning.reason,
      `${change}_changed`,
    );
  }
});

Deno.test('compaction invalidates a checkpoint before the speaker calls its adapter', async () => {
  const { scope, provider, adapter } = fixture([
    { type: 'text', text: 'hello' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'saved' } },
  ]);
  const initial = await Array.fromAsync(
    scope.runTurn({ profile: 'worker', input: { text: 'go' } }),
  );
  const checkpoint = initial.find((event) => event.type === 'done')?.providerState;
  if (!checkpoint) throw new Error('No checkpoint');
  const seen: unknown[] = [];
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create: () =>
        Promise.resolve({
          async *complete(request: import('../../mod.ts').ProviderTurnRequest) {
            seen.push(request.state);
            yield { type: 'text' as const, text: 'summary' };
            yield { type: 'done' as const, stop: { kind: 'completed' as const } };
          },
        }),
    },
  });
  scope.profiles.register(
    defineProfile({
      id: 'compactor',
      type: 'text',
      identity: { handle: 'Summary' },
      models: { main: provider.model('summary') },
      tools: { allow: [] },
      inputs: { text: true },
    }),
  );
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong type');
  scope.profiles.register({
    ...profile,
    models: {
      default: provider.model('new-model', {
        compaction: {
          maxTokens: 100,
          compactAt: 0.5,
          previousExchanges: 0,
          profile: 'compactor',
          timing: 'before',
        },
      }),
    },
  });
  const events = await Array.fromAsync(
    scope.runTurn({
      profile: 'worker',
      providerState: checkpoint,
      input: {
        text: 'continue',
        history: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'word '.repeat(500) },
          { role: 'assistant', content: 'done' },
        ],
      },
    }),
  );
  assertEquals(
    events.some((event) => event.type === 'compaction' && event.outcome === 'compacted'),
    true,
  );
  assertEquals(
    events.find((event) => event.type === 'provider_warning')?.warning.reason,
    'history_changed',
  );
  assertEquals(
    seen.every((state) => state === undefined),
    true,
  );
});

Deno.test('live checkpoints retain exact portable text and rebuild it after a model switch', async () => {
  const { scope, provider, adapter } = fixture();
  const opened: { state: unknown; history: unknown }[] = [];
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      create() {
        return Promise.resolve({
          openSession(request) {
            opened.push({ state: request.state, history: structuredClone(request.history) });
            return Promise.resolve({
              async *events() {
                yield { type: 'text' as const, text: 'hello ' };
                yield { type: 'text' as const, text: 'world' };
                yield {
                  type: 'done' as const,
                  stop: { kind: 'completed' as const },
                  state: { cursor: 'live' },
                };
              },
              sendText: () => Promise.resolve(),
              sendAudio: () => Promise.resolve(),
              sendVideo: () => Promise.resolve(),
              sendContext: () => Promise.resolve(),
              sendToolResult: () => Promise.resolve(),
              close: () => Promise.resolve(),
            });
          },
        });
      },
    },
  });
  const profile = defineProfile({
    id: 'live-resume',
    type: 'live',
    identity: { handle: 'Live' },
    models: { main: provider.model('first') },
    tools: { allow: [] },
    live: { voice: 'custom', ingress: { text: true, audio: false, video: false } },
  });
  scope.profiles.register(profile);
  const first = await scope.runSession({ profile: profile.id }, {});
  await first.sendText('question');
  const events = await Array.fromAsync(first.events());
  const checkpoint = events.find((event) => event.type === 'provider_checkpoint');
  if (!checkpoint?.history) throw new Error('Missing portable checkpoint history');
  assertEquals(checkpoint.history, [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'hello world' },
  ]);
  await first.close();
  const resumed = await scope.runSession(
    { profile: profile.id, history: checkpoint.history, providerState: checkpoint.providerState },
    {},
  );
  const resumedEvents = await Array.fromAsync(resumed.events());
  assertEquals(opened[1].state, { cursor: 'live' });
  assertEquals(
    resumedEvents.some((event) => event.type === 'provider_warning'),
    false,
  );
  await resumed.close();
  scope.profiles.register({ ...profile, models: { main: provider.model('second') } });
  const switched = await scope.runSession(
    { profile: profile.id, history: checkpoint.history, providerState: checkpoint.providerState },
    {},
  );
  const switchedEvents = await Array.fromAsync(switched.events());
  assertEquals(opened[2].state, undefined);
  assertEquals(opened[2].history, checkpoint.history);
  assertEquals(
    switchedEvents.find((event) => event.type === 'provider_warning')?.warning.reason,
    'model_changed',
  );
  await switched.close();
  scope.profiles.register({
    ...profile,
    providerContinuation: { onMismatch: 'rebuild', history: 'stateless' },
  });
  const alone = await scope.runSession({ profile: profile.id }, {});
  await alone.sendText('question');
  const aloneEvents = await Array.fromAsync(alone.events());
  assertEquals(
    aloneEvents.some((event) => event.type === 'provider_checkpoint'),
    false,
  );
  const aloneDone = aloneEvents.find((event) => event.type === 'done');
  assertEquals(aloneDone?.stop, { kind: 'completed' });
  assertEquals(aloneDone?.providerState, undefined);
  await alone.close();
  const refusal = await assertRejects(
    () => scope.runSession({ profile: profile.id, history: checkpoint.history }, {}),
    TheoremError,
    'A stateless profile takes no conversation history',
  );
  assertEquals(refusal.kind, 'request');
});

Deno.test("a live session runs an agent tool on its own provider options, or the hook's", async () => {
  const { scope, provider, adapter } = fixture();
  let hangUp = () => {};
  const hungUp = new Promise<void>((resolve) => {
    hangUp = resolve;
  });
  const canaries: string[] = [];
  scope.providers.register({
    ...provider,
    keySlot: 'identity',
    adapter: {
      ...adapter,
      async create(context) {
        const credential = await context.resolveCredential('primary');
        return {
          async *complete(request) {
            const canary = /Your canary token is (\S+)\./.exec(request.system ?? '')?.[1];
            if (canary) canaries.push(canary);
            yield { type: 'text' as const, text: `answered with ${credential?.token}` };
            yield { type: 'done' as const, stop: { kind: 'completed' as const } };
          },
          openSession() {
            return Promise.resolve({
              async *events() {
                for (const callId of ['one', 'two'])
                  yield {
                    type: 'tool_call' as const,
                    call: { callId, name: 'ask_worker', arguments: { text: 'go' } },
                  };
                yield {
                  type: 'done' as const,
                  stop: { kind: 'tool' as const },
                  state: { cursor: 'live' },
                };
                await hungUp;
              },
              sendText: () => Promise.resolve(),
              sendAudio: () => Promise.resolve(),
              sendVideo: () => Promise.resolve(),
              sendContext: () => Promise.resolve(),
              sendToolResult: () => Promise.resolve(),
              close: () => {
                hangUp();
                return Promise.resolve();
              },
            });
          },
        };
      },
    },
  });
  scope.tools.register({
    type: 'agent',
    name: 'ask_worker',
    description: 'Ask the worker.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    profile: 'worker',
  });
  scope.profiles.register(
    defineProfile({
      id: 'live-agent',
      type: 'live',
      identity: { handle: 'Live' },
      models: { main: provider.model('live') },
      tools: { allow: ['ask_worker'] },
      live: { ingress: { text: true, audio: false, video: false } },
    }),
  );
  const records: TraceRecord[] = [];
  const session = await scope.runSession(
    {
      profile: 'live-agent',
      onAgentCall: (call) =>
        call.callId === 'two'
          ? { provider: { vault: { identity: { token: 'hook' } } } }
          : undefined,
    },
    { vault: { identity: { token: 'session' } } },
    memorySink(records),
  );
  const observed: TurnEvent[] = [];
  const drain = (async () => {
    for await (const event of session.events()) observed.push(event);
  })();
  while (!observed.some((event) => event.type === 'tool' && event.tool.callId === 'two'))
    await new Promise((resolve) => setTimeout(resolve, 0));
  const first = await session.executeTool({ callId: 'one' });
  const second = await session.executeTool({ callId: 'two' });
  assertEquals(first.outputRaw, { text: 'answered with session' });
  assertEquals(second.outputRaw, { text: 'answered with hook' });
  await session.close();
  await drain;
  const spans = records.flatMap((record) => record.spans);
  const nested = spans.filter((span) => span.name === 'invoke_agent worker');
  assertEquals(nested.length, 2);
  assertEquals(
    nested.every((span) =>
      spans.some(
        (parent) =>
          parent.spanId === span.parentSpanId && parent.name === 'execute_tool ask_worker',
      ),
    ),
    true,
  );
  assertEquals(canaries.length, 2);
  const stored = JSON.stringify(records);
  assertEquals(
    canaries.some((canary) => stored.includes(canary)),
    false,
  );
});

Deno.test('live pending tools are withheld on EOF, failure and undeclared parallel calls', async () => {
  for (const end of ['eof', 'error', 'parallel'] as const) {
    const { scope, provider, adapter } = fixture();
    scope.providers.register({
      ...provider,
      adapter: {
        ...adapter,
        capabilities: () => ({
          ...capabilities,
          features: { ...capabilities.features, parallelTools: 'unknown' },
        }),
        create() {
          return Promise.resolve({
            openSession() {
              return Promise.resolve({
                async *events() {
                  yield {
                    type: 'tool_call' as const,
                    call: { callId: 'one', name: 'lookup', arguments: {} },
                  };
                  if (end === 'parallel')
                    yield {
                      type: 'tool_call' as const,
                      call: { callId: 'two', name: 'lookup', arguments: {} },
                    };
                  if (end === 'error')
                    yield { type: 'error' as const, errorKind: 'unavailable' as const };
                  if (end !== 'eof')
                    yield {
                      type: 'done' as const,
                      stop: { kind: 'tool' as const },
                      state: { cursor: 'discard' },
                    };
                },
                sendText: () => Promise.resolve(),
                sendAudio: () => Promise.resolve(),
                sendVideo: () => Promise.resolve(),
                sendContext: () => Promise.resolve(),
                sendToolResult: () => Promise.resolve(),
                close: () => Promise.resolve(),
              });
            },
          });
        },
      },
    });
    scope.profiles.register(
      defineProfile({
        id: 'live-pending',
        type: 'live',
        identity: { handle: 'Live' },
        models: { main: provider.model('live') },
        tools: { allow: [] },
        live: { ingress: { text: true, audio: false, video: false } },
      }),
    );
    const session = await scope.runSession({ profile: 'live-pending' }, {});
    const observed: TurnEvent[] = [];
    try {
      for await (const event of session.events()) observed.push(event);
    } catch (error) {
      assertEquals(end, 'parallel', String(error));
      assertEquals(error instanceof Error, true);
    }
    assertEquals(
      observed.some((event) => event.type === 'tool' || event.type === 'provider_checkpoint'),
      false,
    );
    await session.close();
  }
});

Deno.test('model helpers retain the adapter option type', () => {
  const { provider } = fixture();
  type Settings = NonNullable<Parameters<typeof provider.model>[1]>;
  type Options = NonNullable<Settings['providerOptions']>;
  const acceptsString: { style: string } extends Options ? true : false = true;
  const acceptsNumber: { style: number } extends Options ? true : false = false;
  const acceptsUnknown: { other: string } extends Options ? true : false = false;
  assertEquals([acceptsString, acceptsNumber, acceptsUnknown], [true, false, false]);
});

Deno.test('failed and incomplete model steps never commit native state', async () => {
  for (const stop of ['provider_error', 'stream_incomplete', 'filtered', 'interrupted'] as const) {
    const { scope } = fixture([
      { type: 'done', stop: { kind: stop }, state: { cursor: 'discard' } },
    ]);
    const events = await Array.fromAsync(scope.runTurn({ profile: 'worker' }));
    assertEquals(events.find((event) => event.type === 'done')?.providerState, undefined);
  }
  const { scope } = fixture([
    { type: 'error', errorKind: 'unavailable' },
    { type: 'done', stop: { kind: 'completed' }, state: { cursor: 'discard' } },
  ]);
  const events = await Array.fromAsync(scope.runTurn({ profile: 'worker' }));
  assertEquals(events.find((event) => event.type === 'done')?.providerState, undefined);
});

Deno.test('an adapter declares its own builtins, and a request hands one its args', async () => {
  const { scope, provider, adapter } = fixture();
  let builtins: unknown;
  for (const name of ['company_search', 'company_files', 'company_code'])
    scope.tools.register({
      type: 'builtin',
      name,
      description: 'Hosted company tool',
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier: 'T0',
      permission: 'auto',
    });
  scope.providers.register({
    ...provider,
    adapter: {
      ...adapter,
      builtins: {
        company_search: { args: z.strictObject({ region: z.enum(['eu', 'us']) }) },
        company_files: {},
        company_code: {},
      },
      capabilities: () => ({
        ...capabilities,
        builtins: ['company_search', 'company_files', 'company_code'],
      }),
      create: () =>
        Promise.resolve({
          async *complete(request) {
            builtins = request.builtins;
            yield { type: 'done', stop: { kind: 'completed' } };
          },
        }),
    },
  });
  const profile = scope.profiles.get('worker');
  if (profile.type !== 'text') throw new Error('Wrong profile');
  scope.profiles.register({
    ...profile,
    models: {
      default: provider.model('model', { builtInTools: ['company_search', 'company_files'] }),
    },
  });
  /** What the turn was refused with, or 'ran'. */
  const refusal = async (builtInArgs: Record<string, Record<string, string>>) => {
    try {
      const events = await Array.fromAsync(scope.runTurn({ profile: 'worker', builtInArgs }));
      const error = events.find((event) => event.type === 'error');
      return error?.type === 'error' ? error.errorInternal : 'ran';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  await Array.fromAsync(scope.runTurn({ profile: 'worker' }));
  assertEquals(builtins, [{ id: 'company_search' }, { id: 'company_files' }]);

  assertEquals(await refusal({ company_search: { region: 'eu' } }), 'ran');
  assertEquals(builtins, [
    { id: 'company_search', args: { region: 'eu' } },
    { id: 'company_files' },
  ]);

  assertEquals(
    await refusal({ company_code: {} }),
    "Profile worker: builtInArgs names 'company_code', which model 'default' does not list in builtInTools",
  );
  assertEquals(
    await refusal({ company_files: {} }),
    "Profile worker: builtin 'company_files' takes no args on provider 'company'",
  );
  const invalid = await refusal({ company_search: { region: 'mars' } });
  assertEquals(invalid?.startsWith('Profile worker: builtInArgs.company_search.region: '), true);
});
