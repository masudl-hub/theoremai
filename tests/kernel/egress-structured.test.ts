/**
 * Regression: the egress gate projected only `text` events, so a profile with
 * `outputs.structured` handed its policy an empty string and always passed.
 * Structured output now travels in the outbound payload.
 */
import '../fixtures/test-host.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import type { Verdict } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerStructured } from '../../src/kernel/registry/schemas.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

registerStructured('egressStructured', { jsonSchema: { type: 'object' } });

const SECRET = 'internal_tool_abc';

/** Provider that answers only in structured output — no user-visible text. */
function structuredProvider(structured: unknown): ModelProvider {
  return {
    async *complete() {
      yield { type: 'structured', structured };
    },
  };
}

function registerStructuredEgressProfile(id: string, onBlock: 'refuse_to_user'): void {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'structured_egress' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: 'egressStructured' },
      guardrails: {
        quota: { perDay: 50 },
        egress: {
          onBlock,
          enforce: (payload): Verdict => {
            const seen = `${payload.text}${JSON.stringify(payload.structured ?? null)}`;
            if (seen.includes(SECRET)) {
              return {
                action: 'block',
                hits: [{ rule: 'internal_tool_name', severity: 'high' }],
                rejection: 'Do not mention internal tool names.',
              };
            }
            return { action: 'allow' };
          },
        },
      },
    }),
  );
}

async function collect(profile: string, provider: ModelProvider): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile, input: { text: 'How did you do that?' } }, provider)) {
    events.push(ev);
  }
  return events;
}

Deno.test('egress inspects structured output and blocks a leak carried only in JSON', async () => {
  registerStructuredEgressProfile('structured_egress_block', 'refuse_to_user');
  const events = await collect(
    'structured_egress_block',
    structuredProvider({ answer: `I used ${SECRET} to look that up.` }),
  );

  assertEquals(
    events.some((e) => e.type === 'structured'),
    false,
  );
  assertEquals(events.find((e) => e.type === 'text')?.text, lexiconDefault('egress.refusal'));
});

Deno.test('egress redact releases the policy text in place of the model output', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'structured_egress_redact',
      identity: { handle: 'structured_egress' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {},
      guardrails: {
        quota: { perDay: 50 },
        egress: {
          onBlock: 'reject_to_agent',
          enforce: (payload): Verdict =>
            payload.text.includes(SECRET)
              ? {
                  action: 'redact',
                  text: 'I used an internal lookup.',
                  hits: [{ rule: 'internal_tool_name', severity: 'medium' }],
                }
              : { action: 'allow' },
        },
      },
    }),
  );
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'text', text: `I used ${SECRET} to look that up.` };
    },
  };
  const events = await collect('structured_egress_redact', provider);
  const texts = events.filter((e) => e.type === 'text').map((e) => e.text);

  assertEquals(texts.includes('I used an internal lookup.'), true);
  assertEquals(
    texts.some((t) => (t ?? '').includes(SECRET)),
    false,
  );
});

Deno.test('egress releases structured output that carries no disclosure', async () => {
  registerStructuredEgressProfile('structured_egress_pass', 'refuse_to_user');
  const events = await collect(
    'structured_egress_pass',
    structuredProvider({ answer: 'I looked it up.' }),
  );

  const structured = events.find((e) => e.type === 'structured')?.structured as
    | { answer?: string }
    | undefined;
  assertEquals(structured?.answer, 'I looked it up.');
});
