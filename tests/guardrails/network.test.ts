import { assertSafeUrl } from '../../src/guardrails/network.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';

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
