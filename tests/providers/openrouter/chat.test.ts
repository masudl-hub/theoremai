import '../../fixtures/test-host.ts';
import { assertEquals } from '@std/assert';
import { resolveTurn } from '../../../src/kernel/default-scope.ts';
import { providerBuiltins } from '../../../src/kernel/registry/provider-request.ts';
import { defaultKernelScope } from '../../../src/kernel/scope.ts';
import type { ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import { createOpenRouterProvider } from '../../../src/providers/openrouter/chat.ts';
import { citedUris, eventsOf, firstOf } from '../../fixtures/events.ts';
import { googleBuiltins } from '../../fixtures/provider-request.ts';
import { testWireTool } from '../../fixtures/wire-tools.ts';

type R = Record<string, unknown>;
function _field(ev: unknown, ...keys: string[]): unknown {
  let cur: unknown = ev;
  for (const k of keys) {
    cur = (cur as R)?.[k];
  }
  return cur;
}

const EXPECTED_INPUT_TOKENS = 25;
const EXPECTED_OUTPUT_TOKENS = 40;
const EXPECTED_TOTAL_TOKENS = 65;

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) {
        const normalized = chunk.replace(/data: (.+)\n/g, (line, data: string) => {
          if (data === '[DONE]') return line;
          try {
            const row = JSON.parse(data);
            if (!row || typeof row !== 'object' || Array.isArray(row)) return line;
            row.id ??= 'response-test';
            row.created ??= 0;
            row.model ??= 'test-model';
            row.object ??= 'chat.completion.chunk';
            if (row.choices)
              row.choices = row.choices.map((choice: Record<string, unknown>) => ({
                index: 0,
                finish_reason: null,
                delta: {},
                ...choice,
              }));
            if (row.usage) {
              row.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, ...row.usage };
            }
            return `data: ${JSON.stringify(row)}\n`;
          } catch {
            return line;
          }
        });
        controller.enqueue(enc.encode(normalized));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createMockTurnRequest(profile: string, text: string): ProviderCompleteRequest {
  const { generation } = resolveTurn({ profile, input: { text } });
  return {
    model: generation.model,
    apiId: generation.apiId,
    thinking: generation.thinking,
    summaries: undefined,
    maxOutputTokens: generation.maxOutputTokens,
    temperature: generation.temperature,
    builtins: providerBuiltins(defaultKernelScope.tools, generation.builtins),
    system: 'Host system prompt',
    input: generation.input,
    structured: generation.structured,
    image: generation.image,
    keySlot: 'slot_a',
  };
}

function mockStreamChunks(): string[] {
  const t1 = JSON.stringify({
    choices: [{ delta: { reasoning: 'checking ' } }],
  });
  const t2 = JSON.stringify({
    choices: [{ delta: { reasoning: 'database.' } }],
  });
  const c1 = JSON.stringify({ choices: [{ delta: { content: 'hello ' } }] });
  const c2 = JSON.stringify({ choices: [{ delta: { content: 'world.' } }] });
  const tc1 = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"record"}' },
            },
          ],
        },
      },
    ],
  });
  const u = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: EXPECTED_INPUT_TOKENS,
      completion_tokens: EXPECTED_OUTPUT_TOKENS,
      total_tokens: EXPECTED_TOTAL_TOKENS,
    },
  });
  return [
    `data: ${t1}\n\n`,
    `data: ${t2}\n\n`,
    `data: ${c1}\n\n`,
    `data: ${c2}\n\n`,
    `data: ${tc1}\n\n`,
    `data: ${u}\n\n`,
    'data: [DONE]\n\n',
  ];
}

