import type { CorpusSample } from '../../src/guardrails/eval/corpus.ts';
import {
  type EvalDetector,
  formatScores,
  scoreAll,
  scoreDetector,
} from '../../src/guardrails/eval/score.ts';
import { projectGuardrailEvent } from '../../src/guardrails/hits.ts';
import type { GuardrailEvent } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

const sample = (text: string, attack: boolean, category: string, source = 's'): CorpusSample => ({
  text,
  attack,
  source,
  category,
});

const firesOn =
  (...hits: string[]) =>
  (text: string) =>
    hits.includes(text);

const detector = (extras: Partial<EvalDetector> = {}): EvalDetector => ({
  id: 'd',
  action: 'redact',
  accountableFor: ['s'],
  fires: firesOn('a1', 'b1', 'b2', 'c1'),
  ...extras,
});

const SAMPLES = [
  sample('a1', true, 'attack'),
  sample('a2', true, 'attack'),
  sample('b1', false, 'email'),
  sample('b2', false, 'email'),
  sample('b3', false, 'email'),
  sample('b4', false, 'email'),
  sample('c1', false, 'chat'),
  sample('c2', false, 'chat'),
  sample('d1', false, 'clean'),
];

Deno.test('scoreDetector reports every count and rate exactly', () => {
  assertEquals(scoreDetector(detector(), 's', SAMPLES), {
    detector: 'd',
    action: 'redact',
    source: 's',
    attacks: 2,
    attacksCaught: 1,
    recall: 0.5,
    benign: 7,
    falsePositives: 3,
    falsePositiveRate: 3 / 7,
    byCategory: [
      { category: 'email', samples: 4, fired: 2, rate: 0.5 },
      { category: 'chat', samples: 2, fired: 1, rate: 0.5 },
      { category: 'clean', samples: 1, fired: 0, rate: 0 },
    ],
  });
});

Deno.test('byCategory is ordered by rate, highest first', () => {
  const out = scoreDetector(detector({ fires: firesOn('x1', 'y1', 'y2') }), 's', [
    sample('x1', false, 'low'),
    sample('x2', false, 'low'),
    sample('x3', false, 'low'),
    sample('y1', false, 'high'),
    sample('y2', false, 'high'),
    sample('z1', false, 'none'),
  ]);
  assertEquals(
    out.byCategory.map((c) => [c.category, c.rate]),
    [
      ['high', 1],
      ['low', 1 / 3],
      ['none', 0],
    ],
  );
});

Deno.test('a detector not accountable for the source reports no attacks and no recall', () => {
  const out = scoreDetector(detector({ accountableFor: ['elsewhere'] }), 's', SAMPLES);
  assertEquals(
    [out.attacks, out.attacksCaught, out.recall, out.benign, out.falsePositives],
    [0, 0, undefined, 7, 3],
  );
});

Deno.test('a source with attacks only has no false-positive rate, and one with none has no recall', () => {
  const attacksOnly = scoreDetector(detector(), 's', [sample('a1', true, 'attack')]);
  assertEquals(
    [attacksOnly.recall, attacksOnly.falsePositiveRate, attacksOnly.byCategory],
    [1, undefined, []],
  );
  const benignOnly = scoreDetector(detector(), 's', [sample('b1', false, 'email')]);
  assertEquals([benignOnly.recall, benignOnly.falsePositiveRate], [undefined, 1]);
});

Deno.test('scoreAll scores each detector against each source with samples, and skips empty ones', () => {
  const out = scoreAll(
    [detector({ id: 'one' }), detector({ id: 'two' })],
    new Map([
      ['s', [sample('a1', true, 'attack')]],
      ['empty', []],
      ['t', [sample('b1', false, 'email', 't')]],
    ]),
  );
  assertEquals(
    out.map((s) => [s.detector, s.source]),
    [
      ['one', 's'],
      ['one', 't'],
      ['two', 's'],
      ['two', 't'],
    ],
  );
});

function benign(count: number, fired: number, category: string): CorpusSample[] {
  return Array.from({ length: count }, (_, i) =>
    sample(i < fired ? `hit-${category}-${i}` : `miss-${category}-${i}`, false, category),
  );
}

Deno.test('formatScores prints each source line with recall, false positives and what fired', () => {
  const fires = (text: string) => text.startsWith('hit') || text === 'attack-1';
  const scores = scoreAll(
    [detector({ id: 'inj', action: 'block', fires })],
    new Map([
      [
        's',
        [
          sample('attack-1', true, 'attack'),
          sample('attack-2', true, 'attack'),
          ...benign(3, 1, 'email'),
          ...benign(2, 0, 'clean'),
        ],
      ],
      ['big', benign(200, 50, 'chat').map((x) => ({ ...x, source: 'big' }))],
      ['edge', benign(199, 0, 'chat').map((x) => ({ ...x, source: 'edge' }))],
    ]),
  );
  const [header, ...lines] = formatScores(scores).split('\n').slice(1);
  assertEquals(header, 'inj  (on fire: block)');
  assertEquals(lines, [
    `  ${'s'.padEnd(24)} recall  50.0% (1/2)   false+  20.0% (1/5)  [n too small]`,
    `      ${'email'.padEnd(22)}  33.3% (1/3)`,
    `  ${'big'.padEnd(24)} recall     n/a           false+  25.0% (50/200)`,
    `      ${'chat'.padEnd(22)}  25.0% (50/200)`,
    `  ${'edge'.padEnd(24)} recall     n/a           false+   0.0% (0/199)  [n too small]`,
  ]);
});

Deno.test('formatScores shows an absent rate as a dash, and no thin-sample note without benign samples', () => {
  const scores = scoreAll([detector()], new Map([['s', [sample('a1', true, 'attack')]]]));
  assertEquals(
    formatScores(scores),
    `\nd  (on fire: redact)\n  ${'s'.padEnd(24)} recall 100.0% (1/1)   false+    —   (0/0)`,
  );
});

const EVENT: GuardrailEvent = {
  stage: 'input',
  trust: 'untrusted',
  action: 'redact',
  hits: [{ rule: 'r', severity: 'high', span: { start: 0, end: 3 }, match: 'abc' }],
  provenance: { origin: 'mcp', tool: 'search', depth: 1 },
};

Deno.test('projectGuardrailEvent keeps the caught text only when asked, and drops nothing else', () => {
  assertEquals(projectGuardrailEvent(EVENT, true), EVENT);
  assertEquals(projectGuardrailEvent(EVENT, false), {
    ...EVENT,
    hits: [{ rule: 'r', severity: 'high', span: { start: 0, end: 3 } }],
  });
});
