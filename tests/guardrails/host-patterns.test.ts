import '../fixtures/test-host.ts';
import { detectCompileCommand } from '../../src/cli/commands/detect-compile.ts';
import { detectAt } from '../../src/guardrails/detect-at.ts';
import { type DetectSpec, detectProblem, resolveDetect } from '../../src/guardrails/detectors.ts';
import { compileDetect, compilePatterns } from '../../src/guardrails/egress-compiler.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import type { HostPattern } from '../../src/guardrails/host-patterns.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { createOutboundProgressiveGate } from '../../src/guardrails/progressive-yield.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';

const SSN = '123-45-6789';
const RECORD = 'MRN-20481234';
const RECORDS: HostPattern[] = [{ name: 'record-number', pattern: 'MRN-\\d{8}' }];

/** The distinct rule and pattern name of every hit `spec` finds in `text` on its way in. */
function found(spec: DetectSpec, text: string): string[] {
  const detected = detectAt(text, 'user', resolveDetect(compileDetect(spec)));
  const names = detected.hits.map(({ rule, pattern }) => (pattern ? `${rule}:${pattern}` : rule));
  return [...new Set(names)].sort();
}

Deno.test('a detector reads with both sets of patterns, only Theorem’s, only the host’s, or none', () => {
  const text = `SSN ${SSN}, record ${RECORD}.`;
  const ids = DETECT_RULES.ids;
  assertEquals(found({ ids: { patterns: RECORDS } }, text), [ids, `${ids}:record-number`]);
  assertEquals(found({ ids: 'flag' }, text), [ids]);
  assertEquals(found({ ids: { theorem: false, patterns: RECORDS } }, text), [
    `${ids}:record-number`,
  ]);
  assertEquals(found({ ids: { theorem: false } }, text), []);
});

Deno.test('a detector left with no patterns is ignored everywhere, whatever its action', () => {
  const { ids } = resolveDetect({ ids: { theorem: false, action: 'block' } });
  assertEquals(new Set(Object.values(ids)), new Set(['ignore']));
});

Deno.test('a host pattern takes its detector’s action: redacted in, blocked where at says', () => {
  const detect = resolveDetect(
    compileDetect({
      ids: { theorem: false, patterns: RECORDS, action: 'redact', at: { reply: 'block' } },
    }),
  );
  const inbound = detectAt(`Record ${RECORD} please.`, 'user', detect);
  assertEquals(inbound.action, 'redact');
  assertEquals(inbound.text?.includes(RECORD), false);
  assertEquals(inbound.hits[0]?.match, RECORD);
  assertEquals(detectAt(`It is ${RECORD}.`, 'reply', detect).action, 'block');
  assertEquals(detectAt(`SSN ${SSN}.`, 'user', detect).action, 'allow');
});

Deno.test('words match whole, without regard to case, across any whitespace', () => {
  const spec: DetectSpec = {
    injection: {
      theorem: false,
      action: 'block',
      patterns: [{ name: 'codenames', words: ['Project Falcon', 'osprey'] }],
    },
  };
  const hit = [`${DETECT_RULES.injection}:codenames`];
  assertEquals(found(spec, 'About project\n  FALCON then.'), hit);
  assertEquals(found(spec, 'The Osprey flies.'), hit);
  assertEquals(found(spec, 'ospreys and projectfalcon'), []);
});

Deno.test('detectProblem refuses a pattern setting a detector cannot take, and a bad pattern', () => {
  const compiled = compilePatterns(RECORDS);
  const check = (spec: unknown, problem: string | undefined) =>
    assertEquals(detectProblem('guardrails.detect', spec), problem);
  check({ ids: { patterns: RECORDS, compiled } }, undefined);
  check({ ids: { theorem: false } }, undefined);
  check(
    { canary_leak: { theorem: false } },
    'guardrails.detect.canary_leak.theorem is a setting of the detectors that read with patterns only (ids, financial, network, credentials, injection, tool_instructions, tool_leak)',
  );
  check(
    { prompt_leak: { patterns: RECORDS } },
    'guardrails.detect.prompt_leak.patterns is a setting of the detectors that read with patterns only (ids, financial, network, credentials, injection, tool_instructions, tool_leak)',
  );
  check({ ids: { theorem: 'no' } }, 'guardrails.detect.ids.theorem must be a boolean');
  check(
    { ids: { patterns: RECORDS } },
    'guardrails.detect.ids.patterns need their compiled table: set guardrails.detect.ids.compiled from `agents detect-compile`, or wrap the detect setting in compileDetect from @theoremjs/agents/guardrails/compile',
  );
  check(
    { ids: { patterns: [{ name: 'other', pattern: 'X\\d{4}' }], compiled } },
    'guardrails.detect.ids.compiled was compiled from other patterns; run `agents detect-compile` or compilePatterns again',
  );
  check(
    { ids: { patterns: RECORDS, compiled: { ...compiled, compiler: 0 } } },
    'guardrails.detect.ids.compiled comes from compiler 0, this one is 3; run `agents detect-compile` or compilePatterns again',
  );
  const bad = (pattern: unknown) =>
    detectProblem('d', { ids: { patterns: [pattern], compiled } }) ?? '';
  assertEquals(
    bad({ name: 'a', pattern: '(' }).startsWith('d.ids.patterns[0] does not compile'),
    true,
  );
  assertEquals(bad({ name: 'a', pattern: 'x*' }), 'd.ids.patterns[0] matches the empty text');
  assertEquals(
    bad({ name: '', pattern: 'x' }),
    'd.ids.patterns[0].name must be a non-empty string',
  );
  assertEquals(bad({ name: 'a' }), 'd.ids.patterns[0] takes one of pattern and words');
  assertEquals(
    bad({ name: 'a', pattern: 'x', words: ['x'] }),
    'd.ids.patterns[0] takes one of pattern and words',
  );
  assertEquals(
    bad({ name: 'a', pattern: 'x', flags: 'y' }),
    'd.ids.patterns[0].flags: a sticky (y) pattern only matches where the last one ended',
  );
  assertEquals(
    bad({ name: 'a', pattern: 'x', flags: 'g' }),
    'd.ids.patterns[0].flags: g is implied, every match is found',
  );
  assertEquals(
    bad({ name: 'a', words: [' '] }),
    'd.ids.patterns[0].words must be a list with at least one word',
  );
  assertEquals(
    detectProblem('d', {
      ids: {
        patterns: [
          { name: 'a', pattern: 'x' },
          { name: 'a', pattern: 'y' },
        ],
        compiled,
      },
    }),
    'd.ids.patterns[1].name "a" is listed twice',
  );
});