Deno.test('createOpenRouterProvider streams reasoning, text, tools, tokens, and done', async () => {
  const mockSse = mockStreamChunks();
  let fetchCalledWith = '';
  let capturedBody: Record<string, unknown> | undefined;

  const provider = createOpenRouterProvider({
    vault: { slot_a: 'mock-auth-token' },
    fetch: (url, init) => {
      fetchCalledWith = String(url);
      capturedBody = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers as HeadersInit);
      const auth = headers.get('Authorization');
      assertEquals(auth, 'Bearer mock-auth-token');
      return Promise.resolve(sseResponse(mockSse));
    },
  });

  const req = createMockTurnRequest('pinned', 'How often to water?');
  // Stream plumbing only — pinned profile otherwise requests chatTurn JSON.
  req.structured = null;
  req.history = [
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tc_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"plant"}' },
        },
      ],
    },
    { role: 'tool', name: 'lookup', tool_call_id: 'tc_1', content: 'Monstera' },
  ];
  req.wireTools = [
    testWireTool('lookup', {
      description: 'Lookup a plant record',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    }),
  ];
  const events = await Array.fromAsync(provider.complete(req));

  assertEquals(fetchCalledWith, 'https://openrouter.ai/api/v1/chat/completions');

  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length > 0, true);
  const userMessages = messages.filter((m) => m.role === 'user');
  assertEquals(userMessages.length > 0, true);
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  assertEquals(assistantMessages.length > 0, true);
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assertEquals(toolMessages.length > 0, true);

  const thoughts = events
    .filter((e) => e.type === 'thought')
    .map((e) => e.text)
    .join('');
  assertEquals(thoughts, 'checking database.');

  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  assertEquals(text, 'hello world.');

  const toolEvents = eventsOf(events, 'tool');
  assertEquals(toolEvents.length, 1);
  assertEquals(toolEvents[0]?.tool.name, 'lookup');
  assertEquals(toolEvents[0]?.tool.phase === undefined && toolEvents[0].tool.arguments, {
    q: 'record',
  });

  const tokenEvents = eventsOf(events, 'tokens');
  assertEquals(tokenEvents.length, 1);
  assertEquals(tokenEvents[0]?.tokens?.input, EXPECTED_INPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.output, EXPECTED_OUTPUT_TOKENS);
  assertEquals(tokenEvents[0]?.tokens?.total, EXPECTED_TOTAL_TOKENS);
  assertEquals(eventsOf(events, 'done').length, 1);
});

Deno.test('createOpenRouterProvider suppresses thought events when summaries are disabled', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'mock-auth-token' },
    fetch: () => Promise.resolve(sseResponse(mockStreamChunks())),
  });

  const req = createMockTurnRequest('pinned', 'How often to water?');
  req.structured = null;
  req.summaries = 'none';
  const events = await Array.fromAsync(provider.complete(req));

  assertEquals(
    events.some((event) => event.type === 'thought'),
    false,
  );
  assertEquals(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'hello world.',
  );
  assertEquals(eventsOf(events, 'done').length, 1);
});

Deno.test('createOpenRouterProvider preserves citation evidence from provider payloads', async () => {
  const evidencePayload = JSON.stringify({
    provider_metadata: { citations: ['https://example.com/source'] },
    annotations: [{ type: 'url_citation', url: 'https://example.com/source' }],
    choices: [{ delta: { content: 'cited answer' } }],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'mock-auth-token' },
    fetch: () => Promise.resolve(sseResponse([`data: ${evidencePayload}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/source']);
  assertEquals(
    events.some((event) => event.type === 'text' && event.text === 'cited answer'),
    true,
  );
});

Deno.test('createOpenRouterProvider preserves evidence from final choice messages', async () => {
  const finalMessagePayload = JSON.stringify({
    choices: [
      {
        message: {
          content: 'final cited answer',
          providerMetadata: { citations: ['https://example.com/final'] },
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'mock-auth-token' },
    fetch: () =>
      Promise.resolve(sseResponse([`data: ${finalMessagePayload}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(
    provider.complete(createMockTurnRequest('pinned', 'cite final')),
  );
  assertEquals(citedUris(events), ['https://example.com/final']);
});

Deno.test('createOpenRouterProvider handles missing API key, empty stream, thinking delta, site headers, and invalid tool args', async () => {
  const noKeyProvider = createOpenRouterProvider({ vault: { slot_a: '' } });
  const noKeyEvents = await Array.fromAsync(
    noKeyProvider.complete(createMockTurnRequest('pinned', 'x')),
  );
  assertEquals(noKeyEvents.length, 1);
  assertEquals(noKeyEvents[0]?.type, 'error');

  const emptyStreamProvider = createOpenRouterProvider({
    vault: { slot_a: 'mock-key' },
    fetch: () => Promise.resolve(new Response(null, { status: 200 })),
  });
  const emptyStreamEvents = await Array.fromAsync(
    emptyStreamProvider.complete(createMockTurnRequest('pinned', 'x')),
  );
  assertEquals(emptyStreamEvents.length, 1);
  assertEquals(emptyStreamEvents[0]?.type, 'error');

  let capturedHeaders: Headers | undefined;
  const chunkWithThinking = JSON.stringify({
    choices: [{ delta: { thinking: 'deep thought' } }],
  });
  const chunkWithBadTool = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'bad_call',
              function: { name: 'rawFn', arguments: '{invalid_json' },
            },
          ],
        },
      },
    ],
  });
  const chunkWithStructured = JSON.stringify({
    choices: [
      {
        delta: { content: '{"answer": "structured output"}' },
      },
    ],
  });

  const fullStreamProvider = createOpenRouterProvider({
    vault: { slot_a: 'mock-key' },
    siteUrl: 'https://theorem.dev',
    siteName: 'Theorem',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${chunkWithThinking}\n\n`,
          `data: ${chunkWithBadTool}\n\n`,
          `data: ${chunkWithStructured}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const structuredReq = createMockTurnRequest('formatter', 'x');
  structuredReq.wireTools = [
    testWireTool('rawFn', {
      description: 'Raw function probe',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    }),
  ];
  const fullEvents = await Array.fromAsync(fullStreamProvider.complete(structuredReq));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), 'https://theorem.dev');
  assertEquals(capturedHeaders?.get('X-Title'), 'Theorem');

  const thoughtEv = firstOf(fullEvents, 'thought');
  assertEquals(thoughtEv?.text, 'deep thought');

  const toolEv = firstOf(fullEvents, 'tool');
  assertEquals(toolEv, undefined);
  assertEquals(
    fullEvents.some((e) => e.type === 'error'),
    true,
  );
});

