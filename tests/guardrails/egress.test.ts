import '../fixtures/test-host.ts';
import { mintCanary, USER_CLOSE, USER_OPEN } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY, TEST_SSN } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { EGRESS_RULES, runEnforcer, standardEgressEnforce } from '../../src/guardrails/egress.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import type {
  EgressEnforcer,
  GuardrailContext,
  OutboundPayload,
  Verdict,
} from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

function egressCtx(canary?: string): GuardrailContext {
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: 'chat',
    ...(canary ? { canary } : {}),
  };
}

function enforce(text: string, canary?: string, structured?: unknown): Verdict {
  const payload: OutboundPayload = {
    text,
    ...(structured !== undefined ? { structured } : {}),
  };
  return standardEgressEnforce(payload, egressCtx(canary));
}

/** Rule ids on a verdict, or an empty list when nothing was hit. */
function rules(verdict: Verdict): string[] {
  return verdict.action === 'allow' ? [] : verdict.hits.map((hit) => hit.rule);
}

Deno.test('standardEgressEnforce allows benign assistant text', () => {
  assertEquals(enforce('Hello! How can I help?', mintCanary()).action, 'allow');
});

Deno.test('standardEgressEnforce blocks literal canary leak', () => {
  const canary = mintCanary();
  const verdict = enforce(`The token is ${canary}`, canary);
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.canary), true);
});

Deno.test('standardEgressEnforce blocks sensitive echo', () => {
  const verdict = enforce(`Your key is ${TEST_OPENAI_KEY}`, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.sensitive), true);
});

Deno.test('standardEgressEnforce blocks system boundary markers', () => {
  const verdict = enforce('leak: <user_data>secret</user_data>', mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.boundary), true);
});

Deno.test('standardEgressEnforce blocks injection echo in assistant text', () => {
  const verdict = enforce(INJ_IGNORE, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.injection), true);
});

Deno.test('standardEgressEnforce blocks user_data fence markers', () => {
  const verdict = enforce(`leaked ${USER_OPEN}`, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.boundary), true);
});

Deno.test('standardEgressEnforce reports multiple hit kinds', () => {
  const canary = mintCanary();
  const verdict = enforce(`${INJ_IGNORE} ${TEST_SSN} ${canary}`, canary);
  assertEquals(verdict.action, 'block');
  assertEquals(new Set(rules(verdict)).size >= 2, true);
});

Deno.test('standardEgressEnforce passes empty text without blocking', () => {
  assertEquals(enforce('', mintCanary()).action, 'allow');
});

Deno.test('standardEgressEnforce rejection names all blocked categories', () => {
  const canary = mintCanary();
  const verdict = enforce(`${canary} ${INJ_IGNORE}`, canary);
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertEquals(verdict.rejection.includes(EGRESS_RULES.canary), true);
  assertEquals(verdict.rejection.includes(EGRESS_RULES.injection), true);
});

Deno.test('standardEgressEnforce blocks "This turn\\u2019s canary is" boundary marker in text', () => {
  const verdict = enforce("This turn's canary is abc", mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.boundary), true);
});

Deno.test('standardEgressEnforce without canary: no canary hit on a hex token', () => {
  assertEquals(
    rules(enforce('deadbeeffeedfacecafebabecafebabe')).includes(EGRESS_RULES.canary),
    false,
  );
});

Deno.test('standardEgressEnforce blocks closing user_data fence tag', () => {
  const verdict = enforce(`leaked ${USER_CLOSE}`, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.boundary), true);
});

Deno.test('standardEgressEnforce carries span offsets on sensitive hits', () => {
  const text = `Your ssn is ${TEST_SSN}`;
  const verdict = enforce(text, mintCanary());
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  const hit = verdict.hits.find((h) => h.rule === EGRESS_RULES.sensitive);
  assertEquals(hit?.severity, 'high');
  assertEquals(typeof hit?.span?.start, 'number');
  assertEquals((hit?.span?.end ?? 0) > (hit?.span?.start ?? 0), true);
});

// ── structured output is no longer invisible to egress ───────────────────────

Deno.test('standardEgressEnforce inspects structured output for canary leaks', () => {
  const canary = mintCanary();
  const verdict = enforce('All done.', canary, { answer: `the token is ${canary}` });
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.canary), true);
});

Deno.test('standardEgressEnforce inspects structured output for sensitive echo', () => {
  const verdict = enforce('All done.', mintCanary(), { key: TEST_OPENAI_KEY });
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(EGRESS_RULES.sensitive), true);
});

Deno.test('standardEgressEnforce allows clean structured output', () => {
  assertEquals(enforce('All done.', mintCanary(), { answer: 42 }).action, 'allow');
});

// ── a policy that cannot reach a decision ────────────────────────────────────

Deno.test('runEnforcer converts a thrown policy error into a block', async () => {
  const verdict = await runEnforcer(
    () => {
      throw new Error('classifier unreachable');
    },
    { text: 'anything' },
    egressCtx(),
  );
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertEquals(verdict.hits[0]?.rule, EGRESS_RULES.enforcerError);
  assertEquals(verdict.hits[0]?.severity, 'high');
  // The thrown message is for the builder; the model reads the lexicon line.
  assertEquals(verdict.rejection, lexiconDefault('egress.policy_failed'));
  assertEquals(verdict.errorInternal, 'classifier unreachable');
});

Deno.test('runEnforcer converts a rejected promise into a block', async () => {
  const verdict = await runEnforcer(
    () => Promise.reject(new Error('policy timed out')),
    { text: 'anything' },
    egressCtx(),
  );
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertEquals(verdict.rejection, lexiconDefault('egress.policy_failed'));
  assertEquals(verdict.errorInternal, 'policy timed out');
});

