import '../fixtures/test-host.ts';
import { recordOf } from '../../src/guardrails/boundaries.ts';
import { detectAt, detectReads } from '../../src/guardrails/detect-at.ts';
import {
  actionAt,
  DETECTORS,
  type DetectorRule,
  type DetectSpec,
  detectProblem,
  HOST_FIND_HOLD,
  type HostFind,
  resolveDetect,
} from '../../src/guardrails/detectors.ts';
import { compileDetect, compilePatterns } from '../../src/guardrails/egress-compiler.ts';
import type { HostPattern } from '../../src/guardrails/host-patterns.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { createOutboundProgressiveGate } from '../../src/guardrails/progressive-yield.ts';
import { detectRule } from '../../src/guardrails/rules.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

const RECORD = 'MRN-20481234';
const RECORDS: HostPattern[] = [{ name: 'record-number', pattern: 'MRN-\\d{8}' }];
const RULE = detectRule('acme.record');

/** Every run of `word` in the text, as a host's own reading would find it. */
function finds(word: string): HostFind {
  return (text) => {
    const spans = [];
    for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
      spans.push({ start: at, end: at + word.length });
    }
    return spans;
  };
}

function resolved(spec: DetectSpec) {
  return resolveDetect(compileDetect(spec));
}

Deno.test('a detector of the host’s own reads with its patterns under its own rule', () => {
  const detect = resolved({
    'acme.record': { label: 'Record numbers', patterns: RECORDS, action: 'redact' },
  });
  const inbound = detectAt(`Record ${RECORD} please.`, 'user', detect);
  assertEquals(inbound.action, 'redact');
  assertEquals(inbound.text, 'Record [omitted] please.');
  assertEquals(inbound.hits, [
    {
      rule: RULE,
      severity: 'high',
      span: { start: 7, end: 19 },
      match: RECORD,
      pattern: 'record-number',
      label: 'Record numbers',
    },
  ]);
  assertEquals(RULE, 'detect.acme.record');
  assertEquals(detectAt('Nothing here.', 'user', detect).action, 'allow');
});

Deno.test('a host detector applies where its action and at say, and nowhere by default', () => {
  const detect = resolved({
    'acme.record': { label: 'Record numbers', patterns: RECORDS, at: { reply: 'block' } },
  });
  assertEquals(actionAt(detect, 'acme.record', 'reply'), 'block');
  assertEquals(actionAt(detect, 'acme.record', 'user'), 'ignore');
  assertEquals(actionAt(detect, 'acme.other', 'reply'), 'ignore');
  assertEquals(detectAt(`It is ${RECORD}.`, 'reply', detect).action, 'block');
  assertEquals(detectAt(`It is ${RECORD}.`, 'user', detect).action, 'allow');
  // Alone, with every detector of Theorem's off, it is still a reason to read the reply.
  const alone = resolved({
    ...recordOf(DETECTORS, (): DetectorRule => 'ignore'),
    'acme.record': { label: 'Record numbers', patterns: RECORDS, at: { reply: 'block' } },
  });
  assertEquals(detectReads(['reply'], alone), true);
  assertEquals(detectReads(['thought'], alone), false);
});

Deno.test('a host detector reads with find, alone or beside its patterns', () => {
  const alone = resolved({
    'acme.codename': { label: 'Codenames', find: finds('falcon'), action: 'redact' },
  });
  const read = detectAt('The falcon and the falcon.', 'user', alone);
  assertEquals(read.text, 'The [omitted] and the [omitted].');
  assertEquals(
    read.hits.map(({ rule, match }) => [rule, match]),
    [
      ['detect.acme.codename', 'falcon'],
      ['detect.acme.codename', 'falcon'],
    ],
  );

  const both = resolved({
    'acme.record': { label: 'Records', patterns: RECORDS, find: finds('falcon'), action: 'flag' },
  });
  const flagged = detectAt(`falcon has ${RECORD}`, 'user', both);
  assertEquals(flagged.action, 'flag');
  assertEquals(flagged.hits.map(({ match }) => match).sort(), [RECORD, 'falcon']);
});

Deno.test('find is told the boundary it reads', () => {
  const seen: (string | undefined)[] = [];
  const detect = resolved({
    'acme.seen': {
      label: 'Seen',
      action: 'flag',
      find: (_text, { boundary }) => {
        seen.push(boundary);
        return [];
      },
    },
  });
  detectAt('a', 'user', detect);
  detectAt('a', 'tool_output_http', detect);
  assertEquals(seen, ['user', 'tool_output_http']);
});

Deno.test('a find that throws or leaves the text stops the text, whatever its action', () => {
  const failing: Record<string, HostFind> = {
    throws: () => {
      throw new Error('down');
    },
    past: (text) => [{ start: 0, end: text.length + 1 }],
    empty: () => [{ start: 2, end: 2 }],
    fraction: () => [{ start: 0.5, end: 2 }],
    notList: (() => 'falcon') as unknown as HostFind,
  };
  for (const [name, find] of Object.entries(failing)) {
    const detect = resolved({ 'acme.broken': { label: 'Broken', find, action: 'flag' } });
    const read = detectAt('Some text.', 'user', detect);
    assertEquals([name, read.action, read.text], [name, 'block', undefined]);
    assertEquals(read.hits, [{ rule: 'detect.acme.broken', severity: 'high', label: 'Broken' }]);
  }
});

