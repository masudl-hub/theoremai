import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { labelDefault, TheoremError } from '../../mod.ts';
import {
  createMemoryConversationStore,
  createSealedConversationStore,
  emptyConversation,
  type StoredConversation,
  type TheoremConversationStore,
  unknownConversation,
} from '../../react/src/server/mod.ts';

const KEY_1 = 'conversation-key-one-0123456789abcdef';
const KEY_2 = 'conversation-key-two-0123456789abcdef';

/** A conversation holding one message. */
function saying(text: string): StoredConversation {
  return {
    ...emptyConversation(),
    transcript: [{ id: 'user-1', kind: 'user-text', text }],
    history: [{ role: 'user', content: text }],
  };
}

/** Writes `conversation` as a new one, and returns the ref and revision the store issued. */
async function created(store: TheoremConversationStore, sessionId: string, text: string) {
  const written = await store.write(sessionId, null, null, saying(text));
  if (!written.written) throw new Error('expected a new conversation to be written');
  return written;
}

const stores: [string, () => TheoremConversationStore][] = [
  ['memory', () => createMemoryConversationStore()],
  ['sealed', () => createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 1 })],
];

for (const [name, make] of stores) {
  Deno.test(`a ${name} store reads back what it wrote, only in the session that wrote it`, async () => {
    const store = make();
    const { ref, revision } = await created(store, 'session-a', 'hello');
    assertEquals(await store.read('session-a', ref), { revision, conversation: saying('hello') });
    assertEquals(await store.read('session-b', ref), undefined);
    assertEquals(await store.read('session-a', 'not-a-ref'), undefined);
  });

  Deno.test(`a ${name} store refuses a write from a revision it no longer holds`, async () => {
    const store = make();
    const first = await created(store, 'session-a', 'hello');
    const next = await store.write('session-a', first.ref, first.revision, saying('again'));
    if (!next.written) throw new Error('expected the write from the current revision to land');
    assertEquals(await store.write('session-a', next.ref, first.revision, saying('stale')), {
      written: false,
    });
    // Another session's write against the ref lands nowhere it can read.
    const crossed = await store.write('session-b', next.ref, next.revision, saying('crossed'));
    if (crossed.written) {
      assertEquals(await store.read('session-a', crossed.ref), undefined);
    }
    assertEquals((await store.read('session-a', next.ref))?.conversation, saying('again'));
  });

  Deno.test(`a ${name} store refuses a write to a ref this session cannot read`, async () => {
    const store = make();
    const { ref } = await created(store, 'session-a', 'hello');
    assertEquals(await store.write('session-b', ref, null, saying('taken')), { written: false });
    assertEquals(await store.write('session-a', 'not-a-ref', null, saying('new')), {
      written: false,
    });
    assertEquals((await store.read('session-a', ref))?.conversation, saying('hello'));
  });

  Deno.test(`a ${name} store refuses a conversation that is not one`, async () => {
    const store = make();
    const broken = JSON.parse(JSON.stringify({ version: 2, transcript: [], history: [] }));
    await assertRejects(() => store.write('session-a', null, null, broken));
  });
}

Deno.test('a memory store hands out copies, so a caller cannot change what it holds', async () => {
  const store = createMemoryConversationStore();
  const { ref } = await created(store, 'session-a', 'hello');
  const read = await store.read('session-a', ref);
  read?.conversation.transcript.push({ id: 'user-2', kind: 'user-text', text: 'forged' });
  assertEquals((await store.read('session-a', ref))?.conversation, saying('hello'));
});

Deno.test('a memory store forgets a conversation left idle past its time', async () => {
  const store = createMemoryConversationStore({ ttlMs: 1 });
  const { ref } = await created(store, 'session-a', 'hello');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(await store.read('session-a', ref), undefined);
});

Deno.test('a sealed ref carries nothing readable, and a changed one opens nothing', async () => {
  const store = createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 1 });
  const { ref } = await created(store, 'session-a', 'a private message');
  assertEquals(ref.includes('private'), false);
  const flipped = `${ref.slice(0, -2)}${ref.endsWith('AA') ? 'BB' : 'AA'}`;
  assertEquals(await store.read('session-a', flipped), undefined);
});

Deno.test('a sealed store opens refs sealed with an older key it still holds', async () => {
  const old = createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 1 });
  const { ref } = await created(old, 'session-a', 'hello');
  const rotated = createSealedConversationStore({ keys: { 1: KEY_1, 2: KEY_2 }, keyVersion: 2 });
  assertEquals((await rotated.read('session-a', ref))?.conversation, saying('hello'));
  const retired = createSealedConversationStore({ keys: { 2: KEY_2 }, keyVersion: 2 });
  assertEquals(await retired.read('session-a', ref), undefined);
});

Deno.test('a sealed store opens an older ref of the same conversation, as a rewind would', async () => {
  const store = createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 1 });
  const first = await created(store, 'session-a', 'hello');
  const next = await store.write('session-a', first.ref, first.revision, saying('again'));
  if (!next.written) throw new Error('expected the write to land');
  assertEquals((await store.read('session-a', first.ref))?.conversation, saying('hello'));
});

Deno.test('a sealed store without the key it seals with is refused at creation', () => {
  assertThrows(
    () => createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 2 }),
    TheoremError,
  );
});

Deno.test('an unknown conversation reads as the labels line for it', () => {
  const refused = unknownConversation();
  assertEquals(refused.kind, 'request');
  assertEquals(refused.message, labelDefault('session.conversation_unknown'));
});
