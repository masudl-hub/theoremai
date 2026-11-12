import { assert } from '@std/assert';
import type { LateResultItem, ToolOperationIdentity } from '../../mod.ts';
import { conversationScenarios } from '../../src/conversation/testing.ts';
import { sessionConversationInbox } from '../../web/src/server/conversation-inbox.ts';
import {
  createMemoryConversationStore,
  emptyConversation,
  type StoredConversation,
} from '../../web/src/server/conversation-store.ts';
import { sessionStateStore } from '../../web/src/server/session-authority.ts';
import {
  createMemorySessionStore,
  DEFAULT_OPERATION_RETENTION_MS,
} from '../../web/src/server/session-store.ts';
import { sessionToolCoordinator } from '../../web/src/server/tool-operations.ts';

const LEASE_MS = 30_000;
const SESSION = 'session';

/** A detached call in the chat's transcript, and its end in the session, as a turn leaves them. */
async function arrived(
  sessions: ReturnType<typeof sessionStateStore>,
  operationId: string,
): Promise<StoredConversation['transcript'][number]> {
  const coordinator = sessionToolCoordinator(sessions, SESSION);
  const identity: ToolOperationIdentity = {
    operationId,
    callId: `call-${operationId}`,
    profileId: 'profile',
    toolId: 'tool',
    invocationHash: 'hash',
  };
  const acquired = await coordinator.begin(identity);
  assert(acquired.kind === 'acquired');
  const claim = { ...identity, claimToken: acquired.claimToken };
  const background = {
    operationId,
    callId: identity.callId,
    name: 'tool',
    at: 0,
    phase: 'background' as const,
    readBack: 'started',
  };
  const modelResult = {
    finding: 'done',
    modelText: 'done',
    provenance: { origin: 'http' as const, tool: 'tool', depth: 1 },
  };
  assert(coordinator.detach);
  await coordinator.detach(claim, {
    event: { type: 'tool', tool: background },
    replay: { modelResult },
  });
  await coordinator.settle(claim, {
    event: {
      type: 'tool',
      tool: {
        operationId,
        callId: identity.callId,
        name: 'tool',
        at: 1,
        phase: 'complete',
        output: {},
      },
    },
    effects: 'completed',
    replay: { modelResult },
  });
  return {
    id: `block-${operationId}`,
    kind: 'tool',
    tool: {
      operationId,
      name: 'tool',
      callId: identity.callId,
      arguments: {},
      state: { name: 'tool', callId: identity.callId, at: 0, phase: 'background', readBack: 'x' },
    },
  };
}

for (const scenario of conversationScenarios<LateResultItem>({
  makeHarness: async () => {
    let clock = Date.now();
    const sessions = sessionStateStore(
      createMemorySessionStore(),
      undefined,
      DEFAULT_OPERATION_RETENTION_MS,
    );
    const conversations = createMemoryConversationStore();
    const first = await conversations.write(SESSION, null, null, emptyConversation());
    assert(first.written);
    const ref = first.ref;
    const load = async () => {
      const snapshot = await conversations.read(SESSION, ref);
      assert(snapshot);
      return snapshot;
    };
    const conversation = (await load()).conversation.id;
    const write = async (change: (stored: StoredConversation) => StoredConversation) => {
      const snapshot = await load();
      const written = await conversations.write(
        SESSION,
        ref,
        snapshot.revision,
        change(snapshot.conversation),
      );
      assert(written.written);
    };
    const inbox = sessionConversationInbox({
      sessions,
      sessionId: SESSION,
      leaseMs: LEASE_MS,
      now: () => clock,
      conversation: async (key) => {
        const { conversation: stored } = await load();
        return stored.id === key ? stored : undefined;
      },
      readable: () => Promise.resolve(true),
    });
    /** A save of `reply` under `hold`: only while the hold has the chat and was handed each id. */
    const fenced = async (hold: string, reply: string, ids: readonly string[]) => {
      if (!(await inbox.renew(conversation, hold))) return false;
      const state = await sessions.read(SESSION);
      const entries = state.inbox?.conversations[conversation]?.entries ?? {};
      return ids.every((id) => {
        const handed = Object.hasOwn(entries, id) ? entries[id].handed : undefined;
        return handed?.hold === hold && handed.reply === reply;
      });
    };
    return {
      inbox,
      conversation,
      async arrive(id) {
        const block = await arrived(sessions, id);
        await write((stored) => ({ ...stored, transcript: [...stored.transcript, block] }));
      },
      async settle(hold, reply, ids) {
        if (!(await fenced(hold, reply, ids))) return false;
        await write(({ paused: _paused, ...stored }) => ({
          ...stored,
          transcript: [
            ...stored.transcript,
            ...(ids.length > 0
              ? [
                  {
                    id: crypto.randomUUID(),
                    kind: 'late-results' as const,
                    text: 'results',
                    operationIds: [...ids],
                    inReply: false,
                  },
                ]
              : []),
          ],
        }));
        return true;
      },
      async pause(hold, reply, ids) {
        if (!(await fenced(hold, reply, ids))) return false;
        await write((stored) => ({
          ...stored,
          paused: {
            events: [
              {
                type: 'late_results',
                text: 'results',
                operationIds: [...ids],
                stage: 'pre_turn',
                step: 0,
                inReply: false,
              },
            ],
            base: [],
            baseEvents: 0,
            workedMs: 0,
            endedAt: clock,
            reply,
          },
        }));
        return true;
      },
      lapse() {
        clock += LEASE_MS + 1;
        return Promise.resolve();
      },
      async told() {
        const { conversation: stored } = await load();
        return stored.transcript.flatMap((block) =>
          block.kind === 'late-results' ? block.operationIds : [],
        );
      },
    };
  },
})) {
  Deno.test(`session inbox: ${scenario.name}`, scenario.run);
}
