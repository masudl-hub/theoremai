/**
 * Composer pending messages + action matrix.
 */

import { assertEquals, assertThrows } from '@std/assert';
import {
  resolveComposerMenuActions,
  resolveComposerPrimary,
} from '../../src/interface/composer-actions.ts';
import {
  composerPendingPreview,
  consumeNextComposerQueue,
  consumeNextComposerSteer,
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  moveComposerPendingWithinKind,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  userDraftHasPayload,
} from '../../src/interface/pending.ts';

Deno.test('userDraftHasPayload', () => {
  assertEquals(userDraftHasPayload({}), false);
  assertEquals(userDraftHasPayload({ text: '  ' }), false);
  assertEquals(userDraftHasPayload({ text: 'hi' }), true);
  assertEquals(
    userDraftHasPayload({
      attachments: [{ name: 'a.png', mimeType: 'image/png', sizeBytes: 1 }],
    }),
    true,
  );
});

Deno.test('pending: order steers before queues before stashes', () => {
  const a = createComposerPendingMessage({ kind: 'stash', draft: { text: 's' }, id: '1', now: 1 });
  const b = createComposerPendingMessage({ kind: 'queue', draft: { text: 'q' }, id: '2', now: 2 });
  const c = createComposerPendingMessage({ kind: 'steer', draft: { text: 't' }, id: '3', now: 3 });
  assertEquals(
    orderComposerPendingMessages([a, b, c]).map((m) => m.kind),
    ['steer', 'queue', 'stash'],
  );
});

Deno.test('pending: convert steers to front of queue on run end', () => {
  const steer = createComposerPendingMessage({
    kind: 'steer',
    draft: { text: 'steer me' },
    id: 's',
    now: 1,
  });
  const queue = createComposerPendingMessage({
    kind: 'queue',
    draft: { text: 'later' },
    id: 'q',
    now: 2,
  });
  const stash = createComposerPendingMessage({
    kind: 'stash',
    draft: { text: 'idea' },
    id: 'x',
    now: 3,
  });
  const next = convertSteersToFrontQueued([queue, steer, stash], 99);
  assertEquals(
    next.map((m) => ({ id: m.id, kind: m.kind })),
    [
      { id: 's', kind: 'queue' },
      { id: 'q', kind: 'queue' },
      { id: 'x', kind: 'stash' },
    ],
  );
  assertEquals(next[0]?.updatedAt, 99);
});

Deno.test('pending: consume one steer / one queue FIFO', () => {
  const s1 = createComposerPendingMessage({ kind: 'steer', draft: { text: '1' }, id: 's1' });
  const s2 = createComposerPendingMessage({ kind: 'steer', draft: { text: '2' }, id: 's2' });
  const q1 = createComposerPendingMessage({ kind: 'queue', draft: { text: 'q' }, id: 'q1' });
  const first = consumeNextComposerSteer([s1, s2, q1]);
  assertEquals(first.message?.id, 's1');
  assertEquals(
    first.remaining.map((m) => m.id),
    ['s2', 'q1'],
  );
  const second = consumeNextComposerQueue(first.remaining);
  assertEquals(second.message?.id, 'q1');
  assertEquals(
    second.remaining.map((m) => m.id),
    ['s2'],
  );
});

Deno.test('pending: move within kind only', () => {
  const a = createComposerPendingMessage({ kind: 'queue', draft: { text: 'a' }, id: 'a' });
  const b = createComposerPendingMessage({ kind: 'queue', draft: { text: 'b' }, id: 'b' });
  const s = createComposerPendingMessage({ kind: 'steer', draft: { text: 's' }, id: 's' });
  const down = moveComposerPendingWithinKind([s, a, b], 'a', 'down');
  assertEquals(
    down.map((m) => m.id),
    ['s', 'b', 'a'],
  );
});

Deno.test('pending: promote stash to queue', () => {
  const stash = createComposerPendingMessage({ kind: 'stash', draft: { text: 'idea' }, id: 'x' });
  const next = promoteComposerPendingKind([stash], 'x', 'queue');
  assertEquals(next[0]?.kind, 'queue');
});

Deno.test('pending: reject empty draft', () => {
  assertThrows(() => createComposerPendingMessage({ kind: 'queue', draft: {} }));
});

Deno.test('pending: preview and remove', () => {
  const m = createComposerPendingMessage({ kind: 'queue', draft: { text: ' hello ' }, id: '1' });
  assertEquals(composerPendingPreview(m), 'hello');
  assertEquals(removeComposerPendingMessage([m], '1'), []);
});

Deno.test('composer actions: idle matrix', () => {
  assertEquals(
    resolveComposerPrimary({ phase: 'idle', hasPayload: false, allowSteering: true }),
    'none',
  );
  assertEquals(
    resolveComposerPrimary({ phase: 'idle', hasPayload: true, allowSteering: true }),
    'send',
  );
  assertEquals(
    resolveComposerMenuActions({ phase: 'idle', hasPayload: true, allowSteering: true }),
    ['stash'],
  );
});

Deno.test('composer actions: streaming matrix', () => {
  assertEquals(
    resolveComposerPrimary({ phase: 'streaming', hasPayload: false, allowSteering: true }),
    'stop',
  );
  assertEquals(
    resolveComposerPrimary({ phase: 'streaming', hasPayload: true, allowSteering: true }),
    'queue',
  );
  assertEquals(
    resolveComposerMenuActions({ phase: 'streaming', hasPayload: true, allowSteering: true }),
    ['queue', 'steer', 'send_now', 'stash'],
  );
  assertEquals(
    resolveComposerMenuActions({ phase: 'streaming', hasPayload: true, allowSteering: false }),
    ['queue', 'send_now', 'stash'],
  );
});

Deno.test('composer actions: gated — queue, no steer, no stop', () => {
  assertEquals(
    resolveComposerPrimary({ phase: 'gated', hasPayload: false, allowSteering: true }),
    'none',
  );
  assertEquals(
    resolveComposerPrimary({ phase: 'gated', hasPayload: true, allowSteering: true }),
    'queue',
  );
  assertEquals(
    resolveComposerMenuActions({ phase: 'gated', hasPayload: true, allowSteering: true }),
    ['queue', 'send_now', 'stash'],
  );
});
