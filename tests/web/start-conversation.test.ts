import { assertEquals, assertRejects } from '@std/assert';
import { defineProfile, type ProfileGuardrailsSpec, TheoremError } from '../../mod.ts';
import type { TranscriptBlock } from '../../src/interface/mod.ts';
import { createSealedConversationStore, startConversation } from '../../web/src/server/mod.ts';
import { geminiModels } from '../fixtures/models.ts';

const GITHUB_TOKEN = ['ghp_', 'q7RkT2mZx9LpW4vYc1NbH8sDf3GjK6aEu0Xo'].join('');

function profile(guardrails?: ProfileGuardrailsSpec) {
  return defineProfile({
    id: 'start-conversation',
    type: 'text',
    identity: { handle: 'concierge' },
    ...geminiModels('gemini35FlashLite'),
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
    ...(guardrails ? { guardrails } : {}),
  });
}

function exchange(reply: string): TranscriptBlock[] {
  return [
    { id: 'ask', kind: 'user-text', text: 'Two days in Lisbon. Where should I stay?' },
    { id: 'reply', kind: 'text', text: reply },
    { id: 'done', kind: 'turn-done' },
  ];
}

const store = () =>
  createSealedConversationStore({
    keys: { 1: 'start-key-0123456789abcdef0123456789' },
    keyVersion: 1,
  });

Deno.test('a conversation started from blocks opens on them, with the history the model reads', async () => {
  const conversations = { sessionId: 'session-a', store: store() };
  const blocks = exchange('Stay in Chiado.');
  const { ref, view, events } = await startConversation(conversations, profile(), blocks);
  assertEquals(events, []);
  assertEquals(view, { transcript: blocks });
  const snapshot = await conversations.store.read('session-a', ref);
  assertEquals(snapshot?.conversation.transcript, blocks);
  assertEquals(snapshot?.conversation.history, [
    { role: 'user', content: 'Two days in Lisbon. Where should I stay?' },
    { role: 'assistant', content: 'Stay in Chiado.' },
  ]);
  assertEquals(await conversations.store.read('session-b', ref), undefined);
});

Deno.test("the profile's guardrails read the history a conversation starts from", async () => {
  const conversations = { sessionId: 'session-a', store: store() };
  const { ref, events } = await startConversation(
    conversations,
    profile({ detect: { credentials: 'redact' } }),
    exchange(`Use ${GITHUB_TOKEN} to sign in.`),
  );
  assertEquals(events.length, 1);
  const history = (await conversations.store.read('session-a', ref))?.conversation.history;
  assertEquals(history?.[1]?.content?.includes(GITHUB_TOKEN), false);
});

Deno.test('a guardrail set to block refuses the blocks, and nothing is stored', async () => {
  const written: unknown[] = [];
  const base = store();
  const conversations = {
    sessionId: 'session-a',
    store: {
      read: base.read,
      write: (...args: Parameters<typeof base.write>) => {
        written.push(args);
        return base.write(...args);
      },
    },
  };
  const error = await assertRejects(
    () =>
      startConversation(
        conversations,
        profile({ detect: { credentials: 'block' } }),
        exchange(GITHUB_TOKEN),
      ),
    TheoremError,
  );
  assertEquals(error.copy, { key: 'detect.blocked' });
  assertEquals(written, []);
});
