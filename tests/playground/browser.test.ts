import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { type ModelProvider, type ProviderEvent, TheoremError } from '../../mod.ts';
import {
  createBrowserPlaygroundTransport,
  keyKind,
  localPlaygroundConfig,
  playgroundKeySlots,
  playgroundVault,
} from '../../playground/browser.ts';
import {
  compilePlayground,
  createExampleDraft,
  createPlaygroundTransport,
} from '../../playground/mod.ts';
import { streamPlaygroundTurn } from '../../playground/runtime.ts';
import type { ClientTurnEvent } from '../../react/src/client/transport.ts';
import { createMemorySteerInbox } from '../../react/src/server/steer-inbox.ts';
import { TEST_GOOGLE_KEY, TEST_OPENROUTER_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { replyText } from '../fixtures/reply.ts';

function payload() {
  const result = compilePlayground(createExampleDraft());
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}
function provider(events: ProviderEvent[]): ModelProvider {
  return {
    async *complete() {
      yield* events;
    },
  };
}

Deno.test('browser and HTTP playground transports preserve turn events and traces', async () => {
  const compiled = payload();
  const runtime = {
    mode: 'byok' as const,
    provider: () =>
      provider([
        { type: 'text', text: 'Hello.' },
        { type: 'tokens', tokens: { input: 10, output: 2, total: 12 } },
      ]),
  };
  const browser = createBrowserPlaygroundTransport(compiled, runtime);
  const http = createPlaygroundTransport(compiled, {
    fetch: async () => {
      const lines = [];
      for await (const line of streamPlaygroundTurn({
        ...compiled,
        input: { text: 'Hello' },
        steer: createMemorySteerInbox(),
        runtime,
      }))
        lines.push(line);
      return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    },
  });
  const directEvents: ClientTurnEvent[] = [];
  const httpEvents: ClientTurnEvent[] = [];
  await browser.turn({ input: { text: 'Hello' } }, (event) => directEvents.push(event));
  await http.turn({ input: { text: 'Hello' } }, (event) => httpEvents.push(event));
  const normalized = (events: ClientTurnEvent[]) =>
    events.map((event) => (event.type === 'done' ? { ...event, traceparent: undefined } : event));
  assertEquals(normalized(directEvents), normalized(httpEvents));
  assertEquals(
    replyText(
      directEvents.filter((event) => event.type !== 'unsupported' && event.type !== 'malformed'),
    ),
    'Hello.',
  );
  assertEquals(browser.traces?.records().length, http.traces?.records().length);
  assert((browser.traces?.records().length ?? 0) > 0);
});

Deno.test('browser failures reject with the same public error as HTTP', async () => {
  const compiled = payload();
  const runtime = {
    mode: 'byok' as const,
    provider: () => ({
      async *complete() {
        await Promise.resolve();
        yield* [];
        throw new TheoremError('auth', 'Missing key');
      },
    }),
  };
  const browser = createBrowserPlaygroundTransport(compiled, runtime);
  const emitted: ClientTurnEvent[] = [];
  const failure = await assertRejects(() =>
    browser.turn({ input: { text: 'Hello' } }, (event) => emitted.push(event)),
  );
  assertEquals((failure as { kind?: string }).kind, 'auth');
  assertEquals(
    emitted.some((event) => event.type === 'error'),
    false,
  );
  assert((browser.traces?.records().length ?? 0) > 0);
});

Deno.test('named primary and fallback slots include model overrides and isolate vaults', () => {
  const slots = playgroundKeySlots({
    key: 'primary',
    fallbackKey: 'backup',
    models: { fast: { key: 'fast-key', fallbackKey: 'backup' } },
  });
  assertEquals(slots, ['primary', 'backup', 'fast-key']);
  assertEquals(
    playgroundVault([...slots, 'constructor'], { primary: 'a', backup: 'b', unrelated: 'private' }),
    { primary: 'a', backup: 'b', 'fast-key': undefined, constructor: undefined },
  );
  assertEquals(playgroundVault(slots, { primary: 'other' }).primary, 'other');
  const draft = createExampleDraft();
  draft.modelBindings = draft.modelBindings.filter((model) => model.provider === 'google');
  draft.models.fallbackKey = 'backup';
  draft.modelBindings[0].keySlot = 'fast-key';
  draft.modelBindings[0].fallbackKeySlot = 'fast-backup';
  const compiled = compilePlayground(draft, 'byok');
  assert(compiled.ok && compiled.profile.type === 'text');
  assertEquals(compiled.profile.fallbackKey, 'backup');
  assertEquals(compiled.profile.models.fast.key, 'fast-key');
  assertEquals(compiled.profile.models.fast.fallbackKey, 'fast-backup');
});

Deno.test('a pasted key shows its service from the published prefix, and nothing else', () => {
  assertEquals(keyKind(` ${TEST_GOOGLE_KEY}`), 'google');
  assertEquals(keyKind(TEST_OPENROUTER_KEY), 'openrouter');
  assertEquals(keyKind('some-other-key'), undefined);
  assertEquals(keyKind(''), undefined);
  assertEquals(keyKind(undefined), undefined);
});

Deno.test('local connections refuse remote URLs and redirects, and add no auth of their own', async () => {
  for (const baseUrl of [
    'https://example.com',
    'http://user:pass@localhost:11434',
    'http://localhost:11434?key=secret',
  ])
    assertThrows(() => localPlaygroundConfig({ baseUrl }));
  const config = localPlaygroundConfig({ baseUrl: 'http://127.0.0.1:11434' });
  assert(config?.fetch);
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (_input, init) => {
    called = true;
    assertEquals(new Headers(init?.headers).get('Authorization'), null);
    assertEquals(init?.redirect, 'error');
    assertEquals(init?.credentials, 'omit');
    return Promise.resolve(new Response('{}'));
  };
  try {
    await config.fetch('http://127.0.0.1:11434/v1/chat/completions', {});
    assert(called);
    called = false;
    const send = config.fetch;
    await assertRejects(() => send('https://example.com', {}));
    assertEquals(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('browser cancellation reaches the provider without contacting a site endpoint', async () => {
  const controller = new AbortController();
  let providerSignal: AbortSignal | undefined;
  const transport = createBrowserPlaygroundTransport(payload(), {
    mode: 'byok',
    provider: () => ({
      async *complete(request) {
        providerSignal = request.signal;
        controller.abort();
        yield* [];
        request.signal?.throwIfAborted();
      },
    }),
  });
  const events: ClientTurnEvent[] = [];
  await transport.turn(
    { input: { text: 'Hello' } },
    (event) => events.push(event),
    controller.signal,
  );
  assert(events.some((event) => event.type === 'done' && event.stop?.kind === 'cancelled'));
  assertEquals(providerSignal?.aborted, true);
});

Deno.test('local browser runs block HTTP tools unless explicitly enabled', async () => {
  const { createBrowserPlaygroundHostTransport } = await import('../../playground/browser.ts');
  const compiled = {
    agentId: 'local-host',
    profile: { id: 'local-host', type: 'host' as const, tools: { allow: ['remote'] } },
    customTools: [
      {
        type: 'http' as const,
        name: 'remote',
        description: 'Remote read',
        category: 'read',
        access: 'read-only' as const,
        permission: 'auto' as const,
        loadTier: 'T1' as const,
        paths: ['remote'],
        endpoint: 'https://example.com',
        method: 'GET' as const,
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
      },
    ],
  };
  const transport = createBrowserPlaygroundHostTransport(compiled, {
    mode: 'local',
    remoteTools: false,
  });
  const events: ClientTurnEvent[] = [];
  await transport.call({ name: 'remote', input: {} }, (event) => events.push(event));
  assertEquals(
    events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
    false,
  );
  assert(events.some((event) => event.type === 'tool' && event.tool.phase === 'error'));
});

Deno.test('browser host gates settle through the same replay path as HTTP', async () => {
  const { createBrowserPlaygroundHostTransport } = await import('../../playground/browser.ts');
  const { createPlaygroundHostTransport } = await import('../../playground/transport.ts');
  const { streamPlaygroundCall, streamPlaygroundInvoke } = await import(
    '../../playground/runtime.ts'
  );
  const compiled = {
    agentId: 'gated-host',
    profile: { id: 'gated-host', type: 'host' as const, tools: { allow: ['echo'] } },
    customTools: [
      {
        type: 'function' as const,
        name: 'echo',
        description: 'Test gate',
        category: 'test',
        access: 'read-only' as const,
        permission: 'always_confirm' as const,
        loadTier: 'T0' as const,
        paths: ['*'],
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object', properties: {} },
        stubResponse: { ok: true },
      },
    ],
  };
  const runtime = { mode: 'byok' as const };
  const http = createPlaygroundHostTransport(compiled, {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      const source = String(url).endsWith('/invoke')
        ? streamPlaygroundInvoke({ ...compiled, answer: body, runtime })
        : streamPlaygroundCall({ ...compiled, call: body, runtime });
      const lines = [];
      for await (const line of source) lines.push(line);
      return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    },
  });
  for (const transport of [http, createBrowserPlaygroundHostTransport(compiled, runtime)]) {
    const events: ClientTurnEvent[] = [];
    await transport.call({ name: 'echo', input: {} }, (event) => events.push(event));
    const gate = events.find((event) => event.type === 'tool' && event.tool.phase === 'gate');
    assert(gate?.type === 'tool');
    assertEquals(
      events.some((event) => event.type === 'tool' && event.tool.phase === 'complete'),
      false,
    );
    const settled: ClientTurnEvent[] = [];
    await transport.invoke(
      { gateId: gate.tool.callId, decision: 'approve', replay: { name: 'echo', input: {} } },
      (event) => settled.push(event),
    );
    const complete = settled.find(
      (event) => event.type === 'tool' && event.tool.phase === 'complete',
    );
    assert(complete?.type === 'tool' && complete.tool.phase === 'complete');
    assertEquals(complete.tool.output, { ok: true });
  }
});

Deno.test('model discovery uses the inference endpoint and returns the server model names', async () => {
  const { listLocalPlaygroundModels } = await import('../../playground/browser.ts');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    assertEquals(String(input), 'http://127.0.0.1:11434/v1/models');
    return Promise.resolve(
      Response.json({
        data: [{ id: 'local-model:7b' }, { id: 'local-model:3b' }, { id: 'local-model:7b' }],
      }),
    );
  };
  try {
    assertEquals(await listLocalPlaygroundModels({ baseUrl: 'http://127.0.0.1:11434' }), [
      'local-model:7b',
      'local-model:3b',
    ]);
    globalThis.fetch = () => Promise.resolve(Response.json({ unexpected: 'shape' }));
    await assertRejects(() => listLocalPlaygroundModels({ baseUrl: 'http://127.0.0.1:11434' }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('provider model lists keep the profile type and never put the key in the URL', async () => {
  const { listProviderModels } = await import('../../playground/browser.ts');
  const originalFetch = globalThis.fetch;
  const seen: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    if (url.startsWith('https://openrouter.ai/')) {
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: 'vendor/painter',
              name: 'Vendor: Painter',
              architecture: { output_modalities: ['image', 'text'] },
            },
            {
              id: 'vendor/chatter',
              name: 'Vendor: Chatter',
              architecture: { output_modalities: ['text'] },
            },
          ],
        }),
      );
    }
    const page = new URL(url).searchParams.get('pageToken');
    return Promise.resolve(
      Response.json(
        page
          ? {
              models: [
                {
                  name: 'models/gemini-live',
                  displayName: 'Gemini Live',
                  supportedGenerationMethods: ['bidiGenerateContent'],
                },
              ],
            }
          : {
              models: [
                {
                  name: 'models/gemini-flash',
                  displayName: 'Gemini Flash',
                  supportedGenerationMethods: ['generateContent'],
                },
                { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
              ],
              nextPageToken: 'next',
            },
      ),
    );
  };
  try {
    assertEquals(await listProviderModels('openrouter', 'image', undefined), [
      { id: 'vendor/painter', label: 'Vendor: Painter' },
    ]);
    assertEquals(seen[0].url, 'https://openrouter.ai/api/v1/models?output_modalities=image');
    assertEquals(await listProviderModels('openrouter', 'live', TEST_OPENROUTER_KEY), []);
    assertEquals(await listProviderModels('google', 'text', TEST_GOOGLE_KEY), [
      { id: 'gemini-flash', label: 'Gemini Flash' },
    ]);
    assertEquals(await listProviderModels('google', 'live', TEST_GOOGLE_KEY), [
      { id: 'gemini-live', label: 'Gemini Live' },
    ]);
    for (const request of seen.slice(1)) {
      assertEquals(request.url.includes(TEST_GOOGLE_KEY), false);
      assertEquals(request.headers.get('x-goog-api-key'), TEST_GOOGLE_KEY);
    }
    await assertRejects(() => listProviderModels('google', 'text', undefined), TheoremError);
    globalThis.fetch = () => Promise.resolve(new Response('', { status: 400 }));
    await assertRejects(
      () => listProviderModels('google', 'text', TEST_GOOGLE_KEY),
      TheoremError,
      'refused the key',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
