import {
  assertSafeUrl,
  dnsOverHttpsResolver,
  fetchGuarded,
  type ResolveHost,
} from '../../src/guardrails/network.ts';
import { assertEquals, assertRejects, assertThrows } from '../../src/kernel/engine/assert.ts';

Deno.test('assertSafeUrl allows public https urls by default', () => {
  const url = assertSafeUrl('https://api.github.com/repos/theoremai/agents');
  assertEquals(url.hostname, 'api.github.com');
  assertEquals(url.protocol, 'https:');
});

Deno.test('assertSafeUrl blocks non-https schemes by default', () => {
  assertThrows(
    () => assertSafeUrl('http://api.github.com/repos'),
    Error,
    'URL scheme "http:" is not permitted',
  );
  assertThrows(
    () => assertSafeUrl('ftp://example.com'),
    Error,
    'URL scheme "ftp:" is not permitted',
  );
  assertThrows(
    () => assertSafeUrl('file:///etc/passwd'),
    Error,
    'URL scheme "file:" is not permitted',
  );
});

Deno.test('assertSafeUrl blocks localhost and loopback by default', () => {
  assertThrows(
    () => assertSafeUrl('https://localhost:8080/mcp'),
    Error,
    'Access to loopback target "localhost" blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://127.0.0.1:3000/sse'),
    Error,
    'Access to loopback target "127.0.0.1" blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://sub.localhost:3000'),
    Error,
    'Access to loopback target "sub.localhost" blocked',
  );
});

Deno.test('assertSafeUrl blocks private RFC 1918 and link-local IPv4 by default', () => {
  // 10.0.0.0/8
  assertThrows(
    () => assertSafeUrl('https://10.0.1.5:8080/tool'),
    Error,
    'Access to private IPv4 address "10.0.1.5" blocked',
  );
  // 172.16.0.0/12
  assertThrows(
    () => assertSafeUrl('https://172.20.0.1/mcp'),
    Error,
    'Access to private IPv4 address "172.20.0.1" blocked',
  );
  // 192.168.0.0/16
  assertThrows(
    () => assertSafeUrl('https://192.168.1.100/api'),
    Error,
    'Access to private IPv4 address "192.168.1.100" blocked',
  );
  // 169.254.169.254 (Cloud metadata)
  assertThrows(
    () => assertSafeUrl('https://169.254.169.254/latest/meta-data'),
    Error,
    'Access to private IPv4 address "169.254.169.254" blocked',
  );
});

Deno.test('assertSafeUrl blocks private IPv6 by default', () => {
  assertThrows(
    () => assertSafeUrl('https://[::1]:8080/mcp'),
    Error,
    'Access to loopback target "[::1]" blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://[fc00::1]/mcp'),
    Error,
    'Access to private IPv6 address "[fc00::1]" blocked',
  );
  // IPv4-mapped IPv6
  assertThrows(
    () => assertSafeUrl('https://[::ffff:127.0.0.1]:8080/mcp'),
    Error,
    'Access to private IPv6 address',
  );
  assertThrows(
    () => assertSafeUrl('https://[::ffff:169.254.169.254]/latest'),
    Error,
    'Access to private IPv6 address',
  );
  // NAT64 prefix
  assertThrows(
    () => assertSafeUrl('https://[64:ff9b::127.0.0.1]:8080/mcp'),
    Error,
    'Access to private IPv6 address',
  );
  // Link-local IPv6
  assertThrows(
    () => assertSafeUrl('https://[fe80::1]/mcp'),
    Error,
    'Access to private IPv6 address',
  );
});

