import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { foldTurnEvents } from '../../src/interface/blocks.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import { keptReply } from '../../src/kernel/turn-events.ts';
import type {
  ModelProvider,
  ProfileValidationSpec,
  TurnEvent,
  TurnEventOf,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const REPLY = {
  type: 'object',
  properties: { title: { type: 'string' }, claims: { type: 'array', items: { type: 'object' } } },
  required: ['title'],
};

/** A scope with one profile whose replies `validation` checks. */
function scopeWith(validation: ProfileValidationSpec): KernelScope {
  const scope = createTestKernelScope();
  scope.schemas.register('attempts_reply', { jsonSchema: REPLY });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: 'attempts',
      identity: { handle: 'attempts' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: 'attempts_reply', validation },
    }),
  );
  return scope;
}

const titled = (title: unknown) =>
  title === 'good' ? { isValid: true } : { isValid: false, error: 'the title is not good' };

/** Answers each call with the next of `replies`, as text and then structured. */
function provider(replies: unknown[]): ModelProvider {
  let call = 0;
  return {
    async *complete() {
      await Promise.resolve();
      const reply = replies[Math.min(call++, replies.length - 1)];
      yield { type: 'text', text: JSON.stringify(reply) };
      yield { type: 'structured', structured: reply };
    },
  };
}

async function run(scope: KernelScope, model: ModelProvider): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of runScopedTurn(
    scope,
    { profile: 'attempts', input: { text: 'Help' } },
    model,
  )) {
    events.push(event);
  }
  return events;
}

const of = <K extends TurnEvent['type']>(events: readonly TurnEvent[], type: K) =>
  events.filter((e): e is TurnEventOf<K> => e.type === type);

Deno.test('a retried reply is marked, and only the kept attempt folds', async () => {
  const events = await run(
    scopeWith({ fields: { title: titled }, maxRetries: 2 }),
    provider([{ title: 'bad' }, { title: 'good' }]),
  );
  const attempts = of(events, 'attempt');
  assertEquals(attempts, [{ type: 'attempt', attempt: 1, reason: 'validation' }]);
  // The first attempt's text went out before the marker; the kept reply drops it.
  const kept = keptReply(events);
  assertEquals(
    of(kept, 'text')
      .map((e) => e.text)
      .join(''),
    JSON.stringify({ title: 'good' }),
  );
  const blocks = foldTurnEvents(events);
  assertEquals(JSON.stringify(blocks).includes('"bad"'), false);
  assertEquals(of(events, 'structured').at(-1)?.failed, undefined);
});

Deno.test('a reply still invalid when retries run out says what failed, and completes', async () => {
  const events = await run(
    scopeWith({ fields: { title: titled }, maxRetries: 1 }),
    provider([{ title: 'bad' }]),
  );
  const structured = of(events, 'structured');
  assertEquals(structured.length, 1);
  assertEquals(structured[0]?.structured, { title: 'bad' });
  assertEquals(structured[0]?.failed, [{ path: 'title', error: 'the title is not good' }]);
  assertEquals(of(events, 'done').at(-1)?.stop?.kind, 'completed');
});

Deno.test('a structured reply is one assistant message in history', async () => {
  const events = await run(
    scopeWith({ fields: { title: titled }, maxRetries: 2 }),
    provider([{ title: 'bad' }, { title: 'good' }]),
  );
  const history = appendAssistantEventsToHistory([], events);
  const assistant = history.filter((m) => m.role === 'assistant');
  assertEquals(assistant.length, 1);
  assertEquals(String(assistant[0]?.content).includes('"bad"'), false);
});

Deno.test('an item rewrite folds to the held reply, not the first partial one', async () => {
  const cited = (item: unknown) =>
    typeof item === 'object' && item !== null && 'source' in item
      ? { isValid: true as const }
      : { isValid: false as const, error: 'a claim needs a source' };
  const events = await run(
    scopeWith({ items: { claims: { check: cited, onFail: 'fix' } }, maxRetries: 1 }),
    provider([
      { title: 'good', claims: [{ claim: 'bare' }] },
      { claims: [{ claim: 'bare', source: 'b' }] },
    ]),
  );
  assertEquals(of(events, 'attempt').length, 1);
  const kept = keptReply(events);
  const structured = of(kept, 'structured');
  assertEquals(structured.length, 1);
  assertEquals(structured[0]?.structured, {
    title: 'good',
    claims: [{ claim: 'bare', source: 'b' }],
  });
  const history = appendAssistantEventsToHistory([], events);
  assertEquals(history.filter((m) => m.role === 'assistant').length, 1);
});
