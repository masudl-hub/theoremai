import { createMemoryInbox } from '../../src/conversation/memory.ts';
import { conversationScenarios } from '../../src/conversation/testing.ts';
import type { InboxItem } from '../../src/conversation/types.ts';

const LEASE_MS = 30_000;

for (const scenario of conversationScenarios<InboxItem>({
  makeHarness: () => {
    let clock = 1_000;
    const inbox = createMemoryInbox<InboxItem>({ leaseMs: LEASE_MS, now: () => clock });
    const conversation = 'chat';
    const told: string[] = [];
    return Promise.resolve({
      inbox,
      conversation,
      arrive: (id) =>
        Promise.resolve(inbox.arrive(conversation, { id, kind: 'result', handovers: [] })),
      settle: (hold, reply, ids) => {
        const kept = inbox.settle(conversation, hold, reply, ids);
        if (kept) told.push(...ids);
        return Promise.resolve(kept);
      },
      pause: (hold, reply, ids) => Promise.resolve(inbox.pause(conversation, hold, reply, ids)),
      lapse: () => {
        clock += LEASE_MS + 1;
        return Promise.resolve();
      },
      told: () => Promise.resolve([...told]),
    });
  },
})) {
  Deno.test(`memory inbox: ${scenario.name}`, scenario.run);
}
