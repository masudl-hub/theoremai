import '../fixtures/test-host.ts';
import { inboundFuzzPayloads } from '../../src/guardrails/corpus/inbound-payloads.ts';
import * as secrets from '../../src/guardrails/corpus/secrets.ts';
import * as strings from '../../src/guardrails/corpus/strings.ts';
import { standardEgressEnforce } from '../../src/guardrails/egress.ts';
import { injectionSpans } from '../../src/guardrails/injection.ts';
import {
  createProgressiveYieldGate,
  LIVE_DEFAULT_HOLDBACK,
} from '../../src/guardrails/progressive-yield.ts';
import { sensitiveSpans } from '../../src/guardrails/sensitive.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

const CONTEXT: GuardrailContext = { stage: 'live_outbound', trust: 'untrusted', profileId: 'live' };
const LEAD = 'Sure, here is what you asked for: ';
const TAIL = ' - hope that helps, let me know if there is anything else.';
/** One character at a time, a few words, and a long transcript chunk. */
const CHUNKS = [1, 7, 24];

/** Every corpus string the bundled egress policy blocks, spoken inside a sentence. */
function egressCorpus(): Array<{ name: string; text: string; start: number; end: number }> {
  const named = [
    ...Object.entries(secrets),
    ...Object.entries(strings),
    ...inboundFuzzPayloads().map((payload) => [payload.name, payload.text] as const),
  ];
  return named.flatMap(([name, value]) => {
    if (typeof value !== 'string') return [];
    const text = LEAD + value + TAIL;
    const spans = [...sensitiveSpans(text, { network: false }), ...injectionSpans(text)];
    if (spans.length === 0) return [];
    const start = Math.min(...spans.map((span) => span.start));
    const end = Math.max(...spans.map((span) => span.end));
    return [{ name, text, start, end }];
  });
}

/** How much of `[start, end)` reached the host before the gate blocked, or `-1` if it never did. */
async function exposed(text: string, start: number, end: number, chunk: number): Promise<number> {
  const gate = createProgressiveYieldGate({
    context: CONTEXT,
    enforce: standardEgressEnforce,
    holdback: LIVE_DEFAULT_HOLDBACK,
  });
  let released = 0;
  for (let at = 0; at < text.length; at += chunk) {
    const result = await gate.process(text.slice(at, at + chunk));
    if (result.blocked) return Math.max(0, Math.min(released, end) - start);
    released += result.emit.length;
  }
  return (await gate.flush()).blocked ? Math.max(0, Math.min(released, end) - start) : -1;
}

Deno.test('LIVE_DEFAULT_HOLDBACK shows the host no character of any egress corpus match', async () => {
  const corpus = egressCorpus();
  assertEquals(corpus.length > 100, true);
  const leaks: string[] = [];
  for (const { name, text, start, end } of corpus) {
    for (const chunk of CHUNKS) {
      const shown = await exposed(text, start, end, chunk);
      if (shown !== 0) leaks.push(`${name} @${chunk}: ${shown}`);
    }
  }
  assertEquals(leaks, []);
});
