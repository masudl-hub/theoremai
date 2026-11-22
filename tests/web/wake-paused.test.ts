import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type TurnEvent,
  type TurnHistoryMessage,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import {
  type CoreContext,
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremConversationCore,
  type Reply,
  type ReplyLine,
  type RunEnd,
} from '../../web/src/server/mod.ts';
import { failureOf, lastTool, toolPhases } from '../fixtures/events.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'wake-paused',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: ['wake_paused_delete'] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const KEEPER = 'person-1';
const LEASE_MS = 60_000;
const LONG_MS = 60_000;
const SHORT_MS = 20;

registerFixtureProviders(defaultKernelScope);

const ran: string[] = [];
let running: Promise<void> = Promise.resolve();
registerTool({
  type: 'function',
  name: 'wake_paused_delete',
  description: 'Delete a record',
  category: 'test',
  access: 'destructive',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.string() }),
  handler: async (input) => {
    const { id } = z.object({ id: z.string() }).parse(input);
    ran.push(id);
    await running;
    return { deleted: id };
  },
});

type Note = InboxItem<'note'>;

/** A model that calls the gated tool `calls` times in its first step, and answers in text after. */
function gatedModel(seen: (TurnHistoryMessage[] | undefined)[], calls: number): TurnModel {
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req.history);
        if (seen.length > 1) {
          yield { type: 'text' as const, text: 'Sure.' };
          yield { type: 'done' as const, stop: { kind: 'completed' } };
          return;
        }
        for (let call = 1; call <= calls; call += 1) {
          yield {
            type: 'tool' as const,
            tool: {
              name: 'wake_paused_delete',
              arguments: { id: `record-${call}` },
              callId: `call-${call}`,
            },
          };
        }
        yield { type: 'done' as const, stop: { kind: 'tool' } };
      })(),
  };
}

function at(): CoreContext {
  return { sessionId: KEEPER, signal: new AbortController().signal };
}

async function drain(reply: Reply): Promise<{ lines: ReplyLine[]; end: RunEnd }> {
  const lines: ReplyLine[] = [];
  for (;;) {
    const next = await reply.next();
    if (next.done) return { lines, end: next.value };
    lines.push(next.value);
  }
}

function eventsOf(lines: readonly ReplyLine[]): TurnEvent[] {
  return lines.flatMap((line) => (line.type === 'conversation' ? [] : [line]));
}

function refOf(lines: readonly ReplyLine[]): string {
  let ref = '';
  for (const line of lines) if (line.type === 'conversation') ref = line.ref;
  assert(ref !== '', 'the run named no conversation');
  return ref;
}

/** The gates a run paused on, as the session issued them. */
function gatesOf(lines: readonly ReplyLine[]): { gateId: string; operationId: string }[] {
  return eventsOf(lines).flatMap((event) =>
    event.type === 'tool' && event.tool.phase === 'gate' && event.tool.operationId
      ? [{ gateId: event.tool.callId, operationId: event.tool.operationId }]
      : [],
  );
}

/** A conversation whose reply waits on `calls` gates that lapse after `gateTtlMs`. */
async function paused(gateTtlMs: number | undefined, calls = 1) {
  ran.length = 0;
  running = Promise.resolve();
  const seen: (TurnHistoryMessage[] | undefined)[] = [];
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const sessions = createMemorySessionStore();
  const conversations = createMemoryConversationStore();
  const saves: { ended: string; blocks: string[] }[] = [];
  const core = createTheoremConversationCore<Note>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(gatedModel(seen, calls)),
    conversationStore: conversations,
    sessionStore: sessions,
    ...(gateTtlMs === undefined ? {} : { gateTtlMs }),
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'wake' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
    beforeSave: (_at, reply) => {
      saves.push({ ended: reply.ended, blocks: reply.blocks.map((block) => block.kind) });
      return Promise.resolve({ blocks: reply.blocks, told: [] });
    },
  });
  const before = Date.now();
  const first = await drain(await core.message(at(), { input: { text: 'delete it' } }));
  const ref = refOf(first.lines);
  const gates = gatesOf(first.lines);
  assertEquals(gates.length, calls, 'the reply did not pause on every call');
  saves.length = 0;
  const due = () => inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const waits = async () =>
    (await conversations.read(KEEPER, ref))?.conversation.paused !== undefined;
  return { core, seen, sessions, saves, ref, gates, before, due, waits, first };
}

