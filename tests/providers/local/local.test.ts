import { assertEquals, assertThrows } from '../../../src/kernel/engine/assert.ts';
import type { ProviderCompleteRequest, TurnHistoryMessage } from '../../../src/kernel/types.ts';
import {
  createLocalProvider,
  flushPending,
  historyToWire,
  resolveBaseUrl,
  toolsToWire,
} from '../../../src/providers/local/local.ts';
import { eventsOf, firstOf, rawCallsOf, toolEventsOf } from '../../fixtures/events.ts';
import { testWireTool } from '../../fixtures/wire-tools.ts';

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function baseReq(overrides: Partial<ProviderCompleteRequest> = {}): ProviderCompleteRequest {
  return {
    model: 'local-model',
    apiId: 'llama3.2',
    thinking: 'none',
    summaries: undefined,
    maxOutputTokens: 256,
    temperature: 0.2,
    builtins: [],
    system: 'Be brief.',
    input: [{ type: 'text', text: 'Hello' }],
    structured: null,
    image: null,
    ...overrides,
  };
}

Deno.test('resolveBaseUrl has no default address', () => {
  assertThrows(() => resolveBaseUrl({ baseUrl: '  ' }), Error, 'Local provider requires baseUrl');
  assertEquals(resolveBaseUrl({ baseUrl: 'http://localhost:8080/' }), 'http://localhost:8080');
  assertEquals(resolveBaseUrl({ baseUrl: '  http://10.0.0.2:1234  ' }), 'http://10.0.0.2:1234');
});

Deno.test('resolveBaseUrl does not read OLLAMA_HOST', () => {
  const prev = Deno.env.get('OLLAMA_HOST');
  try {
    Deno.env.set('OLLAMA_HOST', 'http://env-should-not-win:9999');
    assertEquals(resolveBaseUrl({ baseUrl: 'http://explicit:11434' }), 'http://explicit:11434');
  } finally {
    if (prev === undefined) Deno.env.delete('OLLAMA_HOST');
    else Deno.env.set('OLLAMA_HOST', prev);
  }
});

Deno.test('historyToWire maps history parts including images', () => {
  const msgs = historyToWire(
    baseReq({
      history: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', data: 'abc' },
          ],
        } satisfies TurnHistoryMessage,
        { role: 'assistant', content: 'nice' },
      ],
      input: [{ type: 'text', text: 'again' }],
    }),
  );
  assertEquals(msgs[0], { role: 'system', content: 'Be brief.' });
  assertEquals(msgs[1].role, 'user');
  assertEquals(Array.isArray(msgs[1].content), true);
  const parts = msgs[1].content as Array<Record<string, unknown>>;
  assertEquals(parts[0], { type: 'text', text: 'look' });
  assertEquals(parts[1]?.type, 'image_url');
  const imageUrl = parts[1]?.image_url as { url?: string } | undefined;
  assertEquals(imageUrl?.url, 'data:image/png;base64,abc');
  assertEquals(msgs[2], { role: 'assistant', content: 'nice' });
  assertEquals(msgs[3], { role: 'user', content: 'again' });
});

Deno.test('historyToWire preserves tool call exchanges', () => {
  const msgs = historyToWire(
    baseReq({
      history: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":1}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'lookup',
          content: '{"ok":true}',
        },
      ],
      input: [{ type: 'text', text: 'next' }],
    }),
  );
  assertEquals(
    (msgs[1].tool_calls as Array<{ function: { name: string } }> | undefined)?.[0].function.name,
    'lookup',
  );
  assertEquals(msgs[2], {
    role: 'tool',
    tool_call_id: 'call_1',
    name: 'lookup',
    content: '{"ok":true}',
  });
});

