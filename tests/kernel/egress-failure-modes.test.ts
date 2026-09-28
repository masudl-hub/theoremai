import '../fixtures/test-host.ts';
import { type LexiconOverrides, lexiconDefault } from '../../src/guardrails/lexicon.ts';
import type { EgressEnforcer, Verdict } from '../../src/guardrails/types.ts';
import { registerProfile, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { eventsOf, finalStop } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

function profile(
  id: string,
  enforce: EgressEnforcer,
  onBlock: 'refuse_to_user' | 'reject_to_agent' = 'refuse_to_user',
  maxRetries = 0,
  lexicon?: LexiconOverrides,
): void {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: 'failure_modes' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {},
      guardrails: {
        quota: { perDay: 50 },
        egress: { onBlock, maxRetries, enforce },
      },
      ...(lexicon ? { lexicon } : {}),
    }),
  );
}

function says(text: string): ModelProvider {
  return {
    async *complete() {
      yield { type: 'text', text };
    },
  };
}

async function collect(id: string, provider: ModelProvider): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const ev of runTurn({ profile: id, input: { text: 'q' } }, provider)) {
    events.push(ev);
  }
  return events;
}

const texts = (events: TurnEvent[]): string[] => eventsOf(events, 'text').map((e) => e.text ?? '');

const EGRESS_FILTERED = { kind: 'filtered', native: 'egress' };

/**
 * Regression: a policy that blocked on a mid-stream window but passed on the full
 * text left the turn with no output and no error — progressive yield had withheld
 * the text, and the attempt gate assumed it had already streamed.
 */
Deno.test('a mid-stream block followed by a passing final verdict releases the text', async () => {
  let call = 0;
  profile('fm_inconsistent', (): Verdict => {
    // First call is the mid-stream window; the second sees the whole attempt.
    return call++ === 0
      ? {
          action: 'block',
          hits: [{ rule: 'partial', severity: 'low' }],
          rejection: 'partial',
        }
      : { action: 'allow' };
  });

  const events = await collect('fm_inconsistent', says('the complete safe answer'));
  assertEquals(texts(events).join(''), 'the complete safe answer');
});

Deno.test('a policy blocking consistently still withholds', async () => {
  profile(
    'fm_consistent_block',
    (): Verdict => ({
      action: 'block',
      hits: [{ rule: 'always', severity: 'high' }],
      rejection: 'always blocked',
    }),
    'reject_to_agent',
    1,
  );

  const events = await collect('fm_consistent_block', says('leaky output'));
  assertEquals(
    texts(events).some((t) => t.includes('leaky')),
    false,
  );
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
  assertEquals(finalStop(events), EGRESS_FILTERED);
});

Deno.test('a policy that throws fails closed instead of killing the turn', async () => {
  profile('fm_throws', () => {
    throw new Error('classifier unreachable');
  });

  const events = await collect('fm_throws', says('sensitive answer'));
  assertEquals(texts(events), [lexiconDefault('egress.refusal')]);
});

Deno.test('a policy that throws can still be repaired against', async () => {
  let call = 0;
  profile(
    'fm_throws_repair',
    (): Verdict => {
      if (call++ < 2) {
        throw new Error('transient policy failure');
      }
      return { action: 'allow' };
    },
    'reject_to_agent',
    3,
  );

  const events = await collect('fm_throws_repair', says('answer'));
  assertEquals(texts(events).join(''), 'answer');
});

Deno.test('refuse_to_user shows the lexicon refusal, never policy text', async () => {
  profile(
    'fm_default_copy',
    (): Verdict => ({
      action: 'block',
      hits: [{ rule: 'leak', severity: 'high' }],
      rejection: 'blocked',
    }),
  );

  const events = await collect('fm_default_copy', says('leaky'));
  assertEquals(texts(events), [lexiconDefault('egress.refusal')]);
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
  assertEquals(finalStop(events), EGRESS_FILTERED);
});

Deno.test('refuse_to_user shows the profile lexicon refusal', async () => {
  profile(
    'fm_profile_copy',
    (): Verdict => ({
      action: 'block',
      hits: [{ rule: 'leak', severity: 'high' }],
      rejection: 'blocked',
    }),
    'refuse_to_user',
    0,
    { 'egress.refusal': 'I cannot share that.' },
  );

  const events = await collect('fm_profile_copy', says('leaky'));
  assertEquals(texts(events), ['I cannot share that.']);
  assertEquals(finalStop(events), EGRESS_FILTERED);
});

Deno.test('final egress inspects reply text, not thoughts', async () => {
  profile(
    'fm_thought_leak',
    ({ text }): Verdict =>
      text.includes('secret-thought')
        ? {
            action: 'block',
            hits: [{ rule: 'thought_leak', severity: 'high' }],
            rejection: 'thought leaked',
          }
        : { action: 'allow' },
  );

  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'thought', text: 'secret-thought' };
      yield { type: 'text', text: 'safe visible text' };
    },
  };

  const events = await collect('fm_thought_leak', provider);
  assertEquals(texts(events), ['safe visible text']);
  assertEquals(
    eventsOf(events, 'thought').map((e) => e.text),
    ['secret-thought'],
  );
});

/** Regression: media streamed live was yielded again when the attempt passed. */
Deno.test('a passing attempt delivers streamed media once', async () => {
  profile('fm_media_once', (): Verdict => ({ action: 'allow' }));
  const media: TurnEvent = { type: 'media', media: { mimeType: 'image/png', data: 'AAAA' } };
  const provider: ModelProvider = {
    async *complete() {
      yield media;
      yield { type: 'text', text: 'here it is' };
    },
  };
  const events = await collect('fm_media_once', provider);
  assertEquals(eventsOf(events, 'media').length, 1);
  assertEquals(texts(events), ['here it is']);
});

Deno.test('thoughts keep streaming after a mid-stream block withholds the reply', async () => {
  profile(
    'fm_thought_after_block',
    ({ text }): Verdict =>
      text.includes('leak')
        ? {
            action: 'block',
            hits: [{ rule: 'leak', severity: 'high' }],
            rejection: 'leak',
          }
        : { action: 'allow' },
  );
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'text', text: 'leak' };
      yield { type: 'thought', text: 'still thinking' };
    },
  };
  const events = await collect('fm_thought_after_block', provider);
  assertEquals(
    eventsOf(events, 'thought').map((e) => e.text),
    ['still thinking'],
  );
  assertEquals(texts(events), [lexiconDefault('egress.refusal')]);
});