Deno.test('assertSafeUrl blocks evasion techniques and private domains', () => {
  // Trailing dot localhost
  assertThrows(
    () => assertSafeUrl('https://localhost.:8080/mcp'),
    Error,
    'Access to loopback target "localhost." blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://foo.localhost.:8080/mcp'),
    Error,
    'Access to loopback target "foo.localhost." blocked',
  );
  // Private TLDs
  assertThrows(
    () => assertSafeUrl('https://service.internal:8080/mcp'),
    Error,
    'Access to loopback target "service.internal" blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://printer.local/api'),
    Error,
    'Access to loopback target "printer.local" blocked',
  );
  // Carrier-grade NAT (100.64.0.0/10)
  assertThrows(
    () => assertSafeUrl('https://100.64.0.1:8080/mcp'),
    Error,
    'Access to private IPv4 address "100.64.0.1" blocked',
  );
});

Deno.test('assertSafeUrl allows localhost and http when allowPrivateNetworks is true', () => {
  const url1 = assertSafeUrl('http://localhost:3000/mcp', { allowPrivateNetworks: true });
  assertEquals(url1.hostname, 'localhost');
  assertEquals(url1.protocol, 'http:');

  const url2 = assertSafeUrl('http://127.0.0.1:8000/sse', { allowPrivateNetworks: true });
  assertEquals(url2.hostname, '127.0.0.1');

  const url3 = assertSafeUrl('http://192.168.1.50:4000', { allowPrivateNetworks: true });
  assertEquals(url3.hostname, '192.168.1.50');
});

Deno.test('assertSafeUrl respects explicit allowedHosts whitelist', () => {
  const url = assertSafeUrl('http://localhost:3000/mcp', {
    allowedHosts: ['localhost'],
    allowedSchemes: ['http', 'https'],
  });
  assertEquals(url.hostname, 'localhost');
});

Deno.test('an allowed host is exempt from the address checks, never from the scheme', () => {
  const policy = { allowedHosts: ['localhost'] };
  assertEquals(assertSafeUrl('https://localhost/mcp', policy).hostname, 'localhost');
  assertThrows(() => assertSafeUrl('http://localhost/mcp', policy), Error, 'not permitted');
  assertThrows(() => assertSafeUrl('file://localhost/etc/passwd', policy), Error, 'not permitted');
});

function hopFetch(hops: Record<string, Response>) {
  const seen: { url: string; method: string; body: unknown; contentType: string | null }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      contentType: new Headers(init?.headers).get('content-type'),
    });
    return Promise.resolve(hops[url]?.clone() ?? new Response('done'));
  }) as typeof fetch;
  return { fetchFn, seen };
}

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { Location: location } });

Deno.test('fetchGuarded rewrites methods the way the Fetch standard does', async () => {
  const { fetchFn, seen } = hopFetch({
    'https://a.example.com/1': redirect(307, '/2'),
    'https://a.example.com/2': redirect(303, '/3'),
  });
  await fetchGuarded(
    'https://a.example.com/1',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    { followRedirects: true, fetchFn },
  );
  assertEquals(
    seen.map(({ url, method, body, contentType }) => [url, method, body, contentType]),
    [
      ['https://a.example.com/1', 'POST', '{}', 'application/json'],
      ['https://a.example.com/2', 'POST', '{}', 'application/json'],
      ['https://a.example.com/3', 'GET', undefined, null],
    ],
  );
});

Deno.test('fetchGuarded hands a redirect back when not following, and stops a loop', async () => {
  const once = hopFetch({ 'https://a.example.com/1': redirect(302, 'https://evil.example.com') });
  const response = await fetchGuarded(
    'https://a.example.com/1',
    { headers: {} },
    { followRedirects: false, fetchFn: once.fetchFn },
  );
  assertEquals(response.status, 302);
  assertEquals(once.seen.length, 1);

  const loop = hopFetch({ 'https://a.example.com/loop': redirect(302, '/loop') });
  await assertRejects(
    () =>
      fetchGuarded(
        'https://a.example.com/loop',
        { headers: {} },
        { followRedirects: true, fetchFn: loop.fetchFn },
      ),
    Error,
    'Too many redirects',
  );
  assertEquals(loop.seen.length, 21);
});

const zone =
  (records: Record<string, string[]>): ResolveHost =>
  (hostname) =>
    Promise.resolve(records[hostname] ?? []);

