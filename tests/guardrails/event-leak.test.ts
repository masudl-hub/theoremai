import { mintCanary } from '../../src/guardrails/canary.ts';
import { type DetectSpec, resolveDetect } from '../../src/guardrails/detectors.ts';
import { eventLeak } from '../../src/guardrails/egress.ts';
import { DETECT_RULES, EGRESS_RULES } from '../../src/guardrails/rules.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import type { ModelEvent } from '../../src/kernel/types.ts';

const SYSTEM = [
  'You are Sol, the support agent for Northwind Outfitters.',
  'Only discuss orders, returns, and shipping; never mention internal tooling.',
  'Escalate refunds above 200 dollars to a human and apologise once, briefly.',
].join(' ');
const ECHO = SYSTEM.split(' ').slice(3, 16).join(' ');
const canary = mintCanary();
const scope = { canary, privateSystem: [SYSTEM] };

const text = (value: string): ModelEvent => ({ type: 'text', text: value });

/** `eventLeak` under a matrix that sets the canary and the prompt echo at both reply boundaries. */
function leakUnder(
  event: ModelEvent,
  canaryAt: 'ignore' | 'flag' | 'block',
  promptAt: 'ignore' | 'flag' | 'block',
  boundary: 'reply' | 'live_reply' = 'reply',
  turn: Parameters<typeof eventLeak>[1] = scope,
) {
  const detect: DetectSpec = {
    canary_leak: { at: { [boundary]: canaryAt } },
    prompt_leak: { at: { [boundary]: promptAt } },
  };
  return eventLeak(event, turn, resolveDetect(detect), boundary);
}

const rules = (leak: ReturnType<typeof eventLeak>) => leak?.hits.map(({ rule }) => rule);

Deno.test('eventLeak stops on a canary in an event, naming the canary rule', () => {
  const leak = leakUnder(text(`it is ${canary}`), 'block', 'block');
  assertEquals(leak?.stop, true);
  assertEquals(rules(leak), [DETECT_RULES.canary_leak]);
});

Deno.test('eventLeak stops on a prompt echo in an event, naming the prompt rule', () => {
  const leak = leakUnder(text(`Sure: ${ECHO}`), 'block', 'block');
  assertEquals(leak?.stop, true);
  assertEquals(rules(leak), [DETECT_RULES.prompt_leak]);
});

Deno.test('eventLeak reports a canary and an echo in one event as two hits, canary first', () => {
  const leak = leakUnder(text(`${canary} ${ECHO}`), 'block', 'block');
  assertEquals(rules(leak), [DETECT_RULES.canary_leak, DETECT_RULES.prompt_leak]);
});

Deno.test('eventLeak finds nothing in an event that holds neither', () => {
  assertEquals(leakUnder(text('A plain reply about shipping.'), 'block', 'block'), undefined);
});

Deno.test('eventLeak reports a leak set to flag but does not stop on it', () => {
  const canaryLeak = leakUnder(text(canary), 'flag', 'block');
  assertEquals([canaryLeak?.stop, rules(canaryLeak)], [false, [DETECT_RULES.canary_leak]]);
  const promptLeak = leakUnder(text(ECHO), 'block', 'flag');
  assertEquals([promptLeak?.stop, rules(promptLeak)], [false, [DETECT_RULES.prompt_leak]]);
});

Deno.test('eventLeak stops when either leak is above flag, whichever the other is', () => {
  assertEquals(leakUnder(text(`${canary} ${ECHO}`), 'flag', 'block')?.stop, true);
  assertEquals(leakUnder(text(`${canary} ${ECHO}`), 'block', 'flag')?.stop, true);
  assertEquals(leakUnder(text(`${canary} ${ECHO}`), 'flag', 'flag')?.stop, false);
});

Deno.test('eventLeak reads a detector set to ignore as no leak', () => {
  assertEquals(leakUnder(text(canary), 'ignore', 'block'), undefined);
  assertEquals(leakUnder(text(ECHO), 'block', 'ignore'), undefined);
  const only = leakUnder(text(`${canary} ${ECHO}`), 'ignore', 'block');
  assertEquals(rules(only), [DETECT_RULES.prompt_leak]);
  const other = leakUnder(text(`${canary} ${ECHO}`), 'block', 'ignore');
  assertEquals(rules(other), [DETECT_RULES.canary_leak]);
});

Deno.test('eventLeak reads the action at the boundary it is asked for', () => {
  const detect = resolveDetect({
    canary_leak: { at: { reply: 'block', live_reply: 'ignore' } },
    prompt_leak: { at: { reply: 'block', live_reply: 'ignore' } },
  });
  const event = text(`${canary} ${ECHO}`);
  assertEquals(eventLeak(event, scope, detect, 'live_reply'), undefined);
  assertEquals(eventLeak(event, scope, detect, 'reply')?.stop, true);
});

Deno.test('eventLeak ignores a canary the turn was given', () => {
  assertEquals(
    leakUnder(text(canary), 'block', 'block', 'reply', { ...scope, canaryGiven: true }),
    undefined,
  );
});

Deno.test('eventLeak reads nothing of a turn without a canary or a private system', () => {
  assertEquals(leakUnder(text(`${canary} ${ECHO}`), 'block', 'block', 'reply', {}), undefined);
});

Deno.test('eventLeak does not read a thought, which the thought guard reads', () => {
  const thought: ModelEvent = { type: 'thought', text: `${canary} ${ECHO}` };
  assertEquals(leakUnder(thought, 'block', 'block'), undefined);
});

Deno.test('eventLeak reads the content of an event that is not text', () => {
  const structured: ModelEvent = { type: 'structured', structured: { note: canary } };
  assertEquals(leakUnder(structured, 'block', 'block')?.stop, true);
});

Deno.test('a provider tool report that carries a leak stops under any action', () => {
  const report: ModelEvent = {
    type: 'evidence',
    evidence: { kind: 'code_execution_call', code: `print("${canary}")` },
  } as ModelEvent;
  for (const action of ['ignore', 'flag', 'block'] as const) {
    const leak = leakUnder(report, action, action);
    assertEquals(
      [action, leak?.stop, rules(leak)],
      [action, true, [EGRESS_RULES.providerToolLeak]],
    );
  }
});

Deno.test('a provider tool report with no leak is let through', () => {
  const report: ModelEvent = {
    type: 'evidence',
    evidence: { kind: 'code_execution_call', code: 'print(1)' },
  } as ModelEvent;
  assertEquals(leakUnder(report, 'block', 'block'), undefined);
  const grounding = { type: 'grounding', grounding: { queries: ['weather'] } } as ModelEvent;
  assertEquals(leakUnder(grounding, 'block', 'block'), undefined);
});

Deno.test('a provider tool report names the prompt echo it carries as the provider leak', () => {
  const report = { type: 'grounding', grounding: { queries: [ECHO] } } as ModelEvent;
  assertEquals(rules(leakUnder(report, 'ignore', 'ignore')), [EGRESS_RULES.providerToolLeak]);
});
