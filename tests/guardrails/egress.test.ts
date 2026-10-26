import '../fixtures/test-host.ts';
import { mintCanary, USER_CLOSE, USER_OPEN } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { scopeOf } from '../../src/guardrails/detect-at.ts';
import { readReply } from '../../src/guardrails/detect-reply.ts';
import { eventPromptLeakHits } from '../../src/guardrails/egress.ts';
import { retryRejection } from '../../src/guardrails/hints.ts';
import { labelDefault } from '../../src/guardrails/labels.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import type { GuardrailContext, OutboundPayload } from '../../src/guardrails/types.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import type { ModelEvent } from '../../src/kernel/types.ts';
import { TAKE_OUT_LEAKS } from '../fixtures/leaks.ts';

function egressCtx(canary?: string): GuardrailContext {
  return {
    stage: 'output_final',
    trust: 'untrusted',
    profileId: 'chat',
    ...(canary ? { canary } : {}),
  };
}

/** A profile that takes out what it must not give away. */
const POLICY = resolveGuardrailPolicy({ detect: TAKE_OUT_LEAKS });

/** What a finished reply crosses as, read as the runner reads it under `policy`. */
interface Crossing {
  action: 'allow' | 'flag' | 'redact' | 'block';
  rules: string[];
  text: string;
  structured?: unknown;
  rejection?: string;
}

function enforce(text: string, canary?: string, structured?: unknown, policy = POLICY): Crossing {
  const payload: OutboundPayload = {
    text,
    ...(structured !== undefined ? { structured } : {}),
  };
  const read = readReply(payload, policy.detect, {
    boundary: 'reply',
    scope: scopeOf(policy, egressCtx(canary)),
  });
  const rules = read.events.flatMap((event) => event.hits.map((hit) => hit.rule));
  const action = read.blocked
    ? 'block'
    : read.events.some((event) => event.action === 'redact')
      ? 'redact'
      : read.events.some((event) => event.action === 'flag')
        ? 'flag'
        : 'allow';
  return {
    action,
    rules,
    text: read.payload.text,
    ...(read.payload.structured !== undefined ? { structured: read.payload.structured } : {}),
    ...(read.blocked ? { rejection: retryRejection(read.blocked, policy.detect) } : {}),
  };
}

/** `leak` was found under `rule` and taken out of the reply's text. */
function takenOut(crossing: Crossing, rule: string, leak: string): void {
  assertEquals(crossing.action, 'redact');
  assertEquals(crossing.rules.includes(rule), true);
  assertEquals(crossing.text.includes(leak), false);
}

Deno.test('a reply read by default: flags a canary and a marker and keeps the text', () => {
  const policy = resolveGuardrailPolicy(undefined);
  const canary = mintCanary();
  const text = `The token is ${canary} ${USER_OPEN}`;
  const read = readReply({ text }, policy.detect, {
    boundary: 'reply',
    reportedTo: 0,
    scope: scopeOf(policy, egressCtx(canary)),
  });
  assertEquals(
    read.events.map((event) => [event.action, event.hits.map((hit) => hit.rule).sort()]),
    [['flag', [DETECT_RULES.canary_leak, DETECT_RULES.marker_leak].sort()]],
  );
  assertEquals(read.payload.text, text);
  assertEquals(read.blocked, undefined);
});

Deno.test('a reply that takes out leaks: allows benign assistant text', () => {
  assertEquals(enforce('Hello! How can I help?', mintCanary()).action, 'allow');
});

Deno.test('a reply that takes out leaks: takes out a literal canary and keeps the rest', () => {
  const canary = mintCanary();
  const crossing = enforce(`The token is ${canary}`, canary);
  takenOut(crossing, DETECT_RULES.canary_leak, canary);
  assertStringIncludes(crossing.text, 'The token is ');
});

Deno.test('a reply that takes out leaks: sensitive data and injection text are not what stops it', () => {
  assertEquals(enforce(`Your key is ${TEST_OPENAI_KEY}`, mintCanary()).action === 'block', false);
  assertEquals(enforce(INJ_IGNORE, mintCanary()).action, 'allow');
  assertEquals(
    enforce('All done.', mintCanary(), { key: TEST_OPENAI_KEY }).action === 'block',
    false,
  );
});

Deno.test('a reply that takes out leaks: releases IP addresses: they are not secrets', () => {
  const reply =
    'Your router is usually 192.168.1.1; IPv6 looks like 2001:0db8:85a3:0000:0000:8a2e:0370:7334.';
  assertEquals(enforce(reply, mintCanary()).action, 'allow');
});

