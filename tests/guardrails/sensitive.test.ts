import {
  TEST_AWS_KEY,
  TEST_GOOGLE_KEY,
  TEST_OPENAI_KEY,
  TEST_SSN,
  TEST_VISA,
} from '../../src/guardrails/corpus/secrets.ts';
import { sensitiveSpans } from '../../src/guardrails/sensitive.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('sensitiveSpans detects SSN and API keys from corpus secrets', () => {
  assertEquals(sensitiveSpans(`SSN: ${TEST_SSN}`).length > 0, true);
  assertEquals(sensitiveSpans(`key ${TEST_OPENAI_KEY}`).length > 0, true);
  assertEquals(sensitiveSpans(`AWS ${TEST_AWS_KEY}`).length > 0, true);
});

Deno.test('sensitiveSpans skips network addresses when network is off', () => {
  const text = 'host 10.0.0.1 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334';
  assertEquals(sensitiveSpans(text).length, 2);
  assertEquals(sensitiveSpans(text, { network: false }).length, 0);
  assertEquals(sensitiveSpans(`key ${TEST_OPENAI_KEY}`, { network: false }).length > 0, true);
});

Deno.test('sensitiveSpans detects Luhn-valid card numbers', () => {
  assertEquals(sensitiveSpans(`Card: ${TEST_VISA}`).length > 0, true);
});

Deno.test('sensitiveSpans ignores benign prose', () => {
  assertEquals(sensitiveSpans('Please summarize the quarterly report.').length, 0);
});

Deno.test('sensitiveSpans detects spaced and dashed card formats', () => {
  assertEquals(sensitiveSpans('4111 1111 1111 1111').length > 0, true);
  assertEquals(sensitiveSpans('4111.1111.1111.1111').length > 0, true);
});

