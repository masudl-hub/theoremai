import {
  dnsOverHttpsResolver,
  fetchGuarded,
  isPrivateOrLocalAddress,
  type ResolveHost,
} from '../../src/guardrails/network.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

interface Hop {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

function recorder(hops: Record<string, Response>) {
  const seen: Hop[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(hops[url]?.clone() ?? new Response('done'));
  }) as typeof fetch;
  return { fetchFn, seen };
}

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { Location: location } });

const TOKEN = { authorization: 'Bearer secret' };

Deno.test('origin-bound headers go out on the first request and same-origin hops only', async () => {
  const { fetchFn, seen } = recorder({
    'https://a.example.com/1': redirect(302, '/2'),
    'https://a.example.com/2': redirect(302, 'https://b.example.com/3'),
    'https://b.example.com/3': redirect(302, 'https://a.example.com/4'),
  });
  await fetchGuarded(
    'https://a.example.com/1',
    { headers: { accept: 'text/plain' } },
    { followRedirects: true, originBoundHeaders: TOKEN, fetchFn },
  );
  assertEquals(
    seen.map((hop) => [hop.url, hop.headers.get('authorization'), hop.headers.get('accept')]),
    [
      ['https://a.example.com/1', 'Bearer secret', 'text/plain'],
      ['https://a.example.com/2', 'Bearer secret', 'text/plain'],
      ['https://b.example.com/3', null, 'text/plain'],
      // Back on the first origin, but the credentials already left it once.
      ['https://a.example.com/4', null, 'text/plain'],
    ],
  );
});

Deno.test('a request without origin-bound headers sends only its own', async () => {
  const { fetchFn, seen } = recorder({});
  await fetchGuarded(
    'https://a.example.com/',
    { headers: { accept: 'text/plain' } },
    { followRedirects: true, fetchFn },
  );
  assertEquals([...(seen[0]?.headers.keys() ?? [])], ['accept']);
});

Deno.test('a redirect without a Location comes back as the response', async () => {
  const { fetchFn, seen } = recorder({
    'https://a.example.com/': new Response(null, { status: 302 }),
  });
  const response = await fetchGuarded(
    'https://a.example.com/',
    { headers: {} },
    { followRedirects: true, fetchFn },
  );
  assertEquals(response.status, 302);
  assertEquals(seen.length, 1);
});

Deno.test('each redirect status rewrites only the methods the Fetch standard says it does', async () => {
  const cases: [number, string, string, boolean][] = [
    // status, method in, method out, body kept
    [301, 'POST', 'GET', false],
    [302, 'POST', 'GET', false],
    [303, 'POST', 'GET', false],
    [303, 'PUT', 'GET', false],
    [303, 'GET', 'GET', false],
    [303, 'HEAD', 'HEAD', true],
    [301, 'PUT', 'PUT', true],
    [302, 'PATCH', 'PATCH', true],
    [301, 'DELETE', 'DELETE', true],
    [307, 'POST', 'POST', true],
    [308, 'POST', 'POST', true],
  ];
  for (const [status, methodIn, methodOut, bodyKept] of cases) {
    const { fetchFn, seen } = recorder({ 'https://a.example.com/1': redirect(status, '/2') });
    await fetchGuarded(
      'https://a.example.com/1',
      { method: methodIn, headers: { 'content-type': 'text/plain' }, body: 'payload' },
      { followRedirects: true, fetchFn },
    );
    const label = `${status} ${methodIn}`;
    check(seen[1]?.method, methodOut, label);
    check(seen[1]?.body, bodyKept ? 'payload' : undefined, label);
    check(seen[1]?.headers.get('content-type'), bodyKept ? 'text/plain' : null, label);
  }
});

Deno.test('a status that is not a redirect is returned even with a Location', async () => {
  for (const status of [200, 300, 304, 305, 306, 309]) {
    const { fetchFn, seen } = recorder({
      'https://a.example.com/': new Response(null, { status, headers: { Location: '/next' } }),
    });
    const response = await fetchGuarded(
      'https://a.example.com/',
      { headers: {} },
      { followRedirects: true, fetchFn },
    );
    assertEquals(response.status, status);
    check(seen.length, 1, String(status));
  }
});

