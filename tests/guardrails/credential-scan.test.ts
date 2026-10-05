import { assertEquals } from '@std/assert';
import {
  type CredentialAllowlist,
  type CredentialRule,
  credentialHit,
  credentialSpans,
  shannonEntropy,
} from '../../src/guardrails/credential-scan.ts';
import { resolveEgressChecks } from '../../src/guardrails/egress.ts';
import { createEgressStream } from '../../src/guardrails/egress-stream.ts';
import { sensitiveSpans } from '../../src/guardrails/sensitive.ts';

const NONE: CredentialAllowlist = { target: 'secret', regexes: [], stopwords: [] };

function rule(over: Partial<CredentialRule> & Pick<CredentialRule, 'pattern'>): CredentialRule {
  return { id: 'r', keywords: [], allowlists: [], ...over };
}

function found(text: string, credential: CredentialRule, global = NONE): string[] {
  return credentialSpans(text, [credential], global).map(({ start, end }) =>
    text.slice(start, end),
  );
}

/** Whether the bundled egress stream stops `text`, fed a character at a time. */
function streamBlocks(text: string): boolean {
  const stream = createEgressStream({ checks: resolveEgressChecks({}) });
  return [...text].some((char) => stream.push(char) !== undefined);
}

const AWS_KEY = ['AKIA', 'T4GZ2WQX6KJ3NB7V'].join('');
const SECRET = 'q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aE';
const GITHUB_TOKEN = ['ghp_', 'q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aEu0Xo'].join('');

Deno.test('shannonEntropy is the bits per character of a string', () => {
  assertEquals(shannonEntropy(''), 0);
  assertEquals(shannonEntropy('aaaa'), 0);
  assertEquals(shannonEntropy('abab'), 1);
  assertEquals(shannonEntropy('abcd'), 2);
});

Deno.test('the secret is the secret group, else the first non-empty group, else the match', () => {
  assertEquals(found('k=abc;', rule({ pattern: /k=(x)?([a-c]+);/ })), ['abc']);
  assertEquals(found('k=abc;', rule({ pattern: /(k)=([a-c]+);/, secretGroup: 2 })), ['abc']);
  assertEquals(found('k=abc;', rule({ pattern: /k=[a-c]+;/ })), ['k=abc;']);
  assertEquals(found('k=abc;', rule({ pattern: /k=(x)?[a-c]+;/ })), ['k=abc;']);
});

Deno.test('a secret at or under the entropy floor is let through', () => {
  const pattern = /key=(\w+)/;
  assertEquals(found('key=abab', rule({ pattern, entropy: 1 })), []);
  assertEquals(found('key=abab', rule({ pattern, entropy: 0.99 })), ['abab']);
  assertEquals(found('key=abcd', rule({ pattern, entropy: 1 })), ['abcd']);
});

Deno.test('a rule runs only on text holding one of its keywords, case aside', () => {
  const pattern = /\d{4}/;
  assertEquals(found('PIN 1234', rule({ pattern, keywords: ['pin'] })), ['1234']);
  assertEquals(found('code 1234', rule({ pattern, keywords: ['pin'] })), []);
  assertEquals(found('code 1234', rule({ pattern })), ['1234']);
  assertEquals(
    credentialHit(rule({ pattern, keywords: ['pin'] }), NONE, '1234', 'code 1234', 5),
    false,
  );
  assertEquals(
    credentialHit(rule({ pattern, keywords: ['pin'] }), NONE, '1234', 'Pin 1234', 4),
    true,
  );
});

Deno.test('a keyword after the match does not count, streamed or whole', () => {
  const pattern = /\d{4}/;
  const late = rule({ pattern, keywords: ['pin'] });
  assertEquals(found('1234 is the pin', late), []);
  assertEquals(credentialHit(late, NONE, '1234', '1234 is the pin', 0), false);
  assertEquals(found('pin1234', late), ['1234']);
  assertEquals(found('1234pin 5678', late), ['5678']);
});

Deno.test('an allowlist reads the secret, the match or the line, and stopwords read the secret', () => {
  const pattern = /key=(\w+)/;
  const text = 'first\nexample key=abcd here\nlast key=wxyz';
  const lets = (list: Partial<CredentialAllowlist>) =>
    found(text, rule({ pattern, allowlists: [{ ...NONE, ...list }] }));
  assertEquals(lets({}), ['abcd', 'wxyz']);
  assertEquals(lets({ regexes: [/^abcd$/] }), ['wxyz']);
  assertEquals(lets({ regexes: [/^key=abcd$/] }), ['abcd', 'wxyz']);
  assertEquals(lets({ target: 'match', regexes: [/^key=abcd$/] }), ['wxyz']);
  assertEquals(lets({ target: 'line', regexes: [/^example key=abcd here$/] }), ['wxyz']);
  assertEquals(lets({ target: 'line', regexes: [/first|last/] }), ['abcd']);
  assertEquals(lets({ stopwords: ['bc'] }), ['wxyz']);
  assertEquals(
    found('key=ABCD', rule({ pattern, allowlists: [{ ...NONE, stopwords: ['bc'] }] })),
    [],
  );
  assertEquals(found(text, rule({ pattern }), { ...NONE, regexes: [/^wxyz$/] }), ['abcd']);
});

Deno.test('newlines around a match are not part of it', () => {
  const text = 'a\n\nkey\n\nb';
  assertEquals(found(text, rule({ pattern: /\n+key\n+/ })), ['key']);
  assertEquals(
    found(
      text,
      rule({ pattern: /\n+key\n+/, allowlists: [{ ...NONE, target: 'line', regexes: [/^key$/] }] }),
    ),
    [],
  );
});

Deno.test('a gitleaks:allow comment does not let a secret through', () => {
  assertEquals(sensitiveSpans(`${AWS_KEY} # gitleaks:allow`).length, 1);
});

Deno.test('a credential is redacted as its secret, not the words around it', () => {
  const text = `aws_access_key_id = "${AWS_KEY}"`;
  const spans = sensitiveSpans(text, { ids: false, financial: false, network: false });
  assertEquals(
    spans.every(({ start, end }) => text.slice(start, end) === AWS_KEY),
    true,
  );
  assertEquals(spans.length > 0, true);
  assertEquals(sensitiveSpans(text, { credentials: false }), []);
});

Deno.test('words about credentials are not credentials, whole or streamed', () => {
  const benign = [
    'Adjust headers as needed for your API (Bearer token, custom header, etc.)',
    ['curl -sS -H "Authorization: Bearer $', '{API_KEY}" "$', '{API_URL}"'].join(''),
    'export API_KEY="your-secret-key-here"',
    'The apiId is "gemini-3.5-flash-lite" and the token limit is 4096.',
    'AKIAIOSFODNN7EXAMPLE is the key in the AWS documentation.',
    'Set password: ******** and keep the secret safe.',
  ];
  for (const text of benign) {
    assertEquals({ text, spans: sensitiveSpans(text) }, { text, spans: [] });
    assertEquals({ text, blocked: streamBlocks(text) }, { text, blocked: false });
  }
});

Deno.test('a credential is found whole and streamed', () => {
  const leaks = [
    `The key is ${AWS_KEY}. Keep it safe.`,
    `Use ${GITHUB_TOKEN} to push your work.`,
    `Authorization: Bearer ${SECRET} is the header.`,
    `client_secret = "${SECRET}" in the file.`,
  ];
  for (const text of leaks) {
    assertEquals({ text, found: sensitiveSpans(text).length > 0 }, { text, found: true });
    assertEquals({ text, blocked: streamBlocks(text) }, { text, blocked: true });
  }
});
