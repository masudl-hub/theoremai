import {
  assertSafeUrl,
  isLocalhostName,
  isPrivateOrLocalAddress,
} from '../../src/guardrails/network.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';

/** Names the case that failed; `assertEquals` takes only the two values. */
function check(actual: unknown, expected: unknown, label: string): void {
  assertEquals({ label, value: actual }, { label, value: expected });
}

/** Each range is probed on both of its edges and one address beyond each, so a shifted or widened bound shows. */
const IPV4_BLOCKED = [
  '0.0.0.0',
  '0.255.255.255',
  '127.0.0.1',
  '127.255.255.255',
  '10.0.0.0',
  '10.255.255.255',
  '100.64.0.0',
  '100.127.255.255',
  '172.16.0.0',
  '172.31.255.255',
  '192.168.0.0',
  '192.168.255.255',
  '169.254.0.0',
  '169.254.255.255',
  '192.0.0.0',
  '192.0.0.255',
  '192.0.2.0',
  '192.0.2.255',
  '198.18.0.0',
  '198.19.255.255',
  '198.51.100.0',
  '198.51.100.255',
  '203.0.113.0',
  '203.0.113.255',
  '224.0.0.0',
  '239.255.255.255',
  '240.0.0.0',
  '255.255.255.255',
];

const IPV4_ALLOWED = [
  '1.0.0.0',
  '8.8.8.8',
  '126.255.255.255',
  '128.0.0.0',
  '9.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '99.64.0.0',
  '101.64.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '171.16.0.0',
  '173.16.0.0',
  '192.167.255.255',
  '192.169.0.0',
  '191.168.0.1',
  '193.168.0.1',
  '169.253.255.255',
  '169.255.0.0',
  '168.254.0.1',
  '170.254.0.1',
  '192.0.1.1',
  '192.0.3.1',
  '192.1.0.1',
  '191.0.0.1',
  '193.0.0.1',
  '198.17.255.255',
  '198.20.0.0',
  '197.18.0.1',
  '199.18.0.1',
  '198.51.99.255',
  '198.51.101.0',
  '198.50.100.1',
  '198.52.100.1',
  '197.51.100.1',
  '199.51.100.1',
  '203.0.112.255',
  '203.0.114.0',
  '203.1.113.1',
  '202.0.113.1',
  '204.0.113.1',
  '223.255.255.255',
];

Deno.test('every private, shared, reserved and multicast IPv4 range is refused edge to edge', () => {
  for (const ip of IPV4_BLOCKED) check(isPrivateOrLocalAddress(ip), true, ip);
});

Deno.test('addresses just outside those IPv4 ranges are allowed', () => {
  for (const ip of IPV4_ALLOWED) check(isPrivateOrLocalAddress(ip), false, ip);
});

Deno.test('a malformed IPv4 address is not judged private', () => {
  for (const ip of [
    '10.0.0',
    '10.0.0.1.5',
    '10.0.0.256',
    '10.0.256.1',
    '10.256.0.1',
    '256.0.0.1',
    '10.0.0.-1',
    '10.0.-1.1',
    '10.-1.0.1',
    '-1.0.0.1',
    '10.a.0.1',
    '10.0.0.x',
    '',
  ]) {
    check(isPrivateOrLocalAddress(ip), false, ip);
  }
});

const IPV6_BLOCKED = [
  '::',
  '0:0:0:0:0:0:0:0',
  '::1',
  '0:0:0:0:0:0:0:1',
  '[::1]',
  'fe80::1',
  'febf::1',
  'fec0::1',
  'feff::1',
  'fc00::1',
  'fdff::1',
  'ff00::1',
  'ff02::1',
  '2001:db8::1',
  '2001:0db8:ffff::1',
  '100::1',
  '100:0:0:0:1::',
  '64:ff9b:1::1',
  '2001::1',
  '::ffff:10.0.0.1',
  '::ffff:0:10.0.0.1',
  '::10.0.0.1',
  '64:ff9b::10.0.0.1',
  '2002:0a00:0001::',
  '2002:c0a8:0101::',
  'FE80::1',
  ' fe80::1 ',
  'fe80:2:3:4:5:6::8',
  'fe80:2:3:4:5:6:7:8',
];

