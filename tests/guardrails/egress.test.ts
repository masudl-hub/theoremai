import '../fixtures/test-host.ts';
import { mintCanary, USER_CLOSE, USER_OPEN } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY, TEST_SSN } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { EGRESS_RULES, runEnforcer, standardEgressEnforce } from '../../src/guardrails/egress.ts';
import type { GuardrailContext, OutboundPayload, Verdict } from '../../src/guardrails/types.ts';
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

Deno.test('standardEgressEnforce without canary: no canary hit even if text has theo-prefix', () => {
  assertEquals(rules(enforce('theo-deadbeef')).includes(EGRESS_RULES.canary), false);
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
  assertEquals(verdict.rejection.includes('classifier unreachable'), true);
});

Deno.test('runEnforcer converts a rejected promise into a block', async () => {
  const verdict = await runEnforcer(
    () => Promise.reject(new Error('policy timed out')),
    { text: 'anything' },
    egressCtx(),
  );
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertEquals(verdict.rejection.includes('policy timed out'), true);
});

Deno.test('runEnforcer never adds a refusal, so onBlock cannot leak policy internals', async () => {
  const verdict = await runEnforcer(
    () => {
      throw new Error('secret internal detail');
    },
    { text: 'anything' },
    egressCtx(),
  );
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertEquals(verdict.refusal, undefined);
});

Deno.test('runEnforcer passes a normal verdict straight through', async () => {
  assertEquals(
    (await runEnforcer(() => ({ action: 'allow' }), { text: 'ok' }, egressCtx())).action,
    'allow',
  );
});
