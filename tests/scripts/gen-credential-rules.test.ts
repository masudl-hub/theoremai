import { assertEquals, assertThrows } from '@std/assert';
import { gitleaksRules, goRegex } from '../../scripts/gen-credential-rules.ts';
import { CREDENTIAL_RULES, GLOBAL_ALLOWLIST } from '../../src/guardrails/credential-rules.ts';
import type { CredentialAllowlist, CredentialRule } from '../../src/guardrails/credential-scan.ts';

function allowlistData(list: CredentialAllowlist) {
  return { ...list, regexes: list.regexes.map(String) };
}

function ruleData(rule: CredentialRule) {
  return {
    ...rule,
    pattern: String(rule.pattern),
    allowlists: rule.allowlists.map(allowlistData),
  };
}

Deno.test("credential-rules.ts is what the generator writes from gitleaks' rules now", async () => {
  const fresh = await gitleaksRules();
  assertEquals(allowlistData(GLOBAL_ALLOWLIST), allowlistData(fresh.global));
  assertEquals(CREDENTIAL_RULES.map(ruleData), fresh.rules.map(ruleData));
});

Deno.test('no generated rule needs a file path, and each has a pattern that runs', () => {
  assertEquals(CREDENTIAL_RULES.length, 217);
  for (const { id, pattern } of CREDENTIAL_RULES) {
    assertEquals({ id, matchesEmpty: pattern.test('') }, { id, matchesEmpty: false });
  }
  assertEquals(
    CREDENTIAL_RULES.some(({ id }) => id === 'pkcs12-file' || id === 'nuget-config-password'),
    false,
  );
});

Deno.test('a Go pattern ignoring case throughout takes the i flag', () => {
  assertEquals(String(goRegex('(?i)abc[d-f]')), '/abc[d-f]/i');
});

Deno.test('an inline (?i) holds to the end of its group, across alternatives', () => {
  const re = goRegex('(?:x(?i)y|z)w');
  assertEquals(re.flags, '');
  assertEquals(
    ['xyw', 'xYw', 'zw', 'Zw', 'Xyw', 'xyW', 'zW'].map((text) => re.test(text)),
    [true, true, true, true, false, false, false],
  );
  const top = goRegex('ab(?i)c[a-f0-9]|d');
  assertEquals(
    ['abcA', 'abCf', 'D', 'ABca'].map((text) => new RegExp(`^(?:${top.source})$`).test(text)),
    [true, true, true, false],
  );
});

Deno.test('(?-i:…) keeps its case inside a pattern that ignores case', () => {
  const re = goRegex('(?i)key(?-i:API|[Aa]pi)x');
  assertEquals(
    ['KEYAPIX', 'keyApix', 'keyapiX', 'keyaPix', 'keyAPix'].map((text) => re.test(text)),
    [true, true, true, false, false],
  );
});

Deno.test('a class under (?i) reads both cases, and a negated one neither', () => {
  assertEquals(String(goRegex('x(?i)[a-c9_]')), '/x(?:[a-cA-C9_])/');
  const not = goRegex('x(?i)[^a-c]');
  assertEquals(
    ['xa', 'xB', 'xd'].map((text) => not.test(text)),
    [false, false, true],
  );
});

Deno.test("Go's dot, space and end of text are read as Go reads them", () => {
  const dot = goRegex('a.b');
  assertEquals(
    ['a\rb', 'a b', 'a\nb'].map((text) => dot.test(text)),
    [true, true, false],
  );
  assertEquals(goRegex('a(?s:.)b').test('a\nb'), true);
  const space = goRegex('a\\sb');
  assertEquals(
    ['a b', 'a\tb', 'a b', 'a\vb'].map((text) => space.test(text)),
    [true, true, false, false],
  );
  assertEquals(goRegex('a[\\s\\S-]b').test('a b'), true);
  assertEquals(goRegex('a\\z').test('a\n'), false);
  assertEquals(goRegex('a\\z').test('ba'), true);
});

Deno.test('a ] that opens a class is a character of it, as Go reads it', () => {
  const not = goRegex('\\[[^]]+]');
  assertEquals(
    ['[ab]', '[]]', '[a'].map((text) => not.test(text)),
    [true, false, false],
  );
  assertEquals(goRegex('x[]a]+y').test('x]a]y'), true);
});

Deno.test("Go's named groups and POSIX classes are rewritten", () => {
  assertEquals(goRegex('(?P<alg>[[:alnum:]]+)').exec('ab1-')?.groups?.alg, 'ab1');
});

Deno.test('a pattern JavaScript would read another way is refused', () => {
  assertThrows(() => goRegex('x(?i)é'));
  assertThrows(() => goRegex('a\\Qb\\E'));
  assertThrows(() => goRegex('\\pL'));
  assertThrows(() => goRegex('[\\A]'));
  assertThrows(() => goRegex('\\101'));
  assertThrows(() => goRegex('(a)\\1'));
  assertEquals(goRegex('\\x41\\t\\.').test('A\t.'), true);
  assertThrows(() => goRegex('(?m)^a'));
  assertThrows(() => goRegex('[\\S]'));
});

Deno.test('a range a class already holds is written once', () => {
  assertEquals(goRegex('[A-Za-za-zA-Z0-9_\\-=]').source, '[A-Za-z0-9_\\-=]');
  assertEquals(goRegex('[/|#|?|:]').source, '[/|#?:]');
  assertEquals(goRegex('(?i:[a-fA-F]x)').source, '(?:[a-fA-F][xX])');
  assertEquals(goRegex('[^a-zm]').source, '[^a-z]');
});