Deno.test('detectProblem says what a detector of the host’s own is missing', () => {
  const compiled = compilePatterns(RECORDS);
  const check = (spec: unknown, problem: string | undefined) =>
    assertEquals(detectProblem('d', spec), problem);
  check({ 'acme.record': { label: 'R', patterns: RECORDS, compiled, action: 'flag' } }, undefined);
  check({ 'acme.record': { label: 'R', find: finds('x'), at: { reply: 'block' } } }, undefined);
  check(
    { record: 'flag' },
    `d.record is not a detector (${DETECTORS.join(', ')}), nor one of your own: those have a dot in their key, as in acme.record`,
  );
  check(
    { 'Acme.Record': { label: 'R', find: finds('x'), action: 'flag' } },
    'd.Acme.Record: a detector of your own is keyed namespace.name in lower case, digits and _, as in acme.record',
  );
  check(
    { 'acme.record': 'block' },
    'd.acme.record must be an object: a label, an action or at, and patterns or find',
  );
  check(
    { 'acme.record': { label: 'R', find: finds('x'), action: 'flag', theorem: false } },
    'd.acme.record.theorem is not a setting of a detector of your own (label, action, at, patterns, compiled, find, hint)',
  );
  check(
    { 'acme.record': { find: finds('x'), action: 'flag' } },
    'd.acme.record.label must be a non-empty string',
  );
  check(
    { 'acme.record': { label: 'R', find: finds('x') } },
    'd.acme.record needs an action or at: a detector of your own has no default',
  );
  check(
    { 'acme.record': { label: 'R', action: 'flag' } },
    'd.acme.record needs patterns or find: it has nothing to read with',
  );
  check(
    { 'acme.record': { label: 'R', action: 'flag', find: 'falcon' } },
    'd.acme.record.find must be a function',
  );
  check(
    { 'acme.record': { label: 'R', action: 'flag', patterns: RECORDS } },
    'd.acme.record.patterns need their compiled table: set d.acme.record.compiled from `agents detect-compile`, or wrap the detect setting in compileDetect from @theoremjs/agents/guardrails/compile',
  );
});

/** What a reply streamed a character at a time shows under `spec`, and whether it was stopped. */
async function streamed(
  spec: DetectSpec,
  reply: string,
): Promise<{ shown: string; blocked: boolean; most: number }> {
  const policy = resolveGuardrailPolicy({ detect: compileDetect(spec) });
  const context = { stage: 'output_final', trust: 'untrusted', profileId: 'chat' } as const;
  const gate = createOutboundProgressiveGate(policy, context, 'reply');
  if (!gate) return { shown: reply, blocked: false, most: 0 };
  let shown = '';
  let read = 0;
  /** The most text that was ever held back at once. */
  let most = 0;
  for (const char of reply) {
    const step = await gate.process(char);
    if (step.blocked) return { shown, blocked: true, most };
    shown += step.emit;
    read += char.length;
    most = Math.max(most, read - shown.length);
  }
  const end = await gate.flush();
  return end.blocked
    ? { shown, blocked: true, most }
    : { shown: shown + end.emit, blocked: false, most };
}

Deno.test('a reply streams up to a host detector’s pattern and no further', async () => {
  const reply = `Your record is ${RECORD}, kept safe.`;
  const block: DetectSpec = {
    'acme.record': { label: 'Records', patterns: RECORDS, action: 'block' },
  };
  const stopped = await streamed(block, reply);
  assertEquals(stopped.blocked, true);
  assertEquals(stopped.shown, 'Your record is ');

  const redact: DetectSpec = {
    'acme.record': { label: 'Records', patterns: RECORDS, action: 'redact' },
  };
  const replaced = await streamed(redact, reply);
  assertEquals(replaced.blocked, false);
  assertEquals(replaced.shown, 'Your record is [omitted], kept safe.');

  const clean = await streamed(block, 'MRN is the hospital number. Nothing else.');
  assertEquals(clean.shown, 'MRN is the hospital number. Nothing else.');
  assertEquals(clean.blocked, false);
});

Deno.test('a reply read by find holds a fixed tail, and a match inside it never shows', async () => {
  const spec: DetectSpec = {
    'acme.codename': { label: 'Codenames', find: finds('falcon'), action: 'block' },
  };
  const lead = 'word '.repeat(120);
  const stopped = await streamed(spec, `${lead}falcon then more.`);
  assertEquals(stopped.blocked, true);
  assertEquals(stopped.shown.includes('falcon'), false);
  assertEquals(lead.startsWith(stopped.shown), true);

  const clean = await streamed(spec, `${lead}and nothing else.`);
  assertEquals(clean.blocked, false);
  assertEquals(clean.shown, `${lead}and nothing else.`);
  assertEquals(clean.most <= HOST_FIND_HOLD + 1, true);
  assertEquals(clean.most >= HOST_FIND_HOLD, true);

  const redact: DetectSpec = {
    'acme.codename': { label: 'Codenames', find: finds('falcon'), action: 'redact' },
  };
  const replaced = await streamed(redact, `${lead}falcon then more.`);
  assertEquals(replaced.blocked, false);
  assertEquals(replaced.shown, `${lead}[omitted] then more.`);
});

Deno.test('a find that throws mid-stream stops the reply', async () => {
  const spec: DetectSpec = {
    'acme.broken': {
      label: 'Broken',
      action: 'flag',
      find: (text) => {
        if (text.length > 300) throw new Error('down');
        return [];
      },
    },
  };
  assertEquals((await streamed(spec, 'word '.repeat(120))).blocked, true);
});
