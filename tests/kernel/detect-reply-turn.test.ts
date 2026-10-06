import '../fixtures/test-host.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { registerProfile, registerStructured, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { readAt } from '../fixtures/detect.ts';
import { eventsOf, finalStop, lastOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { replyText } from '../fixtures/reply.ts';

registerStructured('detectReply', { jsonSchema: { type: 'object' } });

const KEY = TEST_OPENAI_KEY;
const TEXT = `Sure. The key is ${KEY} and that is all I have for you today.`;
const PLACEHOLDER = readAt(KEY, 'reply', { credentials: 'redact' }).text ?? '';

/** A turn of a profile with `detect`, answered by `reply`: its events. */
async function turn(
  id: string,
  detect: Exclude<DetectSpec, string>,
  reply: TurnEvent[],
  extras: { structured?: boolean; refuse?: boolean } = {},
): Promise<TurnEvent[]> {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'detect_reply' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: extras.structured ? { structured: 'detectReply' } : {},
      guardrails: {
        quota: { perDay: 50 },
        detect: { ...detect, canary_leak: 'ignore', prompt_leak: 'ignore' },
        blockedReply: extras.refuse ? { onBlock: 'refuse' } : { maxRetries: 0 },
      },
    }),
  );
  const provider: ModelProvider = {
    async *complete() {
      await Promise.resolve();
      yield* reply;
    },
  };
  return await Array.fromAsync(runTurn({ profile: id, input: { text: 'hi' } }, provider));
}

/** The text as a model streams it: a few words at a time. */
function said(text: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (let at = 0; at < text.length; at += 9) {
    events.push({ type: 'text', text: text.slice(at, at + 9) });
  }
  return events;
}

function guardrails(events: readonly TurnEvent[]): string[] {
  return eventsOf(events, 'guardrail').map(
    ({ guardrail }) => `${guardrail.stage} ${guardrail.boundary} ${guardrail.action}`,
  );
}

Deno.test('a reply is not read by default: the key reaches the user and nothing is reported', async () => {
  const events = await turn('detect_reply_default', {}, said(TEXT));
  assertEquals([replyText(events), guardrails(events)], [TEXT, []]);
});

Deno.test('flag at reply: the reply reaches the user as written, with one report', async () => {
  const events = await turn(
    'detect_reply_flag',
    { credentials: { at: { reply: 'flag' } } },
    said(TEXT),
  );
  assertEquals([replyText(events), guardrails(events)], [TEXT, ['output_delta reply flag']]);
});

Deno.test('redact at reply: the user sees the placeholder, streamed in place of the key', async () => {
  const detect: DetectSpec = { credentials: { at: { reply: 'redact' } } };
  const events = await turn('detect_reply_redact', detect, said(TEXT));
  assertEquals(
    [replyText(events), guardrails(events)],
    [TEXT.replace(KEY, PLACEHOLDER), ['output_delta reply redact']],
  );
});

Deno.test('block at reply: the reply stops before the key and the turn says it was withheld', async () => {
  const events = await turn(
    'detect_reply_block',
    { credentials: { at: { reply: 'block' } } },
    said(TEXT),
  );
  assertEquals(replyText(events).includes(KEY), false);
  assertEquals(guardrails(events), ['output_final reply block']);
  assertEquals(lastOf(events, 'error')?.errorKind, 'safety');
  assertEquals(finalStop(events)?.kind, 'filtered');
});

Deno.test('block at reply with blockedReply refuse: the user reads the refusal', async () => {
  const detect: DetectSpec = { credentials: { at: { reply: 'block' } } };
  const events = await turn('detect_reply_refuse', detect, said(TEXT), { refuse: true });
  assertEquals(replyText(events).endsWith(lexiconDefault('egress.refusal')), true);
  assertEquals(replyText(events).includes(KEY), false);
});

Deno.test('redact at reply_structured: the structured output crosses with the key replaced', async () => {
  const detect: DetectSpec = { credentials: { at: { reply_structured: 'redact' } } };
  const structured = { answer: `the key is ${KEY}`, count: 2 };
  const events = await turn(
    'detect_structured_redact',
    detect,
    [{ type: 'structured', structured }],
    {
      structured: true,
    },
  );
  assertEquals(
    eventsOf(events, 'structured').map((event) => event.structured),
    [{ answer: `the key is ${PLACEHOLDER}`, count: 2 }],
  );
  assertEquals(guardrails(events), ['output_final reply_structured redact']);
});

Deno.test('block at reply_structured: no structured output crosses', async () => {
  const detect: DetectSpec = { credentials: { at: { reply_structured: 'block' } } };
  const structured = { answer: `the key is ${KEY}` };
  const events = await turn(
    'detect_structured_block',
    detect,
    [{ type: 'structured', structured }],
    {
      structured: true,
    },
  );
  assertEquals(eventsOf(events, 'structured'), []);
  assertEquals(guardrails(events), ['output_final reply_structured block']);
});
