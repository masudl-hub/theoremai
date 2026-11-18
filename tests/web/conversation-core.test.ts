import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  defaultKernelScope,
  type ModelRequest,
  type ProfileDefinition,
  TheoremError,
  type TurnModel,
} from '../../mod.ts';
import { createMemoryInbox, type InboxItem } from '../../src/conversation/mod.ts';
import {
  type ConversationCore,
  type CoreContext,
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremConversationCore,
  type Reply,
  type ReplyLine,
  type RunEnd,
  type TheoremConversationCoreOptions,
  tellEveryResult,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-core',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const KEEPER = 'person-1';
const LEASE_MS = 60_000;

registerFixtureProviders(defaultKernelScope);

type Note = InboxItem<'note'>;

/** A model that answers in text, once `gate` lets it; `started` resolves as each request arrives. */
function answerer(seen: ModelRequest[], gate: { until: Promise<void>; started: () => void }) {
  const model: TurnModel = {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        gate.started();
        await gate.until;
        yield { type: 'text' as const, text: 'Done.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
  return model;
}

function harness(options: Partial<TheoremConversationCoreOptions<Note>> = {}) {
  const seen: ModelRequest[] = [];
  let free = () => {};
  let started = () => {};
  const gate = {
    until: Promise.resolve(),
    started: () => started(),
  };
  const core = createTheoremConversationCore<Note>({
    profile: PROFILE,
    provider: () => fixtureHostOptions(answerer(seen, gate)),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    ...options,
  });
  return {
    core,
    seen,
    /** Makes the model wait, and resolves once it has a request. */
    hold() {
      gate.until = new Promise<void>((resolve) => {
        free = resolve;
      });
      return new Promise<void>((resolve) => {
        started = resolve;
      });
    },
    free: () => free(),
  };
}

function at(sessionId = KEEPER): CoreContext {
  return { sessionId, signal: new AbortController().signal };
}

/** A run's lines, then how it ended. */
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

async function say(core: ConversationCore, text: string, ref?: string) {
  return drain(await core.message(at(), { ...(ref ? { ref } : {}), input: { text } }));
}

Deno.test('a message runs with no request, and its lines end with how the run ended', async () => {
  const { core, seen } = harness();
  const { lines, end } = await say(core, 'hello');
  assertEquals(end, { outcome: 'released' });
  assertEquals(seen.length, 1);
  const view = await core.read(at(), { ref: refOf(lines) });
  assertEquals(
    view.transcript.map((block) => block.kind),
    ['user-text', 'text', 'turn-done'],
  );
});

Deno.test("a reply holds the conversation in the app's inbox while it runs", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core, hold, free } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: () => ({ tell: [] }),
      leaseMs: LEASE_MS,
    }),
  });
  const running = hold();
  const reply = say(core, 'hello');
  await running;
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'held');
  free();
  assertEquals((await reply).end, { outcome: 'released' });
  assertEquals((await inbox.open(KEEPER, 'another-hold')).outcome, 'opened');
});

Deno.test('a wake that finds the conversation held runs nothing and says until when', async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core, seen } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items) => ({ tell: items.map((item) => item.id) }),
      leaseMs: LEASE_MS,
    }),
  });
  const ref = refOf((await say(core, 'hello')).lines);
  await inbox.open(KEEPER, 'another-hold');
  const before = Date.now();
  const { lines, end } = await drain(await core.wake(at(), { ref }));
  assertEquals(lines, []);
  assert(end.outcome === 'held' && end.leasedUntil >= before + LEASE_MS);
  assertEquals(seen.length, 1);
});

Deno.test("a page is told to wake when the app's policy tells a waiting item to a wake", async () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const { core } = harness({
    inbox: () => ({
      inbox,
      conversation: KEEPER,
      policy: (items, moment) => ({
        tell: moment.opening === 'wake' ? items.map((item) => item.id) : [],
      }),
      leaseMs: LEASE_MS,
    }),
  });
  const ref = refOf((await say(core, 'hello')).lines);
  assertEquals((await core.read(at(), { ref })).wake, undefined);
  inbox.arrive(KEEPER, { id: 'note-1', kind: 'note', handovers: [] });
  assertEquals((await core.read(at(), { ref })).wake, true);
});

Deno.test("the app's inbox and a late-results decider are refused together", () => {
  const inbox = createMemoryInbox<Note>({ leaseMs: LEASE_MS });
  const error = assertThrows(
    () =>
      harness({
        inbox: () => ({
          inbox,
          conversation: KEEPER,
          policy: () => ({ tell: [] }),
          leaseMs: LEASE_MS,
        }),
        lateResultsDecider: tellEveryResult,
        wake: () => Promise.resolve(),
      }),
    TheoremError,
  );
  assertEquals(error.kind, 'config');
});

Deno.test('a late-results decider needs the wake it calls', () => {
  const error = assertThrows(() => harness({ lateResultsDecider: tellEveryResult }), TheoremError);
  assertEquals(error.kind, 'config');
});
