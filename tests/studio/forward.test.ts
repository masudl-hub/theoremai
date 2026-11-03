import { assert, assertEquals, assertRejects } from '@std/assert';
import { TheoremError } from '../../mod.ts';
import { forwardedFetch } from '../../studio/forwarded-fetch.ts';
import { createStudioDraftHandler } from '../../studio/server.ts';

const SERVER = 'http://studio.test/api/studio';

type Seen = { url: string; headers: Headers; body: string };

/**
 * Plays the network: the studio's server answers its own address, and `host` answers every other
 * request the server sends on.
 */
async function withNetwork<T>(
  handler: ReturnType<typeof createStudioDraftHandler>,
  host: (seen: Seen, signal: AbortSignal | null | undefined) => Response | Promise<Response>,
  run: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${SERVER}/`)) return handler(new Request(url, init));
    const one = { url, headers: new Headers(init?.headers), body: String(init?.body ?? '') };
    seen.push(one);
    return Promise.resolve(host(one, init?.signal));
  }) as typeof fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("a page's MCP request reaches its host through the studio's server, with the headers a browser's CORS refuses", async () => {
  const handler = createStudioDraftHandler();
  const reply = await withNetwork(
    handler,
    () =>
      new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
      }),
    async (seen) => {
      const response = await forwardedFetch(SERVER)('https://mcp.example.test/mcp', {
        method: 'POST',
        headers: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'web_fetch_exa' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
        redirect: 'manual',
      });
      assertEquals(seen.length, 1);
      assertEquals(seen[0]?.url, 'https://mcp.example.test/mcp');
      assertEquals(seen[0]?.headers.get('mcp-method'), 'tools/call');
      assertEquals(seen[0]?.headers.get('mcp-name'), 'web_fetch_exa');
      assertEquals(seen[0]?.body, '{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
      return response;
    },
  );
  assertEquals(reply.status, 200);
  assertEquals(reply.headers.get('mcp-session-id'), 'sess-1');
  assertEquals(await reply.json(), { jsonrpc: '2.0', id: 1, result: {} });
});

Deno.test('a redirect comes back to the page unfollowed, for its kernel to check', async () => {
  const reply = await withNetwork(
    createStudioDraftHandler(),
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
    () => forwardedFetch(SERVER)('https://mcp.example.test/mcp', { method: 'GET' }),
  );
  assertEquals(reply.status, 302);
  assertEquals(reply.headers.get('location'), 'https://elsewhere.test/');
});

Deno.test("a hosted studio's server refuses a name that points inward, and the page reads why", async () => {
  const handler = createStudioDraftHandler({
    resolveHost: (name) => Promise.resolve(name === 'inward.example.test' ? ['10.0.0.7'] : []),
  });
  const error = await withNetwork(
    handler,
    () => new Response('reached'),
    async (seen) => {
      const refused = await assertRejects(() =>
        forwardedFetch(SERVER)('https://inward.example.test/mcp', { method: 'POST' }),
      );
      assertEquals(seen.length, 0);
      return refused;
    },
  );
  assert(error instanceof TheoremError);
  assertEquals(error.kind, 'blocked');
});

Deno.test('a local address goes straight from the page, not through the server', async () => {
  let toServer = 0;
  const reply = await withNetwork(
    createStudioDraftHandler(),
    () => new Response('local'),
    async (seen) => {
      const original = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith(SERVER)) toServer++;
        return original(input, init);
      }) as typeof fetch;
      try {
        const answered = await forwardedFetch(SERVER)('http://127.0.0.1:8931/mcp', {});
        assertEquals(
          seen.map((each) => each.url),
          ['http://127.0.0.1:8931/mcp'],
        );
        return answered;
      } finally {
        globalThis.fetch = original;
      }
    },
  );
  assertEquals(toServer, 0);
  assertEquals(await reply.text(), 'local');
});

Deno.test("the page's abort reaches the host's request", async () => {
  const stop = new AbortController();
  let hostAborted = false;
  await withNetwork(
    createStudioDraftHandler(),
    (_seen, signal) =>
      new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () => {
          hostAborted = true;
          reject(signal.reason);
        });
        stop.abort();
      }),
    async () => {
      await assertRejects(() =>
        forwardedFetch(SERVER)('https://mcp.example.test/mcp', { signal: stop.signal }),
      );
    },
  );
  assert(hostAborted);
});

Deno.test('the forward route logs nothing of a request: not its headers, not its body', async () => {
  const secret = 'sk-forward-secret-7Q';
  const said: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const kept = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      said.push(
        args
          .map((arg) => (typeof arg === 'string' ? arg : Deno.inspect(arg, { depth: 8 })))
          .join(' '),
      );
    };
  }
  try {
    const send = (fails: boolean) =>
      withNetwork(
        createStudioDraftHandler(),
        () => (fails ? Promise.reject(new Error('host down')) : new Response('ok')),
        () =>
          forwardedFetch(SERVER)('https://mcp.example.test/mcp', {
            method: 'POST',
            headers: { authorization: `Bearer ${secret}` },
            body: JSON.stringify({ key: secret }),
          }),
      );
    assertEquals(await (await send(false)).text(), 'ok');
    await assertRejects(() => send(true));
  } finally {
    methods.forEach((name, at) => {
      console[name] = kept[at] as (typeof console)[typeof name];
    });
  }
  assert(!said.some((line) => line.includes(secret)), said.join('\n'));
});