Deno.test('fetchGuarded refuses a name that resolves inward, on the target and on a redirect', async () => {
  const resolveHost = zone({
    'a.example.com': ['93.184.216.34'],
    'inward.example.com': ['93.184.216.35', '169.254.169.254'],
  });
  const direct = hopFetch({});
  await assertRejects(
    () =>
      fetchGuarded(
        'https://inward.example.com/',
        { headers: {} },
        { followRedirects: true, resolveHost, fetchFn: direct.fetchFn },
      ),
    Error,
    'resolves to private address "169.254.169.254"',
  );
  assertEquals(direct.seen.length, 0);

  const hop = hopFetch({ 'https://a.example.com/1': redirect(302, 'https://inward.example.com/') });
  await assertRejects(
    () =>
      fetchGuarded(
        'https://a.example.com/1',
        { headers: {} },
        { followRedirects: true, resolveHost, fetchFn: hop.fetchFn },
      ),
    Error,
    'resolves to private address',
  );
  assertEquals(hop.seen.length, 1);
});

Deno.test('fetchGuarded refuses a name that does not resolve', async () => {
  const { fetchFn, seen } = hopFetch({});
  await assertRejects(
    () =>
      fetchGuarded(
        'https://missing.example.com/',
        { headers: {} },
        { followRedirects: false, resolveHost: zone({}), fetchFn },
      ),
    Error,
    'did not resolve',
  );
  assertEquals(seen.length, 0);
});

Deno.test('fetchGuarded skips the lookup for literals and hosts the policy lets inward', async () => {
  const asked: string[] = [];
  const resolveHost: ResolveHost = (hostname) => {
    asked.push(hostname);
    return Promise.resolve(['10.0.0.1']);
  };
  const { fetchFn } = hopFetch({});
  await fetchGuarded(
    'https://93.184.216.34/',
    { headers: {} },
    { followRedirects: false, resolveHost, fetchFn },
  );
  await fetchGuarded(
    'https://wiki.corp.example.com/',
    { headers: {} },
    {
      followRedirects: false,
      policy: { allowedHosts: ['Wiki.Corp.Example.com'] },
      resolveHost,
      fetchFn,
    },
  );
  await fetchGuarded(
    'https://wiki.corp.example.com/',
    { headers: {} },
    { followRedirects: false, policy: { allowPrivateNetworks: true }, resolveHost, fetchFn },
  );
  assertEquals(asked, []);
});

Deno.test('dnsOverHttpsResolver returns A and AAAA answers and treats NXDOMAIN as none', async () => {
  const asked: string[] = [];
  const fetchFn = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.searchParams.get('name')} ${url.searchParams.get('type')}`);
    const name = url.searchParams.get('name');
    const type = Number(url.searchParams.get('type'));
    const body =
      name === 'missing.example.com'
        ? { Status: 3 }
        : {
            Status: 0,
            Answer: [
              { type: 5, data: 'edge.example.net.' },
              type === 1 ? { type: 1, data: '93.184.216.34' } : { type: 28, data: 'fd00::1' },
            ],
          };
    return Promise.resolve(Response.json(body));
  }) as typeof fetch;
  const resolve = dnsOverHttpsResolver({ endpoint: 'https://dns.example.com/dns-query', fetchFn });
  assertEquals(await resolve('a.example.com'), ['93.184.216.34', 'fd00::1']);
  assertEquals(await resolve('missing.example.com'), []);
  assertEquals(asked, [
    'a.example.com 1',
    'a.example.com 28',
    'missing.example.com 1',
    'missing.example.com 28',
  ]);
  const failing = dnsOverHttpsResolver({
    endpoint: 'https://dns.example.com/dns-query',
    fetchFn: (() => Promise.resolve(Response.json({ Status: 2 }))) as typeof fetch,
  });
  await assertRejects(() => failing('a.example.com'), Error, 'status 2');
});