Deno.test('compilePatterns refuses a pattern with a backreference to text that varies', () => {
  assertThrows(
    () => compilePatterns([{ name: 'twice', pattern: '(\\w{4})-\\1' }]),
    TheoremError,
    'compilePatterns: twice',
  );
});

Deno.test('compilePatterns refuses a pattern that can hang or get slow, and takes the bounded one', () => {
  const compile = (pattern: string) => () => compilePatterns([{ name: 'p', pattern }]);
  // why: Joined here so the pattern that hangs is never a regular expression in this file.
  const hangs = ['(a+)', '+b'].join('');
  assertThrows(compile(hangs), TheoremError, 'can hang on text that nearly matches');
  assertThrows(compile('\\d+x'), TheoremError, 'Bound the repeat \\d+ ({1,64} in place of + or *)');
  assertThrows(compile('\\w+@\\w+\\.\\w+'), TheoremError, 'gets slow on long text');
  for (const fine of ['\\d{1,64}x', '[A-Z]{2}\\d{6,10}', '\\w{1,64}@\\w{1,64}\\.\\w{2,24}']) {
    assertEquals(compile(fine)().patterns[0]?.source, fine);
  }
  const words = compilePatterns([{ name: 'w', words: ['Project Falcon', 'osprey'] }]);
  assertEquals(words.patterns.length, 1);
});

/** What a reply streamed a character at a time shows under `spec`, and whether it was stopped. */
async function streamed(
  spec: DetectSpec,
  reply: string,
): Promise<{ shown: string; blocked: boolean }> {
  const policy = resolveGuardrailPolicy({ detect: compileDetect(spec) });
  const context = { stage: 'output_final', trust: 'untrusted', profileId: 'chat' } as const;
  const gate = createOutboundProgressiveGate(policy, context, 'reply');
  if (!gate) return { shown: reply, blocked: false };
  let shown = '';
  for (const char of reply) {
    const step = await gate.process(char);
    if (step.blocked) return { shown, blocked: true };
    shown += step.emit;
  }
  const end = await gate.flush();
  return end.blocked ? { shown, blocked: true } : { shown: shown + end.emit, blocked: false };
}

Deno.test('a reply streams up to a host pattern’s match and no further', async () => {
  const reply = `Your record is ${RECORD}, kept safe.`;
  const block: DetectSpec = { ids: { theorem: false, patterns: RECORDS, action: 'block' } };
  const stopped = await streamed(block, reply);
  assertEquals(stopped.blocked, true);
  assertEquals(stopped.shown, 'Your record is ');

  const redact: DetectSpec = { ids: { theorem: false, patterns: RECORDS, action: 'redact' } };
  const replaced = await streamed(redact, reply);
  assertEquals(replaced.blocked, false);
  assertEquals(replaced.shown.includes(RECORD), false);
  assertEquals(replaced.shown.startsWith('Your record is '), true);
  assertEquals(replaced.shown.endsWith(', kept safe.'), true);

  const clean = await streamed(block, 'MRN is the hospital number. Nothing else.');
  assertEquals(clean, { shown: 'MRN is the hospital number. Nothing else.', blocked: false });
});

Deno.test('only the host’s patterns: Theorem’s no longer stop or hold the reply', async () => {
  const spec: DetectSpec = { ids: { theorem: false, patterns: RECORDS, action: 'block' } };
  const reply = `The SSN on file is ${SSN}.`;
  assertEquals(await streamed(spec, reply), { shown: reply, blocked: false });
  assertEquals((await streamed({ ids: 'block' }, reply)).blocked, true);
});

Deno.test('agents detect-compile writes the table each detector’s patterns need', async () => {
  const dir = await Deno.makeTempDir();
  const source = `${dir}/detect.ts`;
  const out = `${dir}/detect.compiled.ts`;
  await Deno.writeTextFile(
    source,
    `export const detect = ${JSON.stringify({ ids: { patterns: RECORDS }, injection: 'block' })};`,
  );
  assertEquals(await detectCompileCommand({ module: source, out }), ['ids']);
  const { compiledDetect } = await import(`file://${out}`);
  assertEquals(
    detectProblem('d', { ids: { patterns: RECORDS, compiled: compiledDetect.ids } }),
    undefined,
  );
  await Deno.remove(dir, { recursive: true });
});