function lapse(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SHORT_MS * 3));
}

Deno.test('a wake on a reply that waits on a live gate runs nothing, and says when the gate lapses', async () => {
  const { core, seen, ref, gates, before, due, waits } = await paused(LONG_MS);
  due();
  assertEquals((await core.read(at(), { ref })).wake, undefined);
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assert(end.outcome === 'held', 'the wake did not say it waits');
  assert(end.leasedUntil >= before + LONG_MS && end.leasedUntil <= Date.now() + LONG_MS);
  assertEquals(seen.length, 1, 'the wake ran the model');
  assert(await waits(), 'the reply no longer waits');

  const answered = await drain(
    await core.answer(at(), { ...gates[0], conversation: ref, decision: 'approve' }),
  );
  assertEquals(toolPhases(eventsOf(answered.lines), 'wake_paused_delete').at(-1), 'complete');
  assertEquals(ran, ['record-1']);
});

Deno.test('a wake on a reply whose gates have no time limit runs nothing and names no time', async () => {
  const { core, seen, ref, due, waits } = await paused(undefined);
  due();
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assertEquals(end, { outcome: 'released' });
  assertEquals(seen.length, 1);
  assert(await waits());
});

Deno.test('a wake walks away from a reply whose gates have all lapsed, then runs in the same save', async () => {
  const { core, seen, saves, ref, first, due, waits } = await paused(SHORT_MS);
  await lapse();
  due();
  assertEquals((await core.read(at(), { ref })).wake, true);
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(end, { outcome: 'released' });
  const events = eventsOf(lines);
  assertEquals(events[0].type, 'tool', 'the lapsed call did not settle first');
  assertEquals(
    failureOf(lastTool([...eventsOf(first.lines), ...events], 'wake_paused_delete'))?.kind,
    'cancelled',
  );
  assertEquals(ran, []);
  assertEquals(seen.length, 2);
  const read = seen.at(-1) ?? [];
  const settled = read.at(-1);
  assertEquals(
    settled?.role === 'tool' ? settled.content : undefined,
    "Tool error (expired): Nobody answered the request to run 'wake_paused_delete' before it stopped waiting.",
  );
  assertEquals(saves, [{ ended: 'committed', blocks: ['tool', 'turn-done', 'text', 'turn-done'] }]);
  assert(!(await waits()), 'the reply still waits');
});

Deno.test('a wake with nothing to tell leaves a lapsed reply as it waits', async () => {
  const { core, seen, saves, ref, waits } = await paused(SHORT_MS);
  await lapse();
  assertEquals((await core.read(at(), { ref })).wake, undefined);
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assertEquals(end, { outcome: 'released' });
  assertEquals(seen.length, 1);
  assertEquals(saves, []);
  assert(await waits());
});

Deno.test('a wake waits while one of two gates is live', async () => {
  const { core, seen, sessions, ref, gates, due, waits } = await paused(LONG_MS, 2);
  const snapshot = await sessions.load(KEEPER);
  assert(snapshot, 'the session kept no state');
  const { [gates[0].operationId]: _lapsed, ...live } = snapshot.state.gates;
  await sessions.compareAndSwap(KEEPER, snapshot.revision, { ...snapshot.state, gates: live });
  due();
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assertEquals(end.outcome, 'held');
  assertEquals(seen.length, 1);
  assert(await waits());
});

Deno.test('a wake leaves a call alone while its answer runs', async () => {
  const { core, seen, ref, gates, due, waits } = await paused(SHORT_MS);
  let finish = () => {};
  running = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const answer = await core.answer(at(), { ...gates[0], conversation: ref, decision: 'approve' });
  const answering = drain(answer);
  while (ran.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await lapse();
  due();
  const woke = await drain(await core.wake(at(), { ref }));
  assertEquals(woke.lines, []);
  assertEquals(seen.length, 1, 'the wake ran the model');
  finish();
  const answered = await answering;
  assertEquals(toolPhases(eventsOf(answered.lines), 'wake_paused_delete').at(-1), 'complete');
  assertEquals(ran, ['record-1']);
  assert(!(await waits()));
});
