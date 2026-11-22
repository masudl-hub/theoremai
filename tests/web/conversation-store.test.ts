import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { labelDefault, TheoremError } from '../../mod.ts';
import {
  createMemoryConversationStore,
  createSealedConversationStore,
  emptyConversation,
  type StoredConversation,
  type TheoremConversationStore,
  unknownConversation,
} from '../../web/src/server/mod.ts';

const KEY_1 = 'conversation-key-one-0123456789abcdef';
const KEY_2 = 'conversation-key-two-0123456789abcdef';

/** A conversation holding one message. */
function saying(text: string): StoredConversation {
  return {
    ...emptyConversation(),
    id: 'conversation-1',
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
    // why: a conversation stored before it had an id is not read; it starts over.
    const older = JSON.parse(JSON.stringify({ version: 1, transcript: [], history: [] }));
    await assertRejects(() => store.write('session-a', null, null, older));
  });
}

/** A conversation whose one call went on in the background as `op_1`. */
function detaching(): StoredConversation {
  return {
    ...saying('find it'),
    transcript: [
      { id: 'user-1', kind: 'user-text', text: 'find it' },
      {
        id: 'tool-1',
        kind: 'tool',
        tool: {
          name: 'lookup',
          callId: 'c1',
          operationId: 'op_1',
          arguments: {},
          state: {
            name: 'lookup',
            callId: 'c1',
            phase: 'background',
            at: 5,
            readBack: 'still running',
          },
        },
      },
    ],
  };
}

const ENDING = {
  operationId: 'op_1',
  tool: {
    name: 'lookup',
    callId: 'c1',
    operationId: 'op_1',
    phase: 'complete',
    at: 9,
    output: { found: true },
    readBack: 'found',
  },
} as const;

const phaseOf = (conversation: StoredConversation | undefined) =>
  conversation?.transcript.flatMap((block) =>
    block.kind === 'tool' ? [block.tool.state?.phase] : [],
  );

Deno.test("a memory store saves a call's end on its step, and a stale write keeps it", async () => {
  const store = createMemoryConversationStore();
  const written = await store.write('session-a', null, null, detaching());
  if (!written.written) throw new Error('expected the conversation to be written');
  await store.end('session-b', ENDING);
  assertEquals(phaseOf((await store.read('session-a', written.ref))?.conversation), ['background']);
  await store.end('session-a', ENDING);
  const ended = await store.read('session-a', written.ref);
  // why: the end changes no revision, so a reply that read the conversation before it still saves
  assertEquals(ended?.revision, written.revision);
  assertEquals(phaseOf(ended?.conversation), ['complete']);
  // why: the block was written as one saved before `detached` was kept; its end keeps it detached
  const step = ended?.conversation.transcript.find((block) => block.kind === 'tool');
  assertEquals(step?.kind === 'tool' ? step.tool.detached : undefined, {
    at: 5,
    readBack: 'still running',
  });
  const next = detaching();
  next.transcript.push({ id: 'text-1', kind: 'text', text: 'Still looking.' });
  const later = await store.write('session-a', written.ref, written.revision, next);
  if (!later.written) throw new Error('expected the write from the current revision to land');
  const kept = await store.read('session-a', later.ref);
  assertEquals(phaseOf(kept?.conversation), ['complete']);
  assertEquals(kept?.conversation.transcript.length, 3);
});

Deno.test('a sealed store keeps no end: the conversation stays as written', async () => {
  const store = createSealedConversationStore({ keys: { 1: KEY_1 }, keyVersion: 1 });
  const written = await store.write('session-a', null, null, detaching());
  if (!written.written) throw new Error('expected the conversation to be written');
  await store.end('session-a', ENDING);
  assertEquals(phaseOf((await store.read('session-a', written.ref))?.conversation), ['background']);
});

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
  assertEquals(refused.kind, 'not_found');
  assertEquals(refused.message, labelDefault('session.conversation_unknown'));
});
