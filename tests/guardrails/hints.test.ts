import { assertEquals, assertStringIncludes } from '@std/assert';
import { detectAt } from '../../src/guardrails/detect-at.ts';
import { detectProblem, resolveDetect } from '../../src/guardrails/detectors.ts';
import { retryRejection } from '../../src/guardrails/hints.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { EGRESS_RULES } from '../../src/guardrails/rules.ts';

const CODENAMES = {
  label: 'Codenames',
  at: { reply: 'block' },
  find: (text: string) => {
    const start = text.indexOf('Bluebird');
    return start < 0 ? [] : [{ start, end: start + 8 }];
  },
} as const;

function rejectionOf(text: string, spec: Parameters<typeof resolveDetect>[0]): string {
  const detect = resolveDetect(spec);
  return retryRejection(detectAt(text, 'reply', detect).hits, detect);
}

Deno.test("a retry carries each detector's hint once, with what it matched", () => {
  const rejection = rejectionOf('Reach 10.0.0.7 or 10.0.0.9, then 10.0.0.7.', { network: 'block' });
  assertEquals(
    rejection,
    lexiconDefault('egress.rejection', {
      found: lexiconDefault('egress.rejection_found', {
        hint: lexiconDefault('detect.hint.network'),
        matches: '"10.0.0.7", "10.0.0.9"',
      }),
    }),
  );
});

Deno.test("a detector of the host's own gives its hint, or the lexicon's with its label", () => {
  assertStringIncludes(
    rejectionOf('Project Bluebird ships.', { 'acme.codenames': CODENAMES }),
    `${lexiconDefault('detect.hint.own', { label: 'Codenames' })} Found: "Bluebird"`,
  );
  assertStringIncludes(
    rejectionOf('Project Bluebird ships.', {
      'acme.codenames': { ...CODENAMES, hint: 'Call projects by their public names.' },
    }),
    'Call projects by their public names. Found: "Bluebird"',
  );
});

Deno.test('what is ours is never quoted back, and a long match is cut', () => {
  const detect = resolveDetect();
  const leak = retryRejection(
    [
      { rule: 'detect.canary_leak', severity: 'high', match: '[canary]' },
      { rule: 'detect.prompt_leak', severity: 'high' },
      { rule: EGRESS_RULES.unscannable, severity: 'high' },
    ],
    detect,
  );
  assertEquals(
    leak,
    lexiconDefault('egress.rejection', {
      found: [
        lexiconDefault('detect.hint.canary_leak'),
        lexiconDefault('detect.hint.prompt_leak'),
        lexiconDefault('egress.hint_unscannable'),
      ].join('\n'),
    }),
  );
  const long = retryRejection(
    [{ rule: 'detect.credentials', severity: 'high', match: 'k'.repeat(500) }],
    detect,
  );
  assertStringIncludes(long, `"${'k'.repeat(120)}"`);
  assertEquals(long.includes('k'.repeat(121)), false);
});

Deno.test('a hint is one short line, and on a Theorem detector it goes beside patterns', () => {
  const problem = (spec: unknown) => detectProblem('guardrails.detect', spec);
  assertStringIncludes(problem({ ids: { hint: 'No IDs.' } }) ?? '', 'goes beside patterns');
  assertStringIncludes(
    problem({ canary_leak: { hint: 'No canary.' } }) ?? '',
    'read with patterns only',
  );
  assertStringIncludes(
    problem({ 'acme.codenames': { ...CODENAMES, hint: 'a\nb' } }) ?? '',
    'must be one line',
  );
  assertStringIncludes(
    problem({ 'acme.codenames': { ...CODENAMES, hint: 'x'.repeat(301) } }) ?? '',
    '300 characters or fewer',
  );
  assertEquals(problem({ 'acme.codenames': { ...CODENAMES, hint: 'No codenames.' } }), undefined);
});
