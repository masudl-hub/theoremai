import '../fixtures/test-host.ts';
import { HOST_FIND_HOLD, type HostFind } from '../../src/guardrails/detectors.ts';
import { type LexiconOverrides, lexiconDefault } from '../../src/guardrails/lexicon.ts';
import { registerProfile, runTurn } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { eventsOf, finalStop } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

/** A profile with one detector of the host's own, which blocks a reply where `find` matches. */
function profile(
  id: string,
  find: HostFind,
  onBlock: 'refuse' | 'retry' = 'refuse',
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
        blockedReply: { onBlock, maxRetries },
        detect: { 'test.own': { label: 'Test', at: { reply: 'block' }, find } },
      },
      ...(lexicon ? { lexicon } : {}),
    }),
  );
}

/** A `find` that matches all of any text. */
const findAll: HostFind = (text) => (text ? [{ start: 0, end: text.length }] : []);

/** A `find` that matches all of a text `matches` is true of. */
function findWhere(matches: (text: string) => boolean): HostFind {
  return (text) => (matches(text) ? [{ start: 0, end: text.length }] : []);
}

function says(...chunks: string[]): ModelProvider {
  return {
    async *complete() {
      for (const text of chunks) yield { type: 'text', text };
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
 * Regression: a reply that matched on a mid-stream window but not as a whole left the turn with
 * no output and no error: the stream had withheld the text, and the attempt gate assumed it had
 * already streamed.
 */
Deno.test('a mid-stream block followed by a passing final verdict releases the text', async () => {
  // The opening alone is a match; the reply it grows into is not.
  profile(
    'fm_inconsistent',
    findWhere((text) => !text.includes('answer')),
  );
  // Longer than a reply holds for a `find`, so some of it comes up for release as it streams.
  const opening = 'x'.repeat(HOST_FIND_HOLD + 40);

  const events = await collect('fm_inconsistent', says(opening, ' the complete safe answer'));
  assertEquals(texts(events).join(''), `${opening} the complete safe answer`);
});

Deno.test('a detector blocking consistently still withholds', async () => {
  profile('fm_consistent_block', findAll, 'retry', 1);

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

Deno.test('a find that throws fails closed instead of killing the turn', async () => {
  profile('fm_throws', () => {
    throw new Error('classifier unreachable');
  });

  const events = await collect('fm_throws', says('sensitive answer'));
  assertEquals(texts(events), [lexiconDefault('egress.refusal')]);
});

Deno.test('a find that throws can still be repaired against', async () => {
  let call = 0;
  profile(
    'fm_throws_repair',
    () => {
      if (call++ < 2) {
        throw new Error('transient failure');
      }
      return [];
    },
    'retry',
    3,
  );

  const events = await collect('fm_throws_repair', says('answer'));
  assertEquals(texts(events).join(''), 'answer');
});

Deno.test('onBlock refuse shows the lexicon refusal', async () => {
  profile('fm_default_copy', findAll);

  const events = await collect('fm_default_copy', says('leaky'));
  assertEquals(texts(events), [lexiconDefault('egress.refusal')]);
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
  assertEquals(finalStop(events), EGRESS_FILTERED);
});

Deno.test('onBlock refuse shows the profile lexicon refusal', async () => {
  profile('fm_profile_copy', findAll, 'refuse', 0, { 'egress.refusal': 'I cannot share that.' });

  const events = await collect('fm_profile_copy', says('leaky'));
  assertEquals(texts(events), ['I cannot share that.']);
  assertEquals(finalStop(events), EGRESS_FILTERED);
});

Deno.test('a detector that reads the reply reads its text, not its thoughts', async () => {
  profile(
    'fm_thought_leak',
    findWhere((text) => text.includes('secret-thought')),
  );

  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'thought', text: 'secret-thought' };
      yield { type: 'text', text: 'safe visible text' };
    },
  };

  const events = await collect('fm_thought_leak', provider);
  assertEquals(texts(events), ['safe visible text']);
  // The thought guard, on by default, releases a thought in pieces.
  assertEquals(
    eventsOf(events, 'thought')
      .map((e) => e.text ?? '')
      .join(''),
    'secret-thought',
  );
});

/** Regression: media streamed live was yielded again when the attempt passed. */
Deno.test('a passing attempt delivers streamed media once', async () => {
  profile('fm_media_once', () => []);
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

Deno.test('thoughts keep streaming after a block withholds the reply', async () => {
  profile(
    'fm_thought_after_block',
    findWhere((text) => text.includes('leak')),
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