Deno.test('sensitiveSpans detects all credential pattern types', () => {
  const samples: Array<[string, string]> = [
    ['itin', '912-34-5678'],
    ['ein', '12-3456789'],
    ['iban', 'DE89370400440532013000'],
    ['ipv6', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'],
    ['github-pat', 'github_pat_11AAAAAAA_1234567890123456789012345'],
    ['github-token', 'ghp_q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aEu0Xo'],
    ['slack', 'xoxb-123456789012-1234567890123-abcde'],
    ['bearer', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEo\n-----END RSA PRIVATE KEY-----'],
    ['anthropic', `sk-ant-api03-${'x'.repeat(24)}`],
    ['openrouter', `sk-or-${'x'.repeat(25)}`],
    ['openai', `sk-${'x'.repeat(24)}`],
    ['google', TEST_GOOGLE_KEY],
    ['aws', TEST_AWS_KEY],
    ['ipv4', '10.0.0.1'],
    ['ssn', '078-05-1120'],
    ['ssn-contextual', 'SSN: 123456789'],
  ];
  for (const [, value] of samples) {
    const spans = sensitiveSpans(value);
    assertEquals(spans.length > 0, true);
  }
});

Deno.test("sensitiveSpans finds the vendor keys and the key assignments gitleaks' rules find", () => {
  const body = 'q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aEu0Xo';
  for (const value of [
    'token=abc123def456ghi',
    `Token: ${btoa('user:password')}`,
    ['sk', 'live', body.slice(0, 24)].join('_'),
    ['glpat', body.slice(0, 20)].join('-'),
    ['npm', body].join('_'),
  ]) {
    assertEquals([value, sensitiveSpans(`see ${value} `).length > 0], [value, true]);
  }
  for (const value of [
    'the api key: is something you get from the dashboard',
    'token = getTokenFromRequest',
    'public_key = q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aE',
    `Payload: ${btoa('user:password')}`,
  ]) {
    assertEquals([value, sensitiveSpans(value)], [value, []]);
  }
});

Deno.test('a key assignment is redacted at its value, the name left to read', () => {
  const value = 'q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aE';
  const text = `api_key = "${value}"`;
  assertEquals(sensitiveSpans(text), [
    { start: text.indexOf(value), end: text.indexOf(value) + value.length, kind: 'sensitive' },
  ]);
});

Deno.test('sensitiveSpans rejects Luhn-invalid card numbers', () => {
  assertEquals(sensitiveSpans('4111111111111112').length, 0);
});

Deno.test('sensitiveSpans detects multiple cards in a single string', () => {
  assertEquals(sensitiveSpans('4111111111111111 and 5500005555555559').length, 2);
});

Deno.test('sensitiveSpans ignores digit sequences below minimum card length', () => {
  assertEquals(sensitiveSpans('411111111111').length, 0);
});

Deno.test('sensitiveSpans ignores digit sequences above maximum card length', () => {
  // 20 digits — over CARD_MAX_DIGITS = 19; kills the <= vs < boundary mutation
  assertEquals(sensitiveSpans('41111111111111111120').length, 0);
});

Deno.test('sensitiveSpans detects 19-digit card at exact upper boundary', () => {
  // 4111111111111111102 is Luhn-valid (sum=30) and exactly 19 digits; kills <= vs < mutation
  assertEquals(sensitiveSpans('4111111111111111102').length > 0, true);
});

Deno.test('sensitiveSpans detects card where Luhn doubling exceeds 9 and subtracts 9', () => {
  // 5500005555555559: positions with 5 doubled = 10 → 10-9 = 1; exercises n -= LUHN_NINE
  assertEquals(sensitiveSpans('5500005555555559').length > 0, true);
});

Deno.test('sensitiveSpans detects SSN_CONTEXTUAL with double space between social and security', () => {
  assertEquals(sensitiveSpans('social  security: 123456789').length > 0, true);
});

Deno.test('sensitiveSpans detects SSN_CONTEXTUAL without the word number', () => {
  assertEquals(sensitiveSpans('social security: 123456789').length > 0, true);
});

Deno.test('sensitiveSpans detects SSN_CONTEXTUAL with double space before number', () => {
  assertEquals(sensitiveSpans('social security  number: 123456789').length > 0, true);
});

Deno.test('sensitiveSpans detects SSN_CONTEXTUAL with dash-separated digits', () => {
  assertEquals(sensitiveSpans('SSN: 1-2-3-4-5-6-7-8-9').length > 0, true);
});

Deno.test('sensitiveSpans detects SSN_CONTEXTUAL with space-separated digits', () => {
  assertEquals(sensitiveSpans('SSN: 1 2 3 4 5 6 7 8 9').length > 0, true);
});

Deno.test('sensitiveSpans does not detect SSN_CONTEXTUAL with only 8 digits', () => {
  assertEquals(sensitiveSpans('social security: 12345678').length, 0);
});

Deno.test('sensitiveSpans does not detect ITIN with only 1 area digit (91-xx-xxxx format)', () => {
  assertEquals(sensitiveSpans('91-34-5678').length, 0);
});

Deno.test('sensitiveSpans does not detect ITIN with only 1 middle digit (912-3-xxxx format)', () => {
  assertEquals(sensitiveSpans('912-3-5678').length, 0);
});

Deno.test('sensitiveSpans does not detect ITIN with only 1 final digit (912-34-5 format)', () => {
  assertEquals(sensitiveSpans('912-34-5').length, 0);
});

Deno.test('sensitiveSpans does not detect IBAN-like with letter in check digits position', () => {
  assertEquals(sensitiveSpans('DE8ABC0440532013000').length, 0);
});

Deno.test('sensitiveSpans does not detect IPV6 with only 1 colon-separated group', () => {
  assertEquals(sensitiveSpans('2001:safe-text-here').length, 0);
});

Deno.test('sensitiveSpans detects BEARER with double space after Bearer keyword', () => {
  assertEquals(sensitiveSpans('Bearer  eyJhbGciOiJIUzI1NiJ9.payload').length > 0, true);
});

Deno.test('sensitiveSpans detects full multi-word BEARER token body', () => {
  assertEquals(sensitiveSpans('Bearer  eyJhbGciOiJIUzI1NiJ9.payload.sig').length > 0, true);
});

Deno.test('sensitiveSpans detects PEM without RSA prefix', () => {
  assertEquals(
    sensitiveSpans('-----BEGIN PRIVATE KEY-----\nMIIEvg\n-----END PRIVATE KEY-----').length > 0,
    true,
  );
});

Deno.test('sensitiveSpans detects PEM without RSA on END line', () => {
  assertEquals(
    sensitiveSpans('-----BEGIN RSA PRIVATE KEY-----\nMIIEvg\n-----END PRIVATE KEY-----').length > 0,
    true,
  );
});

Deno.test('sensitiveSpans kind is sensitive not empty string', () => {
  const spans = sensitiveSpans('078-05-1120');
  assertEquals(spans.length > 0, true);
  assertEquals(spans[0]?.kind, 'sensitive');
});

Deno.test('sensitiveSpans does not detect OPENAI key with non-whitespace between sk- and body', () => {
  // A key with leading junk between sk- and the alphanumeric body is not a valid key
  assertEquals(sensitiveSpans('sk-$$$$$$$$$$$$$$$$$$$$$$$$$').length, 0);
});

Deno.test('cardSpans does not flag a 12-digit Luhn-valid number (below CARD_MIN_DIGITS)', () => {
  // 4111111111111 is 13 digits (minimum), 411111111111 is 12 (below minimum)
  assertEquals(sensitiveSpans('411111111111').length, 0);
});

Deno.test('cardSpans if (found) vs if (true) mutation: null match should not be processed', () => {
  assertEquals(sensitiveSpans('1234').length, 0);
});

Deno.test('sensitiveSpans detects IPV4 address with 250-255 octets', () => {
  assertEquals(sensitiveSpans('addr: 255.0.0.255').length > 0, true);
  assertEquals(sensitiveSpans('server: 250.251.252.253').length > 0, true);
});

Deno.test('sensitiveSpans detects IPV4 address with 200-249 octets', () => {
  assertEquals(sensitiveSpans('host: 200.1.2.3').length > 0, true);
  assertEquals(sensitiveSpans('ip: 240.10.20.30').length > 0, true);
});

Deno.test('sensitiveSpans detects IPV4 address with 100-199 three-digit first octet', () => {
  assertEquals(sensitiveSpans('host: 123.45.67.89').length > 0, true);
  assertEquals(sensitiveSpans('ip: 192.168.1.1').length > 0, true);
});

Deno.test('sensitiveSpans detects IPV4 address with 200-249 in the last octet', () => {
  assertEquals(sensitiveSpans('ip: 10.0.0.200').length > 0, true);
});

Deno.test('sensitiveSpans does not detect IPV6 address with only two colon groups', () => {
  // "0db8" is valid hex so the mutated pattern (?:[0-9a-f]{1,4}:)[0-9a-f]{1,4} matches
  assertEquals(sensitiveSpans('x: 2001:0db8 end').length === 0, true);
});

Deno.test('sensitiveSpans detects a 13-digit card, the shortest a network issues', () => {
  assertEquals(sensitiveSpans('4222222222222').length > 0, true);
});

Deno.test('sensitiveSpans leaves a Luhn-valid number no card network issues', () => {
  assertEquals(sensitiveSpans('0000000000000').length, 0);
  assertEquals(sensitiveSpans('1234567890123452').length, 0);
  // Mastercard issues 16 digits only.
  assertEquals(sensitiveSpans('55000055555555554').length, 0);
});

Deno.test('sensitiveSpans leaves the digits of a web address: a Maps place id is not a card', () => {
  const placeId = '4111111111111111102';
  assertEquals(sensitiveSpans(placeId).length > 0, true);
  assertEquals(sensitiveSpans(`https://maps.google.com/?cid=${placeId}`).length, 0);
  assertEquals(
    sensitiveSpans(`See https://www.google.com/maps/place/x/data=!3m1!1s0x0:${placeId}.`).length,
    0,
  );
});

Deno.test('sensitiveSpans still finds a card written after a web address', () => {
  assertEquals(sensitiveSpans('Paid at https://shop.example/pay with 4111111111111111').length, 1);
  assertEquals(sensitiveSpans('https://shop.example/pay\n4111 1111 1111 1111').length, 1);
});

Deno.test('cardSpans span kind is sensitive not empty string', () => {
  const spans = sensitiveSpans('4111111111111111');
  assertEquals(spans.length > 0, true);
  assertEquals(spans[0]?.kind, 'sensitive');
});

Deno.test('sensitiveSpans finds IPv6 in every RFC 4291 text form', () => {
  for (const address of [
    '2001:db8::1',
    '::1',
    'fe80::1',
    '2001:db8::',
    '::ffff:192.168.1.1',
    '64:ff9b::192.0.2.33',
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  ]) {
    const text = `host ${address} up`;
    const found = sensitiveSpans(text).map((s) => text.slice(s.start, s.end));
    assertEquals({ address, found: found.includes(address) }, { address, found: true });
  }
});

Deno.test('sensitiveSpans leaves colon text that is not an address', () => {
  for (const text of ['std::vector', 'at 10:00::done', '12:30', '00:1a:2b:3c:4d:5e', 'see ::']) {
    assertEquals({ text, spans: sensitiveSpans(text) }, { text, spans: [] });
  }
});

Deno.test('sensitiveSpans finds every PEM private key kind', () => {
  for (const kind of ['', 'RSA ', 'DSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ']) {
    const pem = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIEvg\n-----END ${kind}PRIVATE KEY-----`;
    assertEquals({ kind, found: sensitiveSpans(pem).length > 0 }, { kind, found: true });
  }
  const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOY\n-----END PGP PRIVATE KEY BLOCK-----';
  assertEquals(sensitiveSpans(pgp).length > 0, true);
});
