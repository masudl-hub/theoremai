import { projectGuardrailEvent } from '../../src/guardrails/hits.ts';
import type { GuardrailEvent } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

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