Deno.test('createOpenRouterProvider sends response_format for structured requests via SDK', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '{"answer":"ok"}' } }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
  const rf = capturedBody?.response_format as Record<string, unknown> | undefined;
  assertEquals(rf?.type, 'json_schema');
  const jsonSchema = rf?.json_schema as Record<string, unknown>;
  assertEquals(jsonSchema?.name, 'htmlTurn');
  assertEquals(jsonSchema?.strict, true);
  assertEquals(capturedBody?.provider, { require_parameters: true });
});

Deno.test('createOpenRouterProvider passes web_search_options for googleSearch builtin', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'search the web');
  req.builtins = googleBuiltins('googleSearch');
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(
    events.some((e) => e.type === 'text'),
    true,
  );
  assertEquals(capturedBody?.web_search_options !== undefined, true);
  assertEquals(capturedBody?.plugins, undefined);
});

Deno.test('createOpenRouterProvider errors on a builtin with no OpenRouter wire, without calling upstream', async () => {
  let called = false;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => {
      called = true;
      return Promise.resolve(sseResponse(['data: [DONE]\n\n']));
    },
  });

  const req = createMockTurnRequest('pinned', 'find a nursery');
  req.builtins = [{ id: 'liveOnly', wire: { live: 'liveOnly' } }];
  const events = await Array.fromAsync(provider.complete(req));
  const error = firstOf(events, 'error');
  assertEquals(error?.errorInternal?.includes("Builtin 'liveOnly' has no wire.openRouter"), true);
  assertEquals(called, false);
});

Deno.test('createOpenRouterProvider emits tool call events with id, name, and parsed arguments', async () => {
  const toolChunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${toolChunk}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const req = createMockTurnRequest('pinned', 'weather');
  req.wireTools = [
    testWireTool('get_weather', {
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    }),
  ];
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(firstOf(events, 'tool')?.tool, {
    name: 'get_weather',
    callId: 'call_abc',
    arguments: { city: 'NYC' },
  });
});

Deno.test('createOpenRouterProvider extracts evidence from openrouter.provider_metadata.citations', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'answer' } }],
    openrouter: {
      provider_metadata: { citations: ['https://example.com/deep'] },
    },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(
    provider.complete(createMockTurnRequest('pinned', 'cite deep')),
  );
  assertEquals(citedUris(events), ['https://example.com/deep']);
});

Deno.test('createOpenRouterProvider extracts evidence annotations from SSE chunk', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'annotated' } }],
    annotations: [
      {
        type: 'url_citation',
        url_citation: { url: 'https://example.com/ann', title: 'Ann' },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(
    provider.complete(createMockTurnRequest('pinned', 'annotate')),
  );
  assertEquals(eventsOf(events, 'citation'), [
    { type: 'citation', sources: [{ title: 'Ann', uri: 'https://example.com/ann', type: 'web' }] },
  ]);
});

Deno.test('createOpenRouterProvider extracts citations from nested openrouter.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'answer' } }],
    openrouter: {
      citations: ['https://example.com/openrouter-direct'],
    },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/openrouter-direct']);
});

