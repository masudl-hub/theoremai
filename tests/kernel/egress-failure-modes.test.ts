/**
 * Failure modes of the egress gate: nothing is dropped without a signal, a policy
 * that throws fails closed instead of killing the turn, and a refusal with no copy
 * emits an error rather than an empty text turn.
 */
import '../fixtures/test-host.ts';
import type { EgressEnforcer, Verdict } from '../../src/guardrails/types.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

function profile(
  id: string,
  enforce: EgressEnforcer,
  onBlock: 'refuse_to_user' | 'reject_to_agent' = 'refuse_to_user',
  maxRetries = 0,
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

const texts = (events: TurnEvent[]): string[] =>
  events.filter((e) => e.type === 'text').map((e) => e.text ?? '');

const EGRESS_FILTERED = { kind: 'filtered', native: 'egress' };
const stopOf = (events: TurnEvent[]) => events.findLast((e) => e.type === 'done')?.stop;

// ── nothing is dropped silently ──────────────────────────────────────────────

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
  assertEquals(stopOf(events), EGRESS_FILTERED);
});

// ── a policy that throws ─────────────────────────────────────────────────────

Deno.test('a policy that throws fails closed instead of killing the turn', async () => {
  profile('fm_throws', () => {
    throw new Error('classifier unreachable');
  });

  const events = await collect('fm_throws', says('sensitive answer'));
  assertEquals(
    texts(events).some((t) => t.includes('sensitive answer')),
    false,
  );
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
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

// ── refusal with no copy ─────────────────────────────────────────────────────

Deno.test('refuse_to_user without refusal copy emits an error, never an empty text turn', async () => {
  profile(
    'fm_no_copy',
    (): Verdict => ({
      action: 'block',
      hits: [{ rule: 'leak', severity: 'high' }],
      rejection: 'blocked',
    }),
  );

  const events = await collect('fm_no_copy', says('leaky'));
  assertEquals(texts(events), []);
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
  assertEquals(stopOf(events), EGRESS_FILTERED);
});

Deno.test('refuse_to_user with refusal copy emits exactly that copy', async () => {
  profile(
    'fm_with_copy',
    (): Verdict => ({
      action: 'block',
      hits: [{ rule: 'leak', severity: 'high' }],
      rejection: 'blocked',
      refusal: 'I cannot share that.',
    }),
  );

  const events = await collect('fm_with_copy', says('leaky'));
  assertEquals(texts(events), ['I cannot share that.']);
  assertEquals(stopOf(events), EGRESS_FILTERED);
});

Deno.test('legacy egress blocked verdict with text is treated as refusal copy', async () => {
  profile('fm_legacy_copy', (() => ({
    blocked: true,
    text: 'Legacy refusal.',
    hits: ['legacy'],
    rejectionMessage: 'blocked',
  })) as unknown as EgressEnforcer);

  const events = await collect('fm_legacy_copy', says('leaky'));
  assertEquals(texts(events), ['Legacy refusal.']);
  assertEquals(
    events.some((e) => e.type === 'error'),
    false,
  );
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
            refusal: 'I cannot share that.',
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
    events.filter((e) => e.type === 'thought').map((e) => e.text),
    ['secret-thought'],
  );
});

// ── what streams live is delivered once ──────────────────────────────────────

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
  assertEquals(events.filter((e) => e.type === 'media').length, 1);
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
            refusal: 'I cannot share that.',
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
    events.filter((e) => e.type === 'thought').map((e) => e.text),
    ['still thinking'],
  );
  assertEquals(texts(events), ['I cannot share that.']);
});