Deno.test('the host lookup is skipped for a policy host, an IPv6 literal, and any listed host among several', async () => {
  const asked: string[] = [];
  const resolveHost: ResolveHost = (hostname) => {
    asked.push(hostname);
    return Promise.resolve(['10.0.0.1']);
  };
  const { fetchFn } = recorder({});
  await fetchGuarded(
    'https://a.example.com/',
    { headers: {} },
    {
      followRedirects: false,
      policy: { allowedHosts: ['b.example.com', 'a.example.com'] },
      resolveHost,
      fetchFn,
    },
  );
  await fetchGuarded(
    'https://[2606:4700::1111]/',
    { headers: {} },
    { followRedirects: false, resolveHost, fetchFn },
  );
  assertEquals(asked, []);
});

Deno.test("the host lookup runs, with the caller's signal, under a policy that lists no hosts", async () => {
  const seen: { hostname: string; signal: AbortSignal | undefined }[] = [];
  const resolveHost: ResolveHost = (hostname, signal) => {
    seen.push({ hostname, signal });
    return Promise.resolve(['93.184.216.34']);
  };
  const { fetchFn } = recorder({});
  const controller = new AbortController();
  await fetchGuarded(
    'https://a.example.com/',
    { headers: {}, signal: controller.signal },
    { followRedirects: false, policy: { allowedSchemes: ['https'] }, resolveHost, fetchFn },
  );
  await fetchGuarded(
    'https://b.example.com/',
    { headers: {} },
    { followRedirects: false, resolveHost, fetchFn },
  );
  assertEquals(seen[0]?.hostname, 'a.example.com');
  assertEquals(seen[0]?.signal, controller.signal);
  assertEquals(seen[1]?.hostname, 'b.example.com');
  assertEquals(seen[1]?.signal, undefined);
});

Deno.test('a host that looks like an IPv4 address at its start only is still looked up', async () => {
  const asked: string[] = [];
  const resolveHost: ResolveHost = (hostname) => {
    asked.push(hostname);
    return Promise.resolve(['93.184.216.34']);
  };
  const { fetchFn } = recorder({});
  await fetchGuarded(
    'https://1.2.3.4.example.com/',
    { headers: {} },
    { followRedirects: false, resolveHost, fetchFn },
  );
  assertEquals(asked, ['1.2.3.4.example.com']);
});

Deno.test('a bracketed or part-bracketed address is judged by its address', () => {
  assertEquals(isPrivateOrLocalAddress('[fe80::1]'), true);
  assertEquals(isPrivateOrLocalAddress('[fe80::1'), false);
  assertEquals(isPrivateOrLocalAddress('fe80::1]'), false);
});

Deno.test('dnsOverHttpsResolver asks for DNS JSON, carries the signal, and keeps only matching answers', async () => {
  const requests: { url: string; accept: string | null; signal: AbortSignal | null }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      accept: new Headers(init?.headers).get('accept'),
      signal: init?.signal ?? null,
    });
    return Promise.resolve(
      Response.json({
        Status: 0,
        Answer: [
          { type: 1, data: '93.184.216.34' },
          { type: 1 },
          { type: 1, data: 7 },
          { type: 28, data: 'fd00::1' },
        ],
      }),
    );
  }) as typeof fetch;
  const controller = new AbortController();
  const resolve = dnsOverHttpsResolver({ endpoint: 'https://dns.example.com/q', fetchFn });
  assertEquals(await resolve('a.example.com', controller.signal), ['93.184.216.34', 'fd00::1']);
  assertEquals(requests.length, 2);
  for (const request of requests) {
    assertEquals(request.accept, 'application/dns-json');
    assertEquals(request.signal, controller.signal);
  }
  await resolve('a.example.com');
  assertEquals(requests[2]?.signal, null);
});

Deno.test('dnsOverHttpsResolver treats a NOERROR with no answers as none, and an HTTP failure as an error', async () => {
  const empty = dnsOverHttpsResolver({
    endpoint: 'https://dns.example.com/q',
    fetchFn: (() => Promise.resolve(Response.json({ Status: 0 }))) as typeof fetch,
  });
  assertEquals(await empty('a.example.com'), []);
  const down = dnsOverHttpsResolver({
    endpoint: 'https://dns.example.com/q',
    fetchFn: (() =>
      Promise.resolve(
        new Response('{"Status":0,"Answer":[{"type":1,"data":"1.2.3.4"}]}', { status: 503 }),
      )) as typeof fetch,
  });
  await assertRejects(
    () => down('a.example.com'),
    Error,
    'DNS lookup for "a.example.com" failed: HTTP 503',
  );
});