Deno.test('createOpenRouterProvider maps openRouterSettings for non-web plugins', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.builtins = [];
  await Array.fromAsync(provider.complete(req));
  assertEquals(capturedBody?.web_search_options, undefined);
});

Deno.test('createOpenRouterProvider missing key is an auth error', async () => {
  const provider = createOpenRouterProvider({ vault: { slot_a: '   ' } });
  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(events.length, 1);
  assertEquals(firstOf(events, 'error')?.errorKind, 'auth');
});

Deno.test('createOpenRouterProvider without a key slot is an auth error and never calls out', async () => {
  let called = false;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => {
      called = true;
      return Promise.resolve(new Response('unreachable', { status: 500 }));
    },
  });
  const req = createMockTurnRequest('pinned', 'x');
  delete req.keySlot;
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(events.length, 1);
  assertEquals(firstOf(events, 'error')?.errorKind, 'auth');
  assertEquals(called, false);
});

Deno.test('createOpenRouterProvider yields error on HTTP non-200', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(new Response('Forbidden', { status: 403 })),
  });

  const req = createMockTurnRequest('pinned', 'x');
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(events.length, 1);
  assertEquals(firstOf(events, 'error')?.errorKind, 'auth');
});

Deno.test('createOpenRouterProvider reports an unreachable OpenRouter as a network error', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.reject(new TypeError('connection reset')),
  });
  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(
    eventsOf(events, 'error').map((e) => e.errorKind),
    ['network'],
  );
});

Deno.test('createOpenRouterProvider takes a mid-stream error kind from its code', async () => {
  for (const [code, kind] of [
    [502, 'unavailable'],
    [429, 'rate_limit'],
    ['provider_down', 'unavailable'],
  ] as const) {
    const provider = createOpenRouterProvider({
      vault: { slot_a: 'test-key' },
      fetch: () =>
        Promise.resolve(
          sseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'Part' } }] })}\n\n`,
            `data: ${JSON.stringify({ error: { code, message: 'upstream went away' } })}\n\n`,
            'data: [DONE]\n\n',
          ]),
        ),
    });
    const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
    const error = firstOf(events, 'error');
    assertEquals(error?.errorKind, kind);
    assertEquals(error?.errorInternal?.includes('upstream went away'), true);
  }
});

Deno.test('createOpenRouterProvider reports a body that breaks mid-read as a network error', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Part' } }] })}\n\n`),
      );
      controller.error(new TypeError('error reading a body from connection'));
    },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })),
  });
  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(firstOf(events, 'error')?.errorKind, 'network');
});

Deno.test('createOpenRouterProvider reports an unreadable stream chunk as a bad response', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([`data: ${JSON.stringify({ nonsense: true })}\n\n`, 'data: [DONE]\n\n']),
      ),
  });
  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(firstOf(events, 'error')?.errorKind, 'bad_response');
});

Deno.test('createOpenRouterProvider wires tool result history', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'calc', arguments: '{"x":1}' },
        },
      ],
    },
    { role: 'tool', name: 'calc', tool_call_id: 'tc1', content: '42' },
    { role: 'assistant', parts: [{ type: 'text', text: 'summary' }] },
    { role: 'user', content: 'follow-up' },
  ];
  await Array.fromAsync(provider.complete(req));

  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assertEquals(toolMsgs, [{ role: 'tool', tool_call_id: 'tc1', content: '42', name: 'calc' }]);
});

Deno.test('createOpenRouterProvider sends nothing for a tool result without its call id', async () => {
  let sent = false;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => {
      sent = true;
      return Promise.resolve(sseResponse(['data: [DONE]\n\n']));
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [{ role: 'tool', content: 'orphan result' }];
  const events = await Array.fromAsync(provider.complete(req));

  assertEquals(sent, false);
  assertEquals(events.at(-1)?.type, 'error');
});

Deno.test('createOpenRouterProvider emits structured event for valid JSON output', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '{"answer":"42"}' } }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await Array.fromAsync(provider.complete(req));
  const structuredEv = firstOf(events, 'structured');
  assertEquals((structuredEv?.structured as Record<string, unknown>)?.answer, '42');
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
});

Deno.test('createOpenRouterProvider errors when structured output is invalid JSON', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'not valid json' } }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const req = createMockTurnRequest('formatter', 'Design hero card');
  const events = await Array.fromAsync(provider.complete(req));
  assertEquals(
    events.some((e) => e.type === 'structured'),
    false,
  );
  const errorEv = firstOf(events, 'error');
  assertEquals(errorEv?.errorKind, 'bad_response');
  assertEquals(errorEv?.errorInternal, 'structured output was not valid JSON');
  assertEquals(
    events.some((e) => e.type === 'done'),
    false,
  );
});

