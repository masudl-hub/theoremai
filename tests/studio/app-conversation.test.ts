import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  defineProfile,
  type ProfileDefinition,
  registerProfile,
  type TurnModel,
} from '../../mod.ts';
import { preparedRequest } from '../../src/cli/setup.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import type { StudioConversation } from '../../studio/conversation.ts';
import { newConversationKey } from '../../studio/conversation-key.ts';
import { createStudioHandler } from '../../studio/server/handler.ts';
import {
  type ChatLine,
  createHttpTransport,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import {
  type ConversationCore,
  createMemoryConversationStore,
  createTheoremConversationCore,
  createTheoremHandler,
  emptyConversation,
  type MessageIntake,
  type TheoremConversationStore,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

const HOST = '127.0.0.1:4983';
const BASE = `http://${HOST}/api/studio`;
const KEEPER = 'keeper-1';
const LEASE_MS = 60_000;
const LINE = 'Your plan has no replies left today.';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'app-conversation-desk',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

registerFixtureProviders(defaultKernelScope);
registerProfile(defineProfile(PROFILE));

type Sent = InboxItem<'message'>;
const itemId = (id: string) => `message:${id}`;
const rowId = (id: string) => `row:${id}`;

/** A model that counts its runs, and answers once `until` settles. */
function model(runs: { count: number }, until?: Promise<void>): TurnModel {
  return {
    complete: () =>
      (async function* () {
        runs.count += 1;
        await until;
        yield { type: 'text' as const, text: 'Sure.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function gate(): { until: Promise<void>; free(): void } {
  let free = () => {};
  const until = new Promise<void>((resolve) => {
    free = resolve;
  });
  return { until, free };
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > 2000) return reject(new Error('the wait ran out'));
      setTimeout(tick, 1);
    };
    tick();
  });
}

/** The studio's page: keeps the session cookie the handler issues. */
function page(handler: (request: Request) => Promise<Response>): TheoremTransport {
  let cookie = '';
  return createHttpTransport({
    endpoint: `${BASE}/profiles/${PROFILE.id}`,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('host', HOST);
      if (cookie) headers.set('cookie', cookie);
      const response = await handler(new Request(url, { ...init, headers }));
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0] ?? '';
      return response;
    },
  });
}

async function turn(transport: TheoremTransport, body: Parameters<TheoremTransport['turn']>[0]) {
  const lines: ChatLine[] = [];
  await transport.turn(body, (line) => lines.push(line));
  return lines;
}

const textOf = (lines: readonly ChatLine[]) =>
  lines.flatMap((line) => (line.type === 'text' ? [line.text] : []));

/**
 * The app's own side: a conversation core on its own store and inbox, its save of each message,
 * and a record of the core calls the studio makes.
 */
