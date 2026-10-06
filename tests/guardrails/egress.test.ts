import '../fixtures/test-host.ts';
import { mintCanary, USER_CLOSE, USER_OPEN } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { scopeOf } from '../../src/guardrails/detect-at.ts';
import { readReply } from '../../src/guardrails/detect-reply.ts';
import { eventPromptLeakHits } from '../../src/guardrails/egress.ts';
import { retryRejection } from '../../src/guardrails/hints.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import type { GuardrailContext, OutboundPayload, Verdict } from '../../src/guardrails/types.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import type { ProviderEvent } from '../../src/kernel/types.ts';

function egressCtx(canary?: string): GuardrailContext {
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: 'chat',
    ...(canary ? { canary } : {}),
  };
}

/** A profile that sets no guardrails. */
const POLICY = resolveGuardrailPolicy(undefined);

/**
 * What the detectors make of a finished reply under a profile that sets no
 * guardrails, as the runner reads it: a block with the rejection it words, or
 * allow.
 */
function enforce(text: string, canary?: string, structured?: unknown): Verdict {
  const payload: OutboundPayload = {
    text,
    ...(structured !== undefined ? { structured } : {}),
  };
  const read = readReply(payload, POLICY.detect, {
    boundary: 'reply',
    scope: scopeOf(POLICY, egressCtx(canary)),
  });
  if (!read.blocked) return { action: 'allow' };
  return {
    action: 'block',
    hits: read.blocked,
    rejection: retryRejection(read.blocked, POLICY.detect),
  };
}

function rules(verdict: Verdict): string[] {
  return verdict.action === 'allow' ? [] : verdict.hits.map((hit) => hit.rule);
}

Deno.test('a reply read by default: allows benign assistant text', () => {
  assertEquals(enforce('Hello! How can I help?', mintCanary()).action, 'allow');
});

Deno.test('a reply read by default: blocks literal canary leak', () => {
  const canary = mintCanary();
  const verdict = enforce(`The token is ${canary}`, canary);
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.canary_leak), true);
});

Deno.test('a reply read by default: sensitive data and injection text are not what blocks it', () => {
  assertEquals(enforce(`Your key is ${TEST_OPENAI_KEY}`, mintCanary()).action, 'allow');
  assertEquals(enforce(INJ_IGNORE, mintCanary()).action, 'allow');
  assertEquals(enforce('All done.', mintCanary(), { key: TEST_OPENAI_KEY }).action, 'allow');
});

Deno.test('a reply read by default: releases IP addresses: they are not secrets', () => {
  const reply =
    'Your router is usually 192.168.1.1; IPv6 looks like 2001:0db8:85a3:0000:0000:8a2e:0370:7334.';
  assertEquals(enforce(reply, mintCanary()).action, 'allow');
});

Deno.test('a reply read by default: blocks system boundary markers', () => {
  const verdict = enforce('leak: <user_data>secret</user_data>', mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.marker_leak), true);
});

Deno.test('a reply read by default: blocks user_data fence markers', () => {
  const verdict = enforce(`leaked ${USER_OPEN}`, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.marker_leak), true);
});

Deno.test('a reply read by default: reports multiple hit kinds', () => {
  const canary = mintCanary();
  const verdict = enforce(`${USER_OPEN} ${canary}`, canary);
  assertEquals(verdict.action, 'block');
  assertEquals(new Set(rules(verdict)).size >= 2, true);
});

Deno.test('a reply read by default: passes empty text without blocking', () => {
  assertEquals(enforce('', mintCanary()).action, 'allow');
});

Deno.test('a reply read by default: rejection names all blocked categories', () => {
  const canary = mintCanary();
  const verdict = enforce(`${canary} ${USER_OPEN}`, canary);
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  assertStringIncludes(verdict.rejection, lexiconDefault('detect.hint.canary_leak'));
  assertStringIncludes(verdict.rejection, lexiconDefault('detect.hint.marker_leak'));
});

Deno.test('a reply read by default: blocks "This turn\\u2019s canary is" boundary marker in text', () => {
  const verdict = enforce("This turn's canary is abc", mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.marker_leak), true);
});

Deno.test('a reply read by default: blocks the default canary note words in text', () => {
  const verdict = enforce('Your canary token is abc', mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.marker_leak), true);
});

Deno.test('a reply read by default: without canary: no canary hit on a hex token', () => {
  assertEquals(
    rules(enforce('deadbeeffeedfacecafebabecafebabe')).includes(DETECT_RULES.canary_leak),
    false,
  );
});

Deno.test('a reply read by default: blocks closing user_data fence tag', () => {
  const verdict = enforce(`leaked ${USER_CLOSE}`, mintCanary());
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.marker_leak), true);
});

Deno.test('a reply read by default: blocks a fence tag without its closing bracket', () => {
  // A gemma-4-31b thought restarted mid-tag, leaving `<user_data` run into the next sentence.
  for (const text of ['inside `<user_dataThe user provided', 'see < /user_data here']) {
    assertEquals(rules(enforce(text, mintCanary())).includes(DETECT_RULES.marker_leak), true);
  }
});

Deno.test('a reply read by default: carries span offsets on its hits', () => {
  const text = `leaked ${USER_OPEN}`;
  const verdict = enforce(text, mintCanary());
  assertEquals(verdict.action, 'block');
  if (verdict.action !== 'block') return;
  const hit = verdict.hits.find((h) => h.rule === DETECT_RULES.marker_leak);
  assertEquals(hit?.severity, 'high');
  assertEquals(typeof hit?.span?.start, 'number');
  assertEquals((hit?.span?.end ?? 0) > (hit?.span?.start ?? 0), true);
});

Deno.test('a reply read by default: inspects structured output for canary leaks', () => {
  const canary = mintCanary();
  const verdict = enforce('All done.', canary, { answer: `the token is ${canary}` });
  assertEquals(verdict.action, 'block');
  assertEquals(rules(verdict).includes(DETECT_RULES.canary_leak), true);
});

Deno.test('a reply read by default: allows clean structured output', () => {
  assertEquals(enforce('All done.', mintCanary(), { answer: 42 }).action, 'allow');
});

Deno.test('eventPromptLeakHits names a leak in any provider-run step by its evidence kind', () => {
  const canary = mintCanary();
  const ran: ProviderEvent[] = [
    { type: 'grounding', grounding: { metadata: { query: canary } } },
    {
      type: 'evidence',
      evidence: { provider: 'google', kind: 'url_context', raw: { url: canary } },
    },
    {
      type: 'evidence',
      evidence: {
        provider: 'google',
        kind: 'code_execution_call',
        code: `print("${canary}")`,
        id: 'c1',
      },
    },
    {
      type: 'evidence',
      evidence: { provider: 'google', kind: 'code_execution_result', result: canary },
    },
    {
      type: 'evidence',
      evidence: {
        provider: 'openrouter',
        kind: 'provider_step',
        step: 'source',
        raw: { id: canary },
      },
    },
  ];
  for (const event of ran) {
    assertEquals(
      eventPromptLeakHits(event, { canary }).map((hit) => hit.rule),
      [EGRESS_RULES.providerToolLeak],
    );
  }
  const spoken: ProviderEvent = {
    type: 'evidence',
    evidence: { provider: 'google', kind: 'output_transcription', raw: { text: canary } },
  };
  assertEquals(
    eventPromptLeakHits(spoken, { canary }).some(
      (hit) => hit.rule === EGRESS_RULES.providerToolLeak,
    ),
    false,
  );
});
