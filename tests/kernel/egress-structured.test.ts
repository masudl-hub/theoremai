import { runTurn } from '../fixtures/registered-runner.ts';
// Regression: the egress gate projected only `text` events, so a profile with
// `outputs.structured` had an empty string read and always passed.
import '../fixtures/test-host.ts';
import type { DetectAction, HostFind } from '../../src/guardrails/detectors.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { registerProfile, registerStructured } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

registerStructured('egressStructured', { jsonSchema: { type: 'object' } });

const SECRET = 'internal_tool_abc';

/** Every place `SECRET` is written in a text. */
const findSecret: HostFind = (text) =>
  [...text.matchAll(new RegExp(SECRET, 'g'))].map(({ index }) => ({
    start: index,
    end: index + SECRET.length,
  }));

/** The host's own detector for `SECRET`, with `action` on a reply's text and its structured output. */
function secretAt(action: DetectAction) {
  return {
    'test.tool': {
      label: 'Internal tool',
      at: { reply: action, reply_structured: action },
      find: findSecret,
    },
  };
}

/** Provider that answers only in structured output — no user-visible text. */
function structuredProvider(structured: unknown): ModelProvider {
  return {
    async *complete() {
      yield { type: 'structured', structured };
    },
  };
}

function registerStructuredEgressProfile(id: string, onBlock: 'refuse'): void {
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
        blockedReply: { onBlock },
        detect: secretAt('block'),
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

Deno.test('a reply detector reads structured output and blocks a leak carried only in JSON', async () => {
  registerStructuredEgressProfile('structured_egress_block', 'refuse');
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

Deno.test('a reply detector set to redact releases the reply without what it matched', async () => {
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
        blockedReply: { onBlock: 'retry' },
        detect: secretAt('redact'),
      },
    }),
  );
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'text', text: `I used ${SECRET} to look that up.` };
    },
  };
  const events = await collect('structured_egress_redact', provider);
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.text ?? '')
    .join('');

  assertEquals([text.startsWith('I used '), text.endsWith(' to look that up.')], [true, true]);
  assertEquals(text.includes(SECRET), false);
});

Deno.test('a reply detector releases structured output that carries no match', async () => {
  registerStructuredEgressProfile('structured_egress_pass', 'refuse');
  const events = await collect(
    'structured_egress_pass',
    structuredProvider({ answer: 'I looked it up.' }),
  );

  const structured = events.find((e) => e.type === 'structured')?.structured as
    | { answer?: string }
    | undefined;
  assertEquals(structured?.answer, 'I looked it up.');
});