Deno.test('createOpenRouterProvider cites each URL once across the stream', async () => {
  const cite = (url: string) => ({ type: 'url_citation', url_citation: { url } });
  const chunk1 = JSON.stringify({
    choices: [{ delta: { content: 'first' } }],
    annotations: [cite('https://a.com')],
  });
  const chunk2 = JSON.stringify({
    choices: [{ delta: { content: 'second' } }],
    annotations: [cite('https://a.com'), cite('https://b.com')],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([`data: ${chunk1}\n\n`, `data: ${chunk2}\n\n`, 'data: [DONE]\n\n']),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(
    eventsOf(events, 'citation').map((e) => e.sources.map((source) => source.uri)),
    [['https://a.com'], ['https://b.com']],
  );
});

Deno.test('createOpenRouterProvider emits token counts from finish event', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'count')));
  const tokenEv = firstOf(events, 'tokens');
  assertEquals(tokenEv?.tokens?.input, 10);
  assertEquals(tokenEv?.tokens?.output, 20);
  assertEquals(tokenEv?.tokens?.total, 30);
});

Deno.test('createOpenRouterProvider omits token event when usage is all zeros', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'count')));
  assertEquals(eventsOf(events, 'tokens').length, 0);
});

Deno.test('createOpenRouterProvider emits tokens when only input tokens are nonzero', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'tok')));
  const tokenEv = firstOf(events, 'tokens');
  assertEquals(tokenEv?.tokens?.input, 5);
  assertEquals(tokenEv?.tokens?.output, 0);
  assertEquals(tokenEv?.tokens?.total, 5);
});

Deno.test('createOpenRouterProvider emits tokens when only output tokens are nonzero', async () => {
  const finishChunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 7, total_tokens: 7 },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`,
          `data: ${finishChunk}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'tok')));
  const tokenEv = firstOf(events, 'tokens');
  assertEquals(tokenEv?.tokens?.input, 0);
  assertEquals(tokenEv?.tokens?.output, 7);
  assertEquals(tokenEv?.tokens?.total, 7);
});

Deno.test('createOpenRouterProvider handles empty history and empty input gracefully', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [];
  await Array.fromAsync(provider.complete(req));
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  const userMsgs = messages.filter((m) => m.role === 'user');
  assertEquals(userMsgs.length >= 1, true);
});

Deno.test('createOpenRouterProvider maps history assistant with empty tool_calls as content', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.history = [
    { role: 'assistant', tool_calls: [], content: 'just text' },
    { role: 'user', content: 'ok' },
  ];
  await Array.fromAsync(provider.complete(req));
  const messages = capturedBody?.messages as Array<Record<string, unknown>>;
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  assertEquals(assistantMsgs.length >= 1, true);
  assertEquals(assistantMsgs[0]?.content, 'just text');
});

Deno.test('createOpenRouterProvider extracts citations from providerMetadata.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'cited' } }],
    providerMetadata: { citations: ['https://example.com/pm'] },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/pm']);
});

Deno.test('createOpenRouterProvider extracts choice message providerMetadata evidence', async () => {
  const chunk = JSON.stringify({
    choices: [
      {
        message: {
          content: 'answer',
          provider_metadata: { citations: ['https://example.com/choice-pm'] },
        },
      },
    ],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/choice-pm']);
});

Deno.test('createOpenRouterProvider emits no citation or evidence when no citations or annotations', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'plain text' } }],
    openrouter: { some_field: 'value' },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'plain')));
  assertEquals(
    events.filter((e) => e.type === 'evidence' || e.type === 'citation'),
    [],
  );
});

Deno.test('createOpenRouterProvider wires reasoning effort to provider options', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'think hard');
  req.thinking = 'high';
  await Array.fromAsync(provider.complete(req));

  assertEquals(capturedBody?.reasoning, { effort: 'high' });
});

Deno.test('createOpenRouterProvider does not emit done after error', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => {
      throw new Error('network failure');
    },
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'fail')));
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
  assertEquals(eventsOf(events, 'done').length, 0);
});

Deno.test('createOpenRouterProvider handles openrouter.providerMetadata.citations path', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'deep' } }],
    openrouter: {
      providerMetadata: { citations: ['https://example.com/or-pm'] },
    },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/or-pm']);
});

