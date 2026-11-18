import { assert, assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type TurnHistoryMessage,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import {
  type CoreContext,
  createMemoryConversationStore,
  createTheoremConversationCore,
  type Reply,
  type ReplyLine,
  type RunEnd,
  type TheoremConversationStore,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'refuse_delete';
const KEEPER = 'person-1';
const LEASE_MS = 60_000;
const SHORT_MS = 20;
const LINE = 'You reached the limit for today.';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'refuse',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

registerFixtureProviders(defaultKernelScope);

const ran: string[] = [];
registerTool({
  type: 'function',
  name: TOOL,
  description: 'Delete a record',
  category: 'test',
  access: 'destructive',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.string() }),
  handler: (input) => {
    const { id } = z.object({ id: z.string() }).parse(input);
    ran.push(id);
    return { deleted: id };
  },
});

type Note = InboxItem<'note'>;
/** `quiet` is the policy of an app that would refuse: it tells no item, at any opening. */
type Refusing = { reply: boolean; call: boolean; quiet: boolean };

/** A model that keeps each history it read; `gated` makes its first step call the gated tool. */
function model(seen: (TurnHistoryMessage[] | undefined)[], gated: boolean): TurnModel {
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req.history);
        if (gated && seen.length === 1) {
          yield {
            type: 'tool' as const,
            tool: { name: TOOL, arguments: { id: 'record-1' }, callId: 'call-1' },
          };
          yield { type: 'done' as const, stop: { kind: 'tool' } };
          return;
        }
        yield { type: 'text' as const, text: 'Sure.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
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

function refOf(lines: readonly ReplyLine[]): string {
  let ref = '';
  for (const line of lines) if (line.type === 'conversation') ref = line.ref;
  assert(ref !== '', 'the run named no conversation');
  return ref;
}

function textOf(lines: readonly ReplyLine[]): string[] {
  return lines.flatMap((line) => (line.type === 'text' ? [line.text] : []));
}

/** A core whose `prepare` refuses a reply, or an answered call's turn, as `refusing` says. */
function app(options: { gated?: boolean; gateTtlMs?: number; marks?: boolean } = {}) {
  ran.length = 0;
  const seen: (TurnHistoryMessage[] | undefined)[] = [];
  const refusing: Refusing = { reply: false, call: false, quiet: false };
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const memory = createMemoryConversationStore();
  /** A store that marks told what the reply told, in its write, as an app's store does. */
  const conversations: TheoremConversationStore = {
    ...memory,
    write: async (sessionId, ref, expected, next, context) => {
      const result = await memory.write(sessionId, ref, expected, next, context);
      if (result.written && context?.hold && context.reply) {
        await inbox.settle(KEEPER, context.hold, context.reply, context.told);
      }
      return result;
    },
  };
  const saves: { ended: string; blocks: string[]; hosts: unknown[] }[] = [];
  const after: string[] = [];
  const core = createTheoremConversationCore<Note>({
    profile: PROFILE,
    provider: () => fixtureHostOptions(model(seen, options.gated === true)),
    conversationStore: conversations,
    ...(options.gateTtlMs === undefined ? {} : { gateTtlMs: options.gateTtlMs }),
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items) => ({ tell: refusing.quiet ? [] : items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
    }),
    prepare: (turn) => {
      const refuse = turn.answersHeldCall ? refusing.call : refusing.reply;
      return refuse ? { refuse: { text: LINE, host: { cause: 'daily_limit' } } } : turn;
    },
    beforeSave: (_at, reply) => {
      saves.push({
        ended: reply.ended,
        blocks: reply.blocks.map((block) => block.kind),
        hosts: reply.blocks.flatMap((block) => (block.host ? [block.host] : [])),
      });
      return Promise.resolve({
        blocks: reply.blocks,
        told: options.marks === false ? [] : (reply.held?.opened.map((item) => item.id) ?? []),
      });
    },
    afterSave: (_at, saved) => {
      after.push(`${saved.ended}:${saved.told.join(',')}`);
      return Promise.resolve();
    },
  });
  const transcript = async (ref: string) =>
    (await conversations.read(KEEPER, ref))?.conversation.transcript ?? [];
  return { core, seen, refusing, inbox, saves, after, transcript };
}

Deno.test('a refused reply is the app’s line: no model runs, and it saves as refused', async () => {
  const { core, seen, refusing, saves, after, transcript } = app();
  refusing.reply = true;
  const { lines, end } = await drain(await core.message(at(), { input: { text: 'hello' } }));
  assertEquals(end, { outcome: 'released' });
  assertEquals(textOf(lines), [LINE]);
  assertEquals(seen.length, 0, 'the model ran');
  assertEquals(saves, [
    { ended: 'refused', blocks: ['text', 'turn-done'], hosts: [{ cause: 'daily_limit' }] },
  ]);
  assertEquals(after, ['refused:']);
  const blocks = await transcript(refOf(lines));
  assertEquals(
    blocks.some((block) => block.kind === 'error'),
    false,
  );

  refusing.reply = false;
  await drain(await core.message(at(), { ref: refOf(lines), input: { text: 'again' } }));
  const read = seen.at(-1) ?? [];
  assertEquals(
    read.slice(0, 2).map((message) => [message.role, message.content]),
    [
      ['user', 'hello'],
      ['assistant', LINE],
    ],
  );
});

