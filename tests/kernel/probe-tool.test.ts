import { assert, assertEquals } from '@std/assert';
import { probeTool, type ToolProbe } from '../../src/kernel/tools/probe.ts';

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

/** A fetch that answers with `answer` and keeps what each request sent. */
function service(answer: (sent: Sent, init?: RequestInit) => Response | Promise<Response>): {
  sent: Sent[];
  fetch: typeof fetch;
} {
  const sent: Sent[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const one = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    sent.push(one);
    return Promise.resolve(answer(one, init));
  };
  return { sent, fetch: fetchFn as typeof fetch };
}

const KEY = 'sk-station-123';
const station = { type: 'http', endpoint: 'https://api.station.example/v1/devices' } as const;
const keyAuth = { type: 'api_key', headerName: 'X-Station-Key' } as const;
const verdictOf = (probe: ToolProbe) =>
  probe.verdict === 'inconclusive' || probe.verdict === 'unanswered'
    ? `${probe.verdict}:${probe.reason}`
    : probe.verdict;

Deno.test('a key the service takes is accepted, sent where the tool puts it, and never echoed back', async () => {
  const { sent, fetch } = service(
    () => new Response(`{"echo":"${KEY}"}`, { headers: { 'content-type': 'application/json' } }),
  );
  const probe = await probeTool({ target: station, auth: keyAuth, credential: KEY, fetch });
  assertEquals(probe.verdict, 'accepted');
  assertEquals(sent[0].headers.get('x-station-key'), KEY);
  assertEquals(sent[0].headers.get('accept'), 'application/json');
  assert(probe.verdict === 'accepted' && !probe.answer.body.includes(KEY));
});

Deno.test('a key in the query goes where the tool puts it', async () => {
  const { sent, fetch } = service(() => new Response('{}'));
  await probeTool({
    target: station,
    auth: { type: 'api_key', queryParam: 'key' },
    credential: KEY,
    fetch,
  });
  assertEquals(new URL(sent[0].url).searchParams.get('key'), KEY);
});

Deno.test('401 and 403 refuse a sent credential; without one, or for 402 and 500, the answer says nothing about it', async () => {
  const answering = (status: number) => service(() => new Response('no', { status })).fetch;
  const withKey = (status: number) =>
    probeTool({ target: station, auth: keyAuth, credential: KEY, fetch: answering(status) });
  assertEquals(verdictOf(await withKey(401)), 'refused');
  assertEquals(verdictOf(await withKey(403)), 'refused');
  assertEquals(verdictOf(await withKey(402)), 'inconclusive:status');
  assertEquals(verdictOf(await withKey(500)), 'inconclusive:status');
  const keyless = await probeTool({ target: station, fetch: answering(401) });
  assertEquals(verdictOf(keyless), 'inconclusive:status');
  assert(keyless.verdict === 'inconclusive' && keyless.answer?.status === 401);
});

Deno.test('a redirect is followed as a call follows it, and the key stays with the first origin', async () => {
  const { sent, fetch } = service((one) =>
    one.url.startsWith('https://api.station.example')
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/devices' } })
      : new Response('[]'),
  );
  const probe = await probeTool({ target: station, auth: keyAuth, credential: KEY, fetch });
  assertEquals(probe.verdict, 'accepted');
  assertEquals(sent.length, 2);
  assertEquals(sent[1].headers.get('x-station-key'), null);
});

Deno.test('no answer: a blocked address, a bad mapping, a bad server URL, a timeout, a failed request', async () => {
  const never = service(
    (_one, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  ).fetch;
  const failing = (() => Promise.reject(new TypeError('connection reset'))) as typeof fetch;
  const results = [
    await probeTool({ target: { type: 'http', endpoint: 'http://127.0.0.1:9/' } }),
    await probeTool({
      target: {
        ...station,
        endpoint: 'https://api.station.example/devices/{id}',
        mapping: { pathParams: ['id'] },
      },
    }),
    await probeTool({ target: { type: 'mcp', serverUrl: 'nope' } }),
    await probeTool({ target: station, fetch: never, timeoutMs: 10 }),
    await probeTool({ target: station, fetch: failing }),
  ];
  assertEquals(results.map(verdictOf), [
    'unanswered:blocked',
    'unanswered:invalid_mapping',
    'unanswered:invalid_url',
    'unanswered:timeout',
    'unanswered:network',
  ]);
});

Deno.test("a body past maxResponseBytes is too large; without it, there's no limit", async () => {
  const big = service(() => new Response('x'.repeat(5_000))).fetch;
  assertEquals(
    verdictOf(await probeTool({ target: station, fetch: big, maxResponseBytes: 100 })),
    'inconclusive:too_large',
  );
  assertEquals(verdictOf(await probeTool({ target: station, fetch: big })), 'accepted');
});

const mcp = { type: 'mcp', serverUrl: 'https://mcp.example.com/mcp' } as const;
const rpc = (result: unknown, init?: ResponseInit) =>
  Response.json({ jsonrpc: '2.0', id: 'probe', ...(result as object) }, init);

Deno.test('an MCP server is asked for its tool list as a call would ask, and names its tools', async () => {
  const { sent, fetch } = service(() => rpc({ result: { tools: [{ name: 'search_docs' }] } }));
  const probe = await probeTool({ target: mcp, credential: KEY, fetch });
  assertEquals(sent[0].body.method, 'tools/list');
  assertEquals(sent[0].headers.get('authorization'), `Bearer ${KEY}`);
  assertEquals(sent[0].headers.get('mcp-name'), null);
  assert(probe.verdict === 'accepted' && probe.mcp !== undefined);
  assertEquals(probe.mcp.tools, ['search_docs']);
  assert(probe.mcp.protocolVersion.length > 0);
});

Deno.test('an MCP server refuses, errs, or is not MCP', async () => {
  const answering = (response: () => Response) => service(response).fetch;
  const outcomes = [
    await probeTool({
      target: mcp,
      credential: KEY,
      fetch: answering(() => new Response('no', { status: 401 })),
    }),
    await probeTool({
      target: mcp,
      fetch: answering(() => rpc({ error: { code: -32601, message: 'nope' } })),
    }),
    await probeTool({ target: mcp, fetch: answering(() => rpc({ result: { hello: 1 } })) }),
    await probeTool({ target: mcp, fetch: answering(() => new Response('<html>')) }),
  ];
  assertEquals(outcomes.map(verdictOf), [
    'refused',
    'inconclusive:mcp_error',
    'inconclusive:not_mcp',
    'inconclusive:not_json',
  ]);
});

Deno.test('an MCP server that needs a session gets one, as a call does', async () => {
  const { sent, fetch } = service((one) => {
    if (one.body.method === 'initialize') {
      return Response.json(
        { jsonrpc: '2.0', id: 'initialize', result: { protocolVersion: '2025-11-25' } },
        { headers: { 'Mcp-Session-Id': 'sess-1' } },
      );
    }
    if (one.body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (!one.headers.get('mcp-session-id')) {
      return rpc(
        { error: { code: -32000, message: 'Mcp-Session-Id header is required' } },
        { status: 400 },
      );
    }
    return rpc({ result: { tools: [{ name: 'a' }, { name: 'b' }] } });
  });
  const probe = await probeTool({ target: mcp, fetch });
  assert(probe.verdict === 'accepted');
  assertEquals(probe.mcp, { protocolVersion: '2025-11-25', tools: ['a', 'b'] });
  assertEquals(sent.at(-1)?.headers.get('mcp-session-id'), 'sess-1');
});