Deno.test('a reply that takes out leaks: takes out system boundary markers', () => {
  takenOut(
    enforce('leak: <user_data>secret</user_data>', mintCanary()),
    DETECT_RULES.marker_leak,
    '<user_data>',
  );
});

Deno.test('a reply that takes out leaks: takes out user_data fence markers', () => {
  takenOut(enforce(`leaked ${USER_OPEN}`, mintCanary()), DETECT_RULES.marker_leak, USER_OPEN);
});

Deno.test('a reply that takes out leaks: reports multiple hit kinds', () => {
  const canary = mintCanary();
  const crossing = enforce(`${USER_OPEN} ${canary}`, canary);
  assertEquals(crossing.action, 'redact');
  assertEquals(new Set(crossing.rules).size >= 2, true);
});

Deno.test('a reply that takes out leaks: passes empty text without blocking', () => {
  assertEquals(enforce('', mintCanary()).action, 'allow');
});

Deno.test('a reply a profile blocks on: the rejection names all blocked categories', () => {
  const canary = mintCanary();
  const policy = resolveGuardrailPolicy({ detect: { canary_leak: 'block', marker_leak: 'block' } });
  const crossing = enforce(`${canary} ${USER_OPEN}`, canary, undefined, policy);
  assertEquals(crossing.action, 'block');
  assertStringIncludes(crossing.rejection ?? '', labelDefault('detect.hint.canary_leak'));
  assertStringIncludes(crossing.rejection ?? '', labelDefault('detect.hint.marker_leak'));
});

Deno.test('a reply that takes out leaks: takes out "This turn\\u2019s canary is" boundary marker in text', () => {
  takenOut(
    enforce("This turn's canary is abc", mintCanary()),
    DETECT_RULES.marker_leak,
    "This turn's canary is",
  );
});

Deno.test('a reply that takes out leaks: takes out the default canary note words in text', () => {
  takenOut(
    enforce('Your canary token is abc', mintCanary()),
    DETECT_RULES.marker_leak,
    'Your canary token is',
  );
});

Deno.test('a reply that takes out leaks: without canary: no canary hit on a hex token', () => {
  assertEquals(
    enforce('deadbeeffeedfacecafebabecafebabe').rules.includes(DETECT_RULES.canary_leak),
    false,
  );
});

Deno.test('a reply that takes out leaks: takes out closing user_data fence tag', () => {
  takenOut(enforce(`leaked ${USER_CLOSE}`, mintCanary()), DETECT_RULES.marker_leak, USER_CLOSE);
});

Deno.test('a reply that takes out leaks: finds a fence tag without its closing bracket', () => {
  // A gemma-4-31b thought restarted mid-tag, leaving `<user_data` run into the next sentence.
  for (const text of ['inside `<user_dataThe user provided', 'see < /user_data here']) {
    assertEquals(enforce(text, mintCanary()).rules.includes(DETECT_RULES.marker_leak), true);
  }
});

Deno.test('a reply that takes out leaks: carries span offsets on its hits', () => {
  const text = `leaked ${USER_OPEN}`;
  const read = readReply({ text }, POLICY.detect, {
    boundary: 'reply',
    scope: scopeOf(POLICY, egressCtx(mintCanary())),
  });
  const hit = read.events
    .flatMap((event) => event.hits)
    .find((h) => h.rule === DETECT_RULES.marker_leak);
  assertEquals(hit?.severity, 'high');
  assertEquals(typeof hit?.span?.start, 'number');
  assertEquals((hit?.span?.end ?? 0) > (hit?.span?.start ?? 0), true);
});

Deno.test('a reply that takes out leaks: takes a canary out of structured output', () => {
  const canary = mintCanary();
  const crossing = enforce('All done.', canary, { answer: `the token is ${canary}` });
  assertEquals(crossing.action, 'redact');
  assertEquals(crossing.rules.includes(DETECT_RULES.canary_leak), true);
  assertEquals(JSON.stringify(crossing.structured).includes(canary), false);
});

Deno.test('a reply that takes out leaks: allows clean structured output', () => {
  assertEquals(enforce('All done.', mintCanary(), { answer: 42 }).action, 'allow');
});

Deno.test('eventPromptLeakHits names a leak in any provider-run step by its evidence kind', () => {
  const canary = mintCanary();
  const ran: ModelEvent[] = [
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
  const spoken: ModelEvent = {
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