function appSide(until?: Promise<void>, refuse = false) {
  const runs = { count: 0 };
  const calls: string[] = [];
  const texts = new Map<string, string>();
  const inbox = createMemoryInbox<Sent>({ leaseMs: LEASE_MS });
  const memory = createMemoryConversationStore();
  const store: TheoremConversationStore = {
    ...memory,
    write: async (sessionId, at, expected, next, context) => {
      const result = await memory.write(sessionId, at, expected, next, context);
      if (result.written && context?.hold && context.reply) {
        inbox.settle(KEEPER, context.hold, context.reply, context.told);
      }
      return result;
    },
  };
  let ref: string | undefined;
  let session = '';
  const built = createTheoremConversationCore<Sent>({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions(model(runs, until)),
    conversationStore: store,
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
    }),
    prepare: (prepared) => (refuse ? { refuse: { text: LINE } } : prepared),
    beforeSave: (_at, reply) => {
      const told = [
        ...(reply.held?.opened.map((item) => item.id) ?? []),
        ...reply.landed.filter((id) => id.startsWith('message:')),
      ];
      const shown = new Set(reply.blocks.map((block) => block.id));
      const read = told.flatMap((id) => {
        const sentId = id.slice('message:'.length);
        return shown.has(rowId(sentId)) || reply.landed.includes(id)
          ? []
          : [{ id: rowId(sentId), kind: 'user-text' as const, text: texts.get(sentId) ?? '' }];
      });
      return Promise.resolve({ blocks: [...read, ...reply.blocks], told });
    },
  });
  const core: ConversationCore = {
    ...built,
    message: (at, args) => {
      calls.push(`message:${args.saved?.hold ?? 'unsaved'}`);
      return built.message(at, args);
    },
    followUp: (at, args) => {
      calls.push('followUp');
      return built.followUp(at, args);
    },
    release: (at, args) => {
      calls.push('release');
      return built.release(at, args);
    },
  };
  const intake: StudioConversation['intake'] = async (at, sent): Promise<MessageIntake> => {
    session = at.sessionId;
    if (ref === undefined) {
      const made = await store.write(at.sessionId, null, null, emptyConversation());
      assert(made.written, 'the app made no conversation');
      ref = made.ref;
    }
    const names = { ref, landsAs: [itemId(sent.id), rowId(sent.id)] };
    if (texts.has(sent.id)) return { outcome: 'saved', ...names };
    texts.set(sent.id, sent.message.text ?? '');
    inbox.arrive(KEEPER, { id: itemId(sent.id), kind: 'message', handovers: [] });
    const hold = `hold:${sent.id}`;
    if ((await inbox.open(KEEPER, hold)).outcome === 'held') return { outcome: 'saved', ...names };
    return {
      outcome: 'opened',
      ...names,
      hold,
      blocks: [{ id: rowId(sent.id), kind: 'user-text', text: sent.message.text ?? '' }],
    };
  };
  const transcript = async () =>
    ref ? ((await store.read(session, ref))?.conversation.transcript ?? []) : [];
  return { core, intake, runs, calls, transcript, texts, refOf: () => ref ?? '' };
}

/** The studio on this profile, with the app's conversation when it gives one. */
function studio(
  runs: { count: number },
  extra: Partial<Parameters<typeof createStudioHandler>[0]> = {},
) {
  return createStudioHandler({
    conversationKey: newConversationKey(),
    project: 'app-conversation',
    pageOrigins: [],
    listenHost: HOST,
    provider: fixtureHostOptions(model(runs)),
    ...extra,
  });
}

Deno.test("without the field, the studio's chat runs on the studio's own conversation", async () => {
  const runs = { count: 0 };
  const transport = page(studio(runs));
  const lines = await turn(transport, { input: { text: 'hello' } });
  assertEquals(runs.count, 1);
  assertEquals(textOf(lines), ['Sure.']);
  // A store's ref can change with each write, so the page reads under the last one it was told.
  const ref = lines.flatMap((line) => (line.type === 'conversation' ? [line.ref] : [])).at(-1);
  assert(ref, 'the studio kept no conversation');
  const view = await transport.conversation({ conversation: ref });
  assertEquals(view.transcript.map((block) => block.kind).slice(0, 2), ['user-text', 'text']);
});

Deno.test("without the field, the studio's own prepare can refuse a reply with a line", async () => {
  const runs = { count: 0 };
  const transport = page(
    studio(runs, { prepare: () => ({ refuse: { text: LINE, host: { cause: 'daily_limit' } } }) }),
  );
  const lines = await turn(transport, { input: { text: 'hello' } });
  assertEquals(textOf(lines), [LINE]);
  assertEquals(runs.count, 0, 'the model ran');
});

Deno.test('a refused turn stops the CLI with the app’s line, and runs no model', async () => {
  await assertRejects(
    () =>
      preparedRequest(() => ({ refuse: { text: LINE } }), {
        profile: PROFILE.id,
        input: { text: 'hi' },
      }),
    Error,
    LINE,
  );
});

