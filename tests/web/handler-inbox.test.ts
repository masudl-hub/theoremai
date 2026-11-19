import { assert, assertEquals, assertThrows } from '@std/assert';
import { z } from 'zod';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import {
  type ChatLine,
  createHttpTransport,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createTheoremHandler,
  type TheoremHandlerOptions,
  tellEveryResult,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'handler_inbox_delete';
const KEEPER = 'person-1';
const LEASE_MS = 60_000;

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'handler-inbox',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

registerFixtureProviders(defaultKernelScope);
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
  handler: (input) => ({ deleted: z.object({ id: z.string() }).parse(input).id }),
});

type Note = InboxItem<'note'>;
type Script = { gated?: boolean; until?: Promise<void> };

/** A model that keeps the user lines it read; `gated` makes its first step call the gated tool. */
function model(read: string[][], script: Script): TurnModel {
  return {
    complete: (req) =>
      (async function* () {
        read.push(
          (req.history ?? []).flatMap((message) =>
            message.role === 'user' && message.content ? [message.content] : [],
          ),
        );
        if (script.gated && read.length === 1) {
          yield {
            type: 'tool' as const,
            tool: { name: TOOL, arguments: { id: 'record-1' }, callId: 'call-1' },
          };
          yield { type: 'done' as const, stop: { kind: 'tool' } };
          return;
        }
        await script.until;
        yield { type: 'text' as const, text: 'Sure.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

/** A browser on the handler: keeps the session cookie it issues. */
function browserFor(handler: (request: Request) => Promise<Response>): TheoremTransport {
  let cookie = '';
  return createHttpTransport({
    endpoint: 'https://app.test/api/theorem',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      return response;
    },
  });
}

function refOf(lines: readonly ChatLine[]): string {
  let ref = '';
  for (const line of lines) if (line.type === 'conversation') ref = line.ref;
  assert(ref !== '', 'the run named no conversation');
  return ref;
}

/** A handler whose replies run under the app's own inbox, and what its save steps were given. */
function app(script: Script = {}, more: Partial<TheoremHandlerOptions<Note>> = {}) {
  const read: string[][] = [];
  const steps: string[] = [];
  const hosts: unknown[] = [];
  const asked = { host: 0 };
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const options: TheoremHandlerOptions<Note> = {
    profile: PROFILE,
    provider: () => fixtureHostOptions(model(read, script)),
    conversationStore: createMemoryConversationStore(),
    host: () => {
      asked.host += 1;
      return Promise.resolve({ keeper: KEEPER });
    },
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'wake' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
    beforeSave: async (at, reply) => {
      steps.push(`before:${reply.ended}`);
      hosts.push(await at.host);
      return { blocks: reply.blocks, told: reply.held?.opened.map((item) => item.id) ?? [] };
    },
    afterSave: async (at, saved) => {
      steps.push(`after:${saved.ended}:${saved.told.join(',')}`);
      hosts.push(await at.host);
    },
    ...more,
  };
  const transport = browserFor(createTheoremHandler(options));
  const run = async (send: (onLine: (line: ChatLine) => void) => Promise<void> | undefined) => {
    const lines: ChatLine[] = [];
    await send((line) => lines.push(line));
    return lines;
  };
  return { transport, run, read, steps, hosts, asked, inbox, options };
}

Deno.test("a page's reply runs under the app's inbox, and the app's steps run around its save", async () => {
  const { transport, run, steps, hosts, asked } = app();
  await run((onLine) => transport.turn({ input: { text: 'hello' } }, onLine));
  assertEquals(steps, ['before:committed', 'after:committed:']);
  assertEquals(hosts, [{ keeper: KEEPER }, { keeper: KEEPER }]);
  assertEquals(asked.host, 1, "the request's `host` was asked more than once");
});

Deno.test("an answered call's reply saves through the app's steps too", async () => {
  const { transport, run, steps } = app({ gated: true });
  const paused = await run((onLine) => transport.turn({ input: { text: 'delete it' } }, onLine));
  const gate = paused.flatMap((line) =>
    line.type === 'tool' && line.tool.phase === 'gate' && line.tool.operationId
      ? [{ gateId: line.tool.callId, operationId: line.tool.operationId }]
      : [],
  )[0];
  assert(gate, 'the reply did not pause');
  assertEquals(steps, ['before:paused', 'after:paused:']);
  steps.length = 0;
  await run((onLine) =>
    transport.invoke({ ...gate, conversation: refOf(paused), decision: 'approve' }, onLine),
  );
  assertEquals(steps, ['before:committed', 'after:committed:']);
});

Deno.test("a page listens on the app's notifier with no call running, and not without one", async () => {
  const on = app({}, { notifier: createMemoryNotifier(), notifyRetryMs: 25 });
  const heard = await on.run((onLine) => on.transport.turn({ input: { text: 'hello' } }, onLine));
  const view = await on.transport.conversation({ conversation: refOf(heard) });
  assertEquals(
    view.transcript.filter((block) => block.kind === 'tool'),
    [],
  );
  assertEquals(view.notify, { retryMs: 25 });
  const off = app();
  const quiet = await off.run((onLine) => off.transport.turn({ input: { text: 'hello' } }, onLine));
  assertEquals(
    (await off.transport.conversation({ conversation: refOf(quiet) })).notify,
    undefined,
  );
});

Deno.test("a page's wake tells an item that waits in the app's inbox", async () => {
  const { transport, run, read, steps, inbox } = app();
  const first = await run((onLine) => transport.turn({ input: { text: 'hello' } }, onLine));
  const ref = refOf(first);
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  assertEquals((await transport.conversation({ conversation: ref })).wake, true);
  steps.length = 0;
  await run((onLine) => transport.wake?.({ conversation: ref }, onLine));
  assertEquals(read.length, 2, 'the wake ran no reply');
  assertEquals(steps, ['before:committed', 'after:committed:note-1']);
});

Deno.test("a steer reaches the running reply itself, not the app's inbox", async () => {
  let free = () => {};
  const script: Script = {
    until: new Promise<void>((resolve) => {
      free = resolve;
    }),
  };
  const { transport, run, read, inbox } = app(script);
  const turn = run((onLine) =>
    transport.turn({ input: { text: 'first' }, turnId: 'turn-1' }, onLine),
  );
  while (read.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  await transport.steer({
    turnId: 'turn-1',
    id: 'steer-1',
    input: { text: 'steered' },
  });
  free();
  const lines = await turn;
  assertEquals(
    lines.flatMap((line) => (line.type === 'stage' ? (line.injected ?? []) : [])),
    [{ id: 'steer-1', messages: [{ role: 'user', content: 'steered' }] }],
  );
  assertEquals((await inbox.read(KEEPER)).items, []);
});

Deno.test("a page reads the app's refusal as the reply, with no failure", async () => {
  const { run, read, steps, options } = app();
  const transport = browserFor(
    createTheoremHandler({
      ...options,
      prepare: () => ({ refuse: { text: 'You reached the limit for today.' } }),
    }),
  );
  const lines = await run((onLine) => transport.turn({ input: { text: 'hello' } }, onLine));
  assertEquals(
    lines.flatMap((line) => (line.type === 'text' ? [line.text] : [])),
    ['You reached the limit for today.'],
  );
  assertEquals(read.length, 0, 'the model ran');
  assertEquals(steps, ['before:refused', 'after:refused:']);
  const view = await transport.conversation({ conversation: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => block.kind),
    ['user-text', 'text', 'turn-done'],
  );
});

Deno.test("a handler refuses the app's inbox beside a decider for the session's", () => {
  const { options } = app();
  assertThrows(
    () => createTheoremHandler({ ...options, lateResultsDecider: tellEveryResult }),
    Error,
    'not both',
  );
});
