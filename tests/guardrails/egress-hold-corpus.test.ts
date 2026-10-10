import '../fixtures/test-host.ts';
import { inboundFuzzPayloads } from '../../src/guardrails/corpus/inbound-payloads.ts';
import * as secrets from '../../src/guardrails/corpus/secrets.ts';
import * as strings from '../../src/guardrails/corpus/strings.ts';
import { injectionSpans } from '../../src/guardrails/injection.ts';
import { sensitiveSpans } from '../../src/guardrails/sensitive.ts';
import type { GuardrailContext } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { replyGate } from '../fixtures/detect.ts';
import { referenceMatchStart } from './egress-reference.ts';

const CONTEXT: GuardrailContext = { stage: 'live_outbound', trust: 'untrusted', profileId: 'live' };
const LEAD = 'Sure, here is what you asked for: ';
const TAIL = ' - hope that helps, let me know if there is anything else.';
/** One character at a time, a few words, and a long transcript chunk. */
const CHUNKS = [1, 7, 24];
/** Whitespace past any fixed hold, which the exact hold does not count. */
const PAD = ' '.repeat(400);

/** Every corpus string a detector matches, spoken inside a sentence. */
function egressCorpus(): Array<{ name: string; text: string; start: number }> {
  const named = [
    ...Object.entries(secrets),
    ...Object.entries(strings),
    ...inboundFuzzPayloads().map((payload) => [payload.name, payload.text] as const),
  ];
  return named.flatMap(([name, value]) => {
    if (typeof value !== 'string') return [];
    return [LEAD + value + TAIL, LEAD + value + PAD + TAIL].flatMap((text, padded) => {
      const blocked =
        sensitiveSpans(text, { network: false }).length + injectionSpans(text).length > 0;
      const start = referenceMatchStart(text);
      if (blocked !== start < Number.POSITIVE_INFINITY) {
        throw new Error(`${name}: the reference and the detectors disagree`);
      }
      return blocked ? [{ name: padded ? `${name} (padded)` : name, text, start }] : [];
    });
  });
}

/** How much from `start` on reached the host before the gate blocked, or `-1` if it never did. */
async function exposed(text: string, start: number, chunk: number): Promise<number> {
  const gate = replyGate(CONTEXT);
  let released = 0;
  for (let at = 0; at < text.length; at += chunk) {
    const result = await gate.process(text.slice(at, at + chunk));
    if (result.blocked) return Math.max(0, released - start);
    released += result.emit.length;
  }
  return (await gate.flush()).blocked ? Math.max(0, released - start) : -1;
}

Deno.test('a detector set to block at reply shows the host no character of any corpus match', async () => {
  const corpus = egressCorpus();
  assertEquals(corpus.length > 100, true);
  const leaks: string[] = [];
  for (const { name, text, start } of corpus) {
    for (const chunk of CHUNKS) {
      const shown = await exposed(text, start, chunk);
      if (shown !== 0) leaks.push(`${name} @${chunk}: ${shown}`);
    }
  }
  assertEquals(leaks, []);
});