Deno.test('toolsToWire maps dynamic tools only', () => {
  assertEquals(toolsToWire(undefined), undefined);
  assertEquals(toolsToWire([]), undefined);
  assertEquals(
    toolsToWire([
      {
        type: 'function',
        name: 'ping',
        description: 'Ping',
        parameters: { type: 'object', properties: {} },
      },
    ]),
    [
      {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Ping',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  );
});

Deno.test('createLocalProvider streams text, tokens, and completed stop', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        sseResponse([
          'data: {"id":"chatcmpl-1","model":"llama3.2","choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5},"choices":[]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    },
  });

  const events = await Array.fromAsync(provider.complete(baseReq()));
  assertEquals(calls[0].url, 'http://local.test/v1/chat/completions');
  assertEquals(calls[0].body.model, 'llama3.2');
  assertEquals(calls[0].body.stream, true);
  assertEquals(
    eventsOf(events, 'text').map((e) => e.text),
    ['Hi', '!'],
  );
  assertEquals(firstOf(events, 'tokens')?.tokens, {
    input: 3,
    output: 2,
    total: 5,
  });
  const done = firstOf(events, 'done');
  assertEquals(done?.stop?.kind, 'completed');
  assertEquals(done?.stop?.native, 'stop');
  assertEquals(
    eventsOf(events, 'response').map((e) => e.response),
    [{ id: 'chatcmpl-1', model: 'llama3.2' }],
  );
});

Deno.test('createLocalProvider maps finish_reason length and tool_calls', async () => {
  const lengthProvider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const lengthEvents = await Array.fromAsync(lengthProvider.complete(baseReq()));
  assertEquals(firstOf(lengthEvents, 'done')?.stop?.kind, 'length');

  const toolProvider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ping","arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const toolEvents = await Array.fromAsync(
    toolProvider.complete(
      baseReq({
        wireTools: [testWireTool('ping')],
      }),
    ),
  );
  assertEquals(rawCallsOf(toolEvents), [{ name: 'ping', callId: 'c1', arguments: { x: 1 } }]);
  assertEquals(firstOf(toolEvents, 'done')?.stop?.kind, 'tool');
});

Deno.test('flushPending emits malformed_arguments on bad tool JSON', () => {
  const pending = new Map<number, { id: string; name: string; args: string }>([
    [0, { id: 'c1', name: 'ping', args: '{not-json' }],
    [1, { id: 'c2', name: 'ok', args: '{"x":1}' }],
    [2, { id: 'c3', name: 'empty', args: '' }],
  ]);
  const events = flushPending(pending);
  assertEquals(rawCallsOf(events), [
    { name: 'ping', callId: 'c1', arguments: {} },
    { name: 'ok', callId: 'c2', arguments: { x: 1 } },
    { name: 'empty', callId: 'c3', arguments: {} },
  ]);
  assertEquals(
    toolEventsOf(events, 'error').map((e) => [e.callId, e.failure.code, e.failure.kind]),
    [['c1', 'malformed_arguments', 'bad_response']],
  );
  assertEquals(pending.size, 0);
});

Deno.test('createLocalProvider yields error event on HTTP failure, with the whole body', async () => {
  const body = `${'overloaded\n'.repeat(100)}retry later`;
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: () => Promise.resolve(new Response(body, { status: 503 })),
  });
  const events = await Array.fromAsync(provider.complete(baseReq()));
  assertEquals(events.length, 1);
  const [error] = eventsOf(events, 'error');
  assertEquals(error?.errorInternal?.endsWith(`LLM HTTP 503: ${body}`), true);
});

Deno.test('createLocalProvider reads finish_reason when delta is absent', async () => {
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: () =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
  });
  const events = await Array.fromAsync(provider.complete(baseReq()));
  assertEquals(firstOf(events, 'done')?.stop?.kind, 'completed');
});

Deno.test('a buffered local turn asks for one JSON reply and emits what a stream would', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createLocalProvider({
    baseUrl: 'http://local.test',
    fetch: (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        Response.json({
          id: 'chatcmpl-1',
          model: 'llama3.2',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'checking',
                tool_calls: [{ id: 'call_1', function: { name: 'ping', arguments: '{"n":1}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    },
  });
  const events = await Array.fromAsync(provider.complete(baseReq({ stream: false })));
  assertEquals(bodies[0]?.stream, false);
  assertEquals('stream_options' in (bodies[0] ?? {}), false);
  assertEquals(
    eventsOf(events, 'response').map((e) => e.response),
    [{ id: 'chatcmpl-1', model: 'llama3.2' }],
  );
  assertEquals(firstOf(events, 'tokens')?.tokens, { input: 3, output: 2, total: 5 });
  assertEquals(
    eventsOf(events, 'text').map((e) => e.text),
    ['checking'],
  );
  assertEquals(firstOf(events, 'tool')?.tool, {
    name: 'ping',
    callId: 'call_1',
    arguments: { n: 1 },
  });
  assertEquals(firstOf(events, 'done')?.stop?.native, 'tool_calls');
});