Deno.test('runEnforcer passes a normal verdict straight through', async () => {
  assertEquals(
    (await runEnforcer(() => ({ action: 'allow' }), { text: 'ok' }, egressCtx())).action,
    'allow',
  );
});

Deno.test('runEnforcer fails closed for incomplete canonical verdicts', async () => {
  for (const malformed of [
    null,
    42,
    'not a verdict',
    { action: 'unknown' },
    { action: 'redact' },
    { action: 'redact', text: 42, hits: [] },
    { action: 'redact', text: 'safe replacement', hits: [{}] },
    { action: 'flag' },
    { action: 'flag', hits: [{ rule: '', severity: 'high' }] },
    { action: 'flag', hits: [{ rule: '   ', severity: 'high' }] },
    { action: 'flag', hits: [{ rule: 42, severity: 'high' }] },
    { action: 'flag', hits: [{ rule: 'x', severity: 'not-a-severity' }] },
    { action: 'flag', hits: [{ rule: 'x', severity: 'high', match: 42 }] },
    { action: 'flag', hits: [{ rule: 'x', severity: 'high', span: {} }] },
    { action: 'flag', hits: [{ rule: 'x', severity: 'high', span: 'bad' }] },
    {
      action: 'flag',
      hits: [{ rule: 'x', severity: 'high', span: { start: '0', end: 1 } }],
    },
    {
      action: 'flag',
      hits: [{ rule: 'x', severity: 'high', span: { start: 0, end: '1' } }],
    },
    {
      action: 'flag',
      hits: [{ rule: 'x', severity: 'high', span: { start: NaN, end: 1 } }],
    },
    {
      action: 'flag',
      hits: [{ rule: 'x', severity: 'high', span: { start: 0, end: Infinity } }],
    },
    {
      action: 'flag',
      hits: [
        { rule: 'valid', severity: 'high' },
        { rule: '', severity: 'high' },
      ],
    },
    { action: 'block' },
    {
      action: 'block',
      hits: [{ rule: 'x', severity: 'not-a-severity' }],
      rejection: 'blocked',
    },
    { action: 'block', hits: [], rejection: 42 },
  ]) {
    const verdict = await runEnforcer(
      (() => malformed) as unknown as EgressEnforcer,
      { text: 'untrusted output' },
      egressCtx(),
    );
    assertEquals(verdict.action, 'block');
    if (verdict.action === 'block') {
      assertEquals(verdict.hits, [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }]);
      assertEquals(verdict.rejection, 'Egress policy returned an invalid verdict shape');
    }
  }
});

Deno.test('runEnforcer normalizes legacy verdicts without trusting malformed fields', async () => {
  const runLegacy = (value: unknown) =>
    runEnforcer(
      (() => value) as unknown as EgressEnforcer,
      { text: 'untrusted output' },
      egressCtx(),
    );

  assertEquals(await runLegacy({ blocked: false }), { action: 'allow' });
  assertEquals(
    await runLegacy({
      blocked: true,
      rejectionMessage: 'blocked',
      hits: [
        'legacy.string',
        { rule: 'legacy.object', severity: 'low' },
        { rule: 'legacy.default-severity', severity: 'invalid' },
        null,
      ],
    }),
    {
      action: 'block',
      hits: [
        { rule: 'legacy.string', severity: 'high' },
        { rule: 'legacy.object', severity: 'low' },
        { rule: 'legacy.default-severity', severity: 'high' },
      ],
      rejection: 'blocked',
    },
  );
  assertEquals(
    await runLegacy({
      blocked: true,
      rejectionMessage: '   ',
      hits: 'not-an-array',
    }),
    {
      action: 'block',
      hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
      rejection: lexiconDefault('egress.rejection', { rules: EGRESS_RULES.enforcerError }),
    },
  );
  assertEquals(await runLegacy({ blocked: true, hits: [] }), {
    action: 'block',
    hits: [{ rule: EGRESS_RULES.enforcerError, severity: 'high' }],
    rejection: lexiconDefault('egress.rejection', { rules: EGRESS_RULES.enforcerError }),
  });
});

Deno.test('kernel rejections read in the profile lexicon', async () => {
  const lexicon = {
    'egress.rejection': 'Host copy: {rules}',
    'egress.policy_failed': 'Host copy failed',
  };
  const blocked = await runEnforcer(
    () => ({ blocked: true, hits: ['legacy.rule'] }) as unknown as Verdict,
    { text: 'x' },
    { ...egressCtx(), lexicon },
  );
  assertEquals(blocked.action === 'block' && blocked.rejection, 'Host copy: legacy.rule');
  const failed = await runEnforcer(
    () => {
      throw new Error('policy crashed');
    },
    { text: 'x' },
    { ...egressCtx(), lexicon },
  );
  assertEquals(failed.action === 'block' && failed.rejection, 'Host copy failed');
});

Deno.test('runEnforcer preserves complete canonical verdict variants', async () => {
  const hit = {
    rule: 'x',
    severity: 'medium' as const,
    match: 'preview',
    span: { start: 0, end: 7 },
  };
  const verdicts: Verdict[] = [
    { action: 'allow' },
    { action: 'redact', text: 'safe replacement', hits: [hit] },
    { action: 'flag', hits: [hit] },
    { action: 'block', hits: [hit], rejection: 'blocked' },
  ];
  for (const expected of verdicts) {
    const actual = await runEnforcer(() => expected, { text: 'untrusted output' }, egressCtx());
    assertEquals(actual, expected);
  }
});