Deno.test('createOpenRouterProvider extracts openrouter.annotations evidence', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'annotated' } }],
    openrouter: {
      annotations: [
        {
          type: 'url_citation',
          url_citation: { url: 'https://example.com/or-ann' },
        },
      ],
    },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'ann')));
  assertEquals(citedUris(events), ['https://example.com/or-ann']);
});

Deno.test('createOpenRouterProvider passes reasoning delta as thought events', async () => {
  const thinkChunk = JSON.stringify({
    choices: [{ delta: { reasoning: 'step 1' } }],
  });
  const textChunk = JSON.stringify({
    choices: [{ delta: { content: 'result' } }],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([`data: ${thinkChunk}\n\n`, `data: ${textChunk}\n\n`, 'data: [DONE]\n\n']),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'think')));
  const thoughts = eventsOf(events, 'thought');
  assertEquals(thoughts.length >= 1, true);
  assertEquals(
    thoughts.some((t) => t.text === 'step 1'),
    true,
  );
});

Deno.test('createOpenRouterProvider wires only siteUrl header without siteName', async () => {
  let capturedHeaders: Headers | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    siteUrl: 'https://only-url.dev',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), 'https://only-url.dev');
  assertEquals(capturedHeaders?.get('X-Title'), null);
});

Deno.test('createOpenRouterProvider wires only siteName header without siteUrl', async () => {
  let capturedHeaders: Headers | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    siteName: 'OnlyName',
    fetch: (_url, init) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(capturedHeaders?.get('HTTP-Referer'), null);
  assertEquals(capturedHeaders?.get('X-Title'), 'OnlyName');
});

Deno.test('createOpenRouterProvider sends effort none, which turns reasoning off', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'simple');
  req.thinking = 'none';
  req.structured = null;
  await Array.fromAsync(provider.complete(req));
  assertEquals(capturedBody?.reasoning, { effort: 'none' });
});

Deno.test('createOpenRouterProvider emits text from content delta and accumulates for structured', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'part1' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'part2' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'multi')));
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text)
    .join('');
  assertEquals(text, 'part1part2');
});

Deno.test('createOpenRouterProvider treats an empty or whitespace-only vault key as missing', async () => {
  const provider = createOpenRouterProvider({ vault: { slot_a: '' } });
  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'x')));
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
});

Deno.test('createOpenRouterProvider wires tools with additionalProperties schema', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const req = createMockTurnRequest('pinned', 'test');
  req.wireTools = [testWireTool('flexible')];
  await Array.fromAsync(provider.complete(req));
  assertEquals(capturedBody?.tools !== undefined, true);
});

Deno.test('createOpenRouterProvider extracts top-level citations from SSE chunk', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'top' } }],
    citations: ['https://example.com/top-level'],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/top-level']);
});

Deno.test('createOpenRouterProvider ignores non-string items in citation arrays', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'mixed' } }],
    citations: [42, 'https://example.com/valid', null, true],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(citedUris(events), ['https://example.com/valid']);
});

Deno.test('createOpenRouterProvider cites nothing for non-array citation values', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'str' } }],
    citations: 'not-an-array',
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(
    events.filter((e) => e.type === 'evidence' || e.type === 'citation'),
    [],
  );
});

Deno.test('createOpenRouterProvider cites nothing when citation array has only non-strings', async () => {
  const chunk = JSON.stringify({
    choices: [{ delta: { content: 'nums' } }],
    citations: [1, 2, 3],
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () => Promise.resolve(sseResponse([`data: ${chunk}\n\n`, 'data: [DONE]\n\n'])),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'cite')));
  assertEquals(
    events.filter((e) => e.type === 'evidence' || e.type === 'citation'),
    [],
  );
});

Deno.test('createOpenRouterProvider rejects non-object SSE payloads', async () => {
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: "just a string"\n\n',
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'raw')));
  assertEquals(
    events.some((e) => e.type === 'error' && e.errorKind === 'bad_response'),
    true,
  );
});

Deno.test('createOpenRouterProvider does not duplicate token events on multiple finish parts', async () => {
  const finish1 = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const finish2 = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  const provider = createOpenRouterProvider({
    vault: { slot_a: 'test-key' },
    fetch: () =>
      Promise.resolve(
        sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
          `data: ${finish1}\n\n`,
          `data: ${finish2}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
  });

  const events = await Array.fromAsync(provider.complete(createMockTurnRequest('pinned', 'dup')));
  assertEquals(eventsOf(events, 'tokens').length, 1);
});
