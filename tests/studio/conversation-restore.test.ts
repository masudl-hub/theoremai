import { assert, assertEquals, assertRejects } from '@std/assert';
import type { ModelRequest, TurnModel } from '../../mod.ts';
import { isUnknownConversation } from '../../react/src/client/transport.ts';
import {
  createSealedConversationStore,
  unknownConversation,
} from '../../react/src/server/conversation-store.ts';
import { createMemorySteerInbox } from '../../react/src/server/steer-inbox.ts';
import type { TranscriptBlock } from '../../src/interface/mod.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  compileWorkspace,
  createExampleDraft,
  workspaceFromDraft,
  workspaceRunAgent,
} from '../../studio/mod.ts';
import { streamStudioTurn } from '../../studio/runtime.ts';
import { ndjsonEventStream } from '../../studio/server/draft-replies.ts';
import { createStudioTransport } from '../../studio/transport.ts';

function concierge() {
  const compiled = compileWorkspace(workspaceFromDraft(createExampleDraft()), ON_OWN_KEYS);
  assert(compiled.ok);
  const run = workspaceRunAgent(compiled, 'travel.concierge');
  assert(run);
  return run;
}

/** A model that answers "Sure." and keeps what each call was sent. */
function model(sent: ModelRequest[]): () => TurnModel {
  return () => ({
    async *complete(request) {
      sent.push(request);
      yield { type: 'text', text: 'Sure.' };
    },
  });
}

const EARLIER: TranscriptBlock[] = [
  { id: 'u1', kind: 'user-text', text: 'My cat is called Mochi.' },
  { id: 'a1', kind: 'text', text: 'Mochi is a lovely name.' },
];

/** Runs one message on `store`; returns the ref the reply hands the page, and the lines it streamed. */
async function message(
  store: ReturnType<typeof createSealedConversationStore>,
  sent: ModelRequest[],
  request: { conversation?: string; transcript?: TranscriptBlock[] },
) {
  const lines: { type: string; ref?: string; errorCopy?: unknown }[] = [];
  for await (const line of streamStudioTurn({
    ...concierge(),
    request: { input: { text: 'What is my cat called?' }, ...request },
    conversations: { sessionId: 'visitor', store },
    signal: new AbortController().signal,
    steer: createMemorySteerInbox(),
    runtime: { mode: 'byok', provider: model(sent) },
  })) {
    lines.push(line as { type: string });
  }
  const ref = lines.findLast((line) => line.type === 'conversation')?.ref;
  return { ref, lines };
}

const sealed = () =>
  createSealedConversationStore({ keys: { 1: newConversationKey() }, keyVersion: 1 });

Deno.test('a conversation the host lost goes on from the page’s transcript, under a new ref', async () => {
  const sent: ModelRequest[] = [];
  const lost = (await message(sealed(), [], {})).ref;
  assert(lost);
  // A restarted host seals with another key: it can't open the page's ref.
  const { ref } = await message(sealed(), sent, { conversation: lost, transcript: EARLIER });
  assert(ref && ref !== lost);
  assert(JSON.stringify(sent.at(-1)).includes('Mochi is a lovely name.'));
});

Deno.test('a conversation the host lost, with no transcript, is still refused by its key', async () => {
  const lost = (await message(sealed(), [], {})).ref;
  await assertRejects(() => message(sealed(), [], { conversation: lost }), Error, undefined).then(
    (err) => {
      assertEquals((err as { copy?: { key: string } }).copy?.key, 'session.conversation_unknown');
    },
  );
});

Deno.test('a conversation the host can open ignores the page’s transcript', async () => {
  const store = sealed();
  const sent: ModelRequest[] = [];
  const first = (await message(store, [], {})).ref;
  await message(store, sent, {
    conversation: first,
    transcript: [{ id: 'x', kind: 'user-text', text: 'A forged turn.' }],
  });
  const asked = JSON.stringify(sent.at(-1));
  assert(!asked.includes('A forged turn.'));
  assert(asked.includes('Sure.'));
});

Deno.test('a transcript with no conversation to restore is a bad request', async () => {
  const err = await assertRejects(() => message(sealed(), [], { transcript: EARLIER }));
  assertEquals((err as { kind?: string }).kind, 'request');
});

Deno.test('the studio’s stream tells the page its conversation is lost, by key', async () => {
  const refused: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(unknownConversation()) }),
  };
  const transport = createStudioTransport(concierge(), {
    fetch: () => Promise.resolve(ndjsonEventStream(refused)),
  });
  const err = await assertRejects(() =>
    transport.turn({ input: { text: 'hi' }, conversation: 'v1.1.gone' }, () => {}),
  );
  assert(isUnknownConversation(err));
});