const IPV6_ALLOWED = [
  '2606:4700::1111',
  '1::1',
  '1:2:3:4:5:6:7:8',
  'fe7f::1',
  'fe00::1',
  'fbff::1',
  '2001:db9::1',
  '2001:db7::1',
  '2001:1::1',
  '2000::1',
  '101::1',
  '100:1::',
  '100:0:1::',
  '100:0:0:1::1',
  '64:ff9b:2::1',
  '64:ff9a:1::1',
  '65:ff9b:1::1',
  '::ffff:8.8.8.8',
  '::ffff:0:8.8.8.8',
  '::8.8.8.8',
  '64:ff9b::8.8.8.8',
  '2002:0808:0808::',
  '2003:0a00:0001::',
  '1::ffff:10.0.0.1',
  '0:0:0:1:0:ffff:10.0.0.1',
  '::fffe:10.0.0.1',
  '::ffff:1:10.0.0.1',
  '0:0:0:1:ffff:0:10.0.0.1',
  '64:ff9b:0:1::10.0.0.1',
  '2602:0a00:0001::',
  '[::1',
];

Deno.test('every private, local and tunnelling IPv6 range is refused, and embedded IPv4 is judged', () => {
  for (const ip of IPV6_BLOCKED) check(isPrivateOrLocalAddress(ip), true, ip);
});

Deno.test('IPv6 addresses just outside those ranges are allowed', () => {
  for (const ip of IPV6_ALLOWED) check(isPrivateOrLocalAddress(ip), false, ip);
});

Deno.test('a malformed IPv6 address is not judged private', () => {
  for (const ip of [
    '::1::2',
    'fe80:2:3:4:5:6:7::8',
    'fe80:2:3:4:5:6:7',
    'fe80:2:3:4:5:6:7:8:9',
    'fe80::g',
    '12345::1',
    '::10.0.0.256',
    '::10.0.0',
    '::10.0.0.1.1',
    '::10.0.0.-1',
  ]) {
    check(isPrivateOrLocalAddress(ip), false, ip);
  }
});

Deno.test('local names are matched on the whole label, with or without trailing dots', () => {
  for (const name of [
    'localhost',
    'app.localhost',
    'LOCALHOST',
    'localhost.',
    'localhost..',
    'local',
    'printer.local',
    'internal',
    'db.internal',
    'lan',
    'nas.lan',
    'home.arpa',
    'tv.home.arpa',
    'localdomain',
    'host.localdomain',
    '127.0.0.1',
    '::1',
    '[::1]',
  ]) {
    check(isLocalhostName(name), true, name);
  }
  for (const name of [
    'example.com',
    'localhost.com',
    'notlocalhost',
    'mylocal',
    'myinternal',
    'wlan',
    'arpa',
    'xhome.arpa',
    'mylocaldomain',
    '127.0.0.2',
    '',
  ]) {
    check(isLocalhostName(name), false, name);
  }
});

Deno.test('assertSafeUrl reads allowedSchemes with or without the colon, in any case', () => {
  assertEquals(
    assertSafeUrl('http://example.com/', { allowedSchemes: ['http'] }).protocol,
    'http:',
  );
  assertEquals(
    assertSafeUrl('http://example.com/', { allowedSchemes: ['HTTP:'] }).protocol,
    'http:',
  );
  assertThrows(
    () => assertSafeUrl('https://example.com/', { allowedSchemes: ['http'] }),
    Error,
    'URL scheme "https:" is not permitted by network policy. Allowed: http:',
  );
});

Deno.test('assertSafeUrl allows http and https, and nothing else, once private networks are allowed', () => {
  assertEquals(
    assertSafeUrl('http://10.0.0.1/', { allowPrivateNetworks: true }).hostname,
    '10.0.0.1',
  );
  assertEquals(
    assertSafeUrl('https://10.0.0.1/', { allowPrivateNetworks: true }).hostname,
    '10.0.0.1',
  );
  assertThrows(
    () => assertSafeUrl('ftp://10.0.0.1/', { allowPrivateNetworks: true }),
    Error,
    'Allowed: http:, https:',
  );
  assertThrows(() => assertSafeUrl('http://example.com/'), Error, 'Allowed: https:');
});

Deno.test('assertSafeUrl matches allowedHosts case-insensitively and exactly', () => {
  assertEquals(
    assertSafeUrl('https://LOCALHOST/', { allowedHosts: ['LocalHost'] }).hostname,
    'localhost',
  );
  assertThrows(
    () => assertSafeUrl('https://localhost/', { allowedHosts: ['localhost.example'] }),
    Error,
    'loopback target "localhost" blocked',
  );
  assertThrows(
    () => assertSafeUrl('https://[fe80::1]/'),
    Error,
    'private IPv6 address "[fe80::1]" blocked',
  );
  assertThrows(() => assertSafeUrl('not a url'), Error, 'Invalid URL provided: "not a url"');
});

Deno.test('assertSafeUrl names an unparseable URL', () => {
  assertThrows(() => assertSafeUrl('https://'), Error, 'Invalid URL provided: "https://"');
});