Deno.test('a refused reply tells the items it opened with, and the run lets the conversation go', async () => {
  const { core, refusing, inbox, after } = app();
  refusing.reply = true;
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const { end } = await drain(await core.message(at(), { input: { text: 'hello' } }));
  assertEquals(end, { outcome: 'released' });
  assertEquals(after, ['refused:note-1']);
  assertEquals((await inbox.read(KEEPER)).items, []);
});

Deno.test('a reply that goes on after an answered call can be refused', async () => {
  const { core, seen, refusing, saves } = app({ gated: true });
  const paused = await drain(await core.message(at(), { input: { text: 'delete it' } }));
  const gate = paused.lines.flatMap((line) =>
    line.type === 'tool' && line.tool.phase === 'gate' && line.tool.operationId
      ? [{ gateId: line.tool.callId, operationId: line.tool.operationId }]
      : [],
  )[0];
  assert(gate, 'the reply did not pause');
  saves.length = 0;
  refusing.reply = true;
  const { lines, end } = await drain(
    await core.answer(at(), { ...gate, conversation: refOf(paused.lines), decision: 'approve' }),
  );
  assertEquals(end, { outcome: 'released' });
  assertEquals(ran, ['record-1']);
  assertEquals(textOf(lines), [LINE]);
  assertEquals(seen.length, 1, 'the model ran again');
  assertEquals(saves.at(-1)?.ended, 'refused');
  assertEquals(saves.at(-1)?.blocks.slice(-2), ['text', 'turn-done']);
});

Deno.test('an answered call has no reply to refuse: the call does not run', async () => {
  const { core, refusing } = app({ gated: true });
  const paused = await drain(await core.message(at(), { input: { text: 'delete it' } }));
  const gate = paused.lines.flatMap((line) =>
    line.type === 'tool' && line.tool.phase === 'gate' && line.tool.operationId
      ? [{ gateId: line.tool.callId, operationId: line.tool.operationId }]
      : [],
  )[0];
  assert(gate, 'the reply did not pause');
  refusing.call = true;
  await assertRejects(
    async () =>
      drain(
        await core.answer(at(), {
          ...gate,
          conversation: refOf(paused.lines),
          decision: 'approve',
        }),
      ),
    Error,
    'answersHeldCall',
  );
  assertEquals(ran, []);
});

Deno.test('a wake that walks away from lapsed gates can be refused, in one save', async () => {
  const { core, seen, refusing, inbox, saves } = app({ gated: true, gateTtlMs: SHORT_MS });
  const paused = await drain(await core.message(at(), { input: { text: 'delete it' } }));
  await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 3));
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  saves.length = 0;
  refusing.reply = true;
  const { lines, end } = await drain(await core.wake(at(), { ref: refOf(paused.lines) }));
  assertEquals(end, { outcome: 'released' });
  assertEquals(textOf(lines), [LINE]);
  assertEquals(seen.length, 1);
  assertEquals(
    saves.map((save) => [save.ended, save.blocks]),
    [['refused', ['tool', 'turn-done', 'text', 'turn-done']]],
  );
});

Deno.test('an app that would refuse tells no item: a wake says nothing, and a refused message is one line', async () => {
  const { core, seen, refusing, inbox, saves } = app();
  const first = await drain(await core.message(at(), { input: { text: 'hello' } }));
  const ref = refOf(first.lines);
  saves.length = 0;
  refusing.reply = true;
  refusing.quiet = true;
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });

  assertEquals((await core.read(at(), { ref })).wake, undefined);
  const woke = await drain(await core.wake(at(), { ref }));
  assertEquals(woke, { lines: [], end: { outcome: 'released' } });
  assertEquals(saves, []);

  const refused = await drain(await core.message(at(), { ref, input: { text: 'again' } }));
  assertEquals(refused.end, { outcome: 'released' });
  assertEquals(textOf(refused.lines), [LINE]);
  assertEquals(
    saves.map((save) => save.ended),
    ['refused'],
  );
  assertEquals(seen.length, 1, 'the model ran for a refused reply');
  assertEquals(
    (await inbox.read(KEEPER)).items.map((item) => item.id),
    ['note-1'],
  );

  refusing.reply = false;
  refusing.quiet = false;
  assertEquals((await core.read(at(), { ref })).wake, true);
});

Deno.test('a refused reply that leaves a told item unmarked ends continue, and the follow-up saves the line again', async () => {
  const { core, refusing, inbox, saves } = app({ marks: false });
  refusing.reply = true;
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  const first = await drain(await core.message(at(), { input: { text: 'hello' } }));
  assert(first.end.outcome === 'continue', 'the run let the conversation go');
  const next = await drain(
    await core.followUp(at(), { ref: refOf(first.lines), hold: first.end.hold }),
  );
  assertEquals(next.end.outcome, 'continue');
  assertEquals(
    saves.map((save) => save.ended),
    ['refused', 'refused'],
  );
  await core.release(at(), { ref: refOf(next.lines), hold: first.end.hold });
});
