import { assert, assertEquals } from '@std/assert';
import { createMemoryInbox } from '../../src/conversation/memory.ts';
import { runConversation } from '../../src/conversation/run.ts';
import type { InboxItem } from '../../src/conversation/types.ts';

Deno.test('a hold that cannot renew aborts its reply, and another hold tells what it read', async () => {
  const LEASE_MS = 30_000;
  let clock = 1_000;
  const inbox = createMemoryInbox<InboxItem>({ leaseMs: LEASE_MS, now: () => clock });
  inbox.arrive('chat', { id: 'a', kind: 'result', handovers: [] });
  const newId = () => crypto.randomUUID();
  const all = (items: readonly InboxItem[]) => items.map((item) => item.id);
  const tellAll = (items: readonly InboxItem[]) => ({ tell: all(items) });
  const gaveUp = () => {
    throw new Error('nothing should be given up');
  };

  const first = await runConversation({
    conversation: 'chat',
    inbox,
    policy: tellAll,
    gaveUp,
    start: { opening: 'wake' },
    newId,
    renewEveryMs: 1,
    reply: async (reply) => {
      clock += LEASE_MS + 1;
      await new Promise<void>((resolve) => reply.signal.addEventListener('abort', () => resolve()));
      assert(!inbox.settle('chat', reply.hold, reply.reply, all(reply.opened)));
    },
  });
  assertEquals(first, { outcome: 'lost' });

  const second = await runConversation({
    conversation: 'chat',
    inbox,
    policy: tellAll,
    gaveUp,
    start: { opening: 'wake' },
    newId,
    renewEveryMs: 60_000,
    reply: (reply) => {
      assertEquals(
        reply.opened.map((item) => [item.id, item.handovers.length]),
        [['a', 1]],
      );
      assert(inbox.settle('chat', reply.hold, reply.reply, all(reply.opened)));
      return Promise.resolve();
    },
  });
  assertEquals(second, { outcome: 'released' });
  assertEquals(inbox.states('chat').get('a'), 'told');
});