Deno.test("with the field, the reply runs through the app's core and saves in the app's conversation", async () => {
  const side = appSide();
  const studioRuns = { count: 0 };
  const transport = page(
    studio(studioRuns, {
      conversation: (id) =>
        id === PROFILE.id ? { core: side.core, intake: side.intake } : undefined,
      // Not called for this agent: the app's core brings its own turn.
      prepare: () => {
        throw new Error('the studio ran its own prepare');
      },
    }),
  );
  const lines = await turn(transport, { id: 'm1', input: { text: 'hello' } });
  assertEquals(side.calls, ['message:hold:m1']);
  assertEquals(side.runs.count, 1);
  assertEquals(studioRuns.count, 0, "the studio's own provider ran");
  assertEquals(textOf(lines), ['Sure.']);
  const view = await transport.conversation({ conversation: side.refOf() });
  assertEquals(view.transcript.map((block) => block.kind).slice(0, 2), ['user-text', 'text']);
  assertEquals((await side.transcript()).map((block) => block.kind).slice(0, 2), [
    'user-text',
    'text',
  ]);
});

Deno.test("with the field, a message that arrives mid-turn is answered by a follow-up on the app's core when the reply ends", async () => {
  const { until, free } = gate();
  const side = appSide(until);
  const transport = page(
    studio(
      { count: 0 },
      {
        conversation: () => ({
          core: side.core,
          intake: side.intake,
          onContinue: () => 'here',
        }),
      },
    ),
  );
  const first = turn(transport, { id: 'm1', turnId: 't1', input: { text: 'first' } });
  await waitFor(() => side.runs.count === 1);
  await transport.steer({
    turnId: 't1',
    id: 'm2',
    conversation: side.refOf(),
    input: { text: 'second' },
  });
  free();
  await first;
  assertEquals(side.calls, ['message:hold:m1', 'followUp']);
  assertEquals(side.runs.count, 2);
  assertEquals(
    (await side.transcript()).flatMap((block) => (block.kind === 'user-text' ? [block.text] : [])),
    ['first', 'second'],
  );
});

Deno.test("with the field, the app's refusal is the reply, with no model run", async () => {
  const side = appSide(undefined, true);
  const transport = page(
    studio({ count: 0 }, { conversation: () => ({ core: side.core, intake: side.intake }) }),
  );
  const lines = await turn(transport, { id: 'm1', input: { text: 'hello' } });
  assertEquals(textOf(lines), [LINE]);
  assertEquals(side.runs.count, 0);
});

Deno.test('with the field, a replay that goes on live is refused in words, and another agent keeps the studio’s own', async () => {
  const side = appSide();
  const handler = studio(
    { count: 0 },
    { conversation: () => ({ core: side.core, intake: side.intake }) },
  );
  const response = await handler(
    new Request(`${BASE}/profiles/${PROFILE.id}/conversation/start`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: [] }),
    }),
  );
  assertEquals(response.status, 409);
  const body: { error?: string } = await response.json();
  assert(body.error?.includes("app's own conversation"), body.error);

  const left = { count: 0 };
  const other = page(studio(left, { conversation: () => undefined }));
  await turn(other, { input: { text: 'hello' } });
  assertEquals(left.count, 1);
});

Deno.test('the handler refuses a `core` beside an option the core brings itself', () => {
  const side = appSide();
  const handler = (more: object) => () =>
    createTheoremHandler({
      operationRetentionMs: TEST_OPERATION_RETENTION_MS,
      profile: PROFILE,
      provider: () => fixtureHostOptions(model({ count: 0 })),
      conversationStore: createMemoryConversationStore(),
      core: side.core,
      ...more,
    });
  assertThrows(handler({ prepare: (turn: unknown) => turn }));
  assertThrows(handler({ lateResultsDecider: { policy: () => ({ tell: [] }) } }));
  handler({ intake: side.intake })();
});
