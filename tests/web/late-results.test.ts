import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type LateResultsDecider,
  labelText,
  type ModelRequest,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnEvent,
  type TurnModel,
  type TurnWiring,
  z,
} from '../../mod.ts';
import { gatedToolsFromEvents } from '../../src/interface/mod.ts';
import { createHttpTransport, type TheoremTransport } from '../../web/src/client/transport.ts';
import { issuedOperationId } from '../../web/src/client/turn-client.ts';
import { answerReply, readerConversationHost } from '../../web/src/server/conversation.ts';
import {
  createMemoryConversationStore,
  createMemorySessionStore,
  createTheoremHandler,
  tellEveryResult,
} from '../../web/src/server/mod.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { atOpen } from '../fixtures/late-results.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_late_result_job';
const ASK = 'web_late_result_ask';

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-late-results',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL, ASK] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

const held = { until: Promise.resolve(), free: () => {}, fail: false };

registerFixtureProviders(defaultKernelScope);
registerTool({
  type: 'function',
  name: TOOL,
  description: 'A slow job.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'auto',
  background: 'always',
  input: z.strictObject({}),
  output: z.object({ done: z.string() }),
  handler: async () => {
    await held.until;
    if (held.fail) throw new Error('the-late-failure');
    return { done: 'the-late-answer' };
  },
});

registerTool({
  type: 'function',
  name: ASK,
  description: 'Asks first.',
  category: 'test',
  access: 'read-only',
  paths: ['*'],
  loadTier: 'T0',
  permission: 'always_confirm',
  input: z.strictObject({}),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

/** Steps on which the model calls the gated tool instead. */
const askSteps = new Set<number>();

/** Steps besides the first on which the model calls the tool, with the same call id. */
const toolSteps = new Set<number>();

/** A step on which the model says a little, then waits on `until` before it ends. */
const slowStep = { step: 0, until: Promise.resolve() };

/** A model that calls the tool on its first step and answers in text after; it keeps every request. */
function caller(seen: ModelRequest[]): TurnModel {
  let step = 0;
  return {
    complete: (req) =>
      (async function* () {
        seen.push(req);
        await Promise.resolve();
        step += 1;
        if (askSteps.has(step)) {
          yield {
            type: 'tool' as const,
            tool: { name: ASK, callId: `ask_${step}`, arguments: {} },
          };
          return;
        }
        if (step === 1 || toolSteps.has(step)) {
          yield { type: 'tool' as const, tool: { name: TOOL, callId: 'call_1', arguments: {} } };
          return;
        }
        if (step === slowStep.step) {
          yield { type: 'text' as const, text: 'First half, ' };
          await slowStep.until;
        }
        yield { type: 'text' as const, text: 'Noted.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function harness(
  authorizeToolReplay?: () => boolean,
  prepare?: TurnWiring['prepare'],
  options: { operationRetentionMs?: number; decider?: LateResultsDecider } = {},
) {
  held.until = new Promise<void>((resolve) => {
    held.free = resolve;
  });
  const handles: ToolBackgroundHandle[] = [];
  const seen: ModelRequest[] = [];
  const model = caller(seen);
  const conversationStore = createMemoryConversationStore();
  const handler = createTheoremHandler({
    profile: PROFILE,
    provider: () => fixtureHostOptions(model),
    conversationStore,
    sessionStore: createMemorySessionStore(),
    session: () => 'one-person',
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
    lateResultsDecider: options.decider ?? tellEveryResult,
    ...(options.operationRetentionMs ? { operationRetentionMs: options.operationRetentionMs } : {}),
    ...(authorizeToolReplay ? { authorizeToolReplay } : {}),
    ...(prepare ? { prepare } : {}),
  });
  const transport: TheoremTransport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  return { transport, handles, seen, conversationStore };
}

async function say(transport: TheoremTransport, text: string, conversation?: string) {
  let ref = conversation ?? '';
  await transport.turn({ input: { text }, ...(conversation ? { conversation } : {}) }, (line) => {
    if (line.type === 'conversation') ref = line.ref;
  });
  return ref;
}

/** How many of the model's requests read the late answer. */
const reads = (seen: ModelRequest[], from: number) =>
  seen.slice(from).filter((req) => JSON.stringify(req).includes('the-late-answer')).length;

Deno.test("the next turn reads a background call's result once it settles, and only once", async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0, 'the turn after the call settled did not read its result');
    const view = await transport.conversation({ conversation: ref });
    const late = view.transcript.filter((block) => block.kind === 'late-results');
    assertEquals(late.length, 1);
    await say(transport, 'and now?', ref);
    const after = await transport.conversation({ conversation: ref });
    assertEquals(after.transcript.filter((block) => block.kind === 'late-results').length, 1);
  } finally {
    held.free();
  }
});

Deno.test("an application's late results join the session's, and neither replaces the other", async () => {
  const own = 'the-application-answer';
  const outcome = {
    event: {
      type: 'tool' as const,
      tool: {
        phase: 'complete' as const,
        name: 'own_job',
        callId: 'own_call',
        operationId: 'own-op',
        output: { done: own },
        readBack: own,
        at: 0,
      },
    },
    effects: 'completed' as const,
    replay: { modelResult: { finding: own } },
  };
  let given = false;
  const { transport, handles, seen } = harness(undefined, (turn) => {
    if (given || !turn.lateResults) return turn;
    given = true;
    return { ...turn, lateResults: atOpen([outcome]) };
  });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0, "the session's result was dropped");
    const read = seen.slice(before).some((req) => JSON.stringify(req).includes(own));
    assert(read, "the application's result was dropped");
    const view = await transport.conversation({ conversation: ref });
    const ids = view.transcript.flatMap((b) => (b.kind === 'late-results' ? b.operationIds : []));
    assertEquals(ids.length, 2);
    assert(ids.includes('own-op'));
  } finally {
    held.free();
  }
});

Deno.test('a result the host withholds from this request is not read by its turn', async () => {
  const { transport, handles, seen } = harness(() => false);
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0);
  } finally {
    held.free();
  }
});

Deno.test('a second call with the same call id and the same answer is read too', async () => {
  const { transport, handles, seen } = harness();
  toolSteps.add(3);
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    await say(transport, 'again please', ref);
    await handles[1].done;
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assert(reads(seen, before) > 0);
    const view = await transport.conversation({ conversation: ref });
    const read = view.transcript.flatMap((b) => (b.kind === 'late-results' ? b.operationIds : []));
    assertEquals(read.length, 2);
    assertEquals(new Set(read).size, 2);
  } finally {
    toolSteps.clear();
    held.free();
  }
});

Deno.test('a call still running at the next turn is read once, after it settles', async () => {
  const { transport, handles, seen } = harness();
  try {
    const ref = await say(transport, 'start the job');
    const before = seen.length;
    await say(transport, 'any news?', ref);
    assertEquals(reads(seen, before), 0);
    held.free();
    await handles[0].done;
    await say(transport, 'and now?', ref);
    await say(transport, 'still there?', ref);
    const view = await transport.conversation({ conversation: ref });
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    held.free();
  }
});

Deno.test('a result that settles while a reply waits on an approval is read once, by the reply that goes on', async () => {
  const { transport, handles, seen } = harness();
  askSteps.add(3);
  try {
    const ref = await say(transport, 'start the job');
    const events: TurnEvent[] = [];
    await transport.turn({ conversation: ref, input: { text: 'check first' } }, (line) => {
      if (line.type !== 'conversation' && line.type !== 'unsupported' && line.type !== 'malformed')
        events.push(line);
    });
    const gate = toolEventsOf(events, 'gate').at(-1);
    assert(gate, 'expected the reply to pause on a gate');
    held.free();
    await handles[0].done;
    const before = seen.length;
    await transport.invoke(
      {
        conversation: ref,
        gateId: gate.callId,
        operationId: issuedOperationId(gate),
        decision: 'approve',
      },
      () => {},
    );
    assert(reads(seen, before) > 0, 'the reply that went on did not read it');
    const next = await say(transport, 'any news?', ref);
    const view = await transport.conversation({ conversation: next });
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    askSteps.clear();
    held.free();
  }
});

Deno.test('a reply the person stops keeps the result it read: the next reply has it in its history', async () => {
  const { transport, handles, seen } = harness();
  const going = Promise.withResolvers<void>();
  slowStep.step = 3;
  slowStep.until = going.promise;
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const turnId = 'turn-stopped';
    const stops: Promise<void>[] = [];
    let left = ref;
    await transport.turn({ conversation: ref, input: { text: 'any news?' }, turnId }, (line) => {
      if (line.type === 'conversation') left = line.ref;
      if (line.type === 'text') stops.push(transport.stop?.({ turnId }) ?? Promise.resolve());
    });
    await Promise.all(stops);
    going.resolve();
    assert(stops.length > 0, 'the reply was never stopped');
    const view = await transport.conversation({ conversation: left });
    assertEquals(view.transcript.filter((b) => b.kind === 'late-results').length, 1);
    assert(
      view.transcript.some((b) => b.kind === 'turn-done' && b.stop?.kind === 'cancelled'),
      'the reply did not end as stopped',
    );
    const before = seen.length;
    const next = await say(transport, 'and then?', left);
    assert(reads(seen, before) > 0, "the next reply's history lost the result");
    const after = await transport.conversation({ conversation: next });
    assertEquals(after.transcript.filter((b) => b.kind === 'late-results').length, 1);
  } finally {
    slowStep.step = 0;
    slowStep.until = Promise.resolve();
    going.resolve();
    held.free();
  }
});

Deno.test('a reply that goes on, compacts, and fails leaves no result it read in the history', async () => {
  const { transport, handles, conversationStore } = harness();
  askSteps.add(3);
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    const paused = await say(transport, 'check first', ref);
    const snapshot = await conversationStore.read('one-person', paused);
    assert(snapshot?.conversation.paused, 'expected the reply to pause on a gate');
    const { events } = snapshot.conversation.paused;
    assert(
      events.some((event) => event.type === 'late_results'),
      'the paused reply did not read the result',
    );
    const [gate] = gatedToolsFromEvents(events);
    assert(gate?.operationId, 'expected one gated call');
    const host = readerConversationHost({
      sessionId: 'one-person',
      store: conversationStore,
      profile: PROFILE,
      clientEvents: undefined,
    });
    const settled: TurnEvent = {
      type: 'tool',
      tool: {
        name: ASK,
        callId: gate.callId,
        operationId: gate.operationId,
        at: 0,
        phase: 'complete',
        output: { ok: true },
        readBack: 'ok',
      },
    };
    const lines = answerReply({
      host,
      opened: { ref: paused, revision: snapshot.revision, conversation: snapshot.conversation },
      call: { callId: gate.callId, operationId: gate.operationId },
      settling: (async function* () {
        yield settled;
      })(),
      runner: {
        signal: new AbortController().signal,
        compact: () => Promise.resolve(undefined),
        run: () =>
          (async function* (): AsyncGenerator<TurnEvent> {
            yield {
              type: 'compaction',
              timing: 'before',
              meter: 'history',
              tokensBefore: 10,
              unknownMedia: 0,
              messagesBefore: 4,
              messagesAfter: 1,
              outcome: 'compacted',
              history: [{ role: 'user', content: 'Summary: the job said the-late-answer.' }],
              summary: 'the job said the-late-answer',
              droppedMedia: 0,
            };
            throw new Error('the-model-broke');
          })(),
      },
    });
    let next = paused;
    const failed = await (async () => {
      try {
        for await (const line of lines) if (line.type === 'conversation') next = line.ref;
      } catch (err) {
        return err;
      }
    })();
    assert(failed instanceof Error, 'the failed reply did not throw');
    assertEquals(failed.message, 'the-model-broke');
    const after = await conversationStore.read('one-person', next);
    assert(after, 'the failed reply saved nothing');
    assertEquals(after.conversation.paused, undefined);
    assertEquals(
      JSON.stringify(after.conversation.history).includes('the-late-answer'),
      false,
      'the history keeps a result the failed reply gave back',
    );
    assert(
      JSON.stringify(after.conversation.history).includes('check first'),
      'the history lost the message the reply answered',
    );
  } finally {
    askSteps.clear();
    held.free();
  }
});

/** The late-results blocks of the chat that name `operationId`. */
async function toldBlocks(transport: TheoremTransport, ref: string, operationId: string) {
  const view = await transport.conversation({ conversation: ref });
  return view.transcript.filter(
    (block) => block.kind === 'late-results' && block.operationIds.includes(operationId),
  ).length;
}

const UNRESOLVED = labelText('tool.execution_uncertain');

Deno.test('a result the session no longer keeps is told as unresolved, once', async () => {
  const { transport, handles, seen } = harness(undefined, undefined, { operationRetentionMs: 1 });
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = seen.length;
    await say(transport, 'any news?', ref);
    const read = seen.slice(before).filter((req) => JSON.stringify(req).includes(UNRESOLVED));
    assert(read.length > 0, 'the turn after the result was dropped did not read that it was lost');
    assertEquals(await toldBlocks(transport, ref, handles[0].operationId), 1);
    await say(transport, 'and now?', ref);
    assertEquals(await toldBlocks(transport, ref, handles[0].operationId), 1);
  } finally {
    held.free();
  }
});

Deno.test('a call shut down with no end wakes the decider and is told as unresolved, once', async () => {
  const ended: string[] = [];
  const decider: LateResultsDecider = {
    policy: tellEveryResult.policy,
    ended: ({ result }) => {
      ended.push(result.outcome.event.tool.readBack ?? '');
    },
  };
  const { transport, handles, seen } = harness(undefined, undefined, { decider });
  try {
    const ref = await say(transport, 'start the job');
    handles[0].stop(undefined, { graceMs: 0 });
    await handles[0].done;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(ended, [UNRESOLVED]);
    const before = seen.length;
    await say(transport, 'any news?', ref);
    const read = seen.slice(before).filter((req) => JSON.stringify(req).includes(UNRESOLVED));
    assert(read.length > 0, 'the turn after the call was shut down did not read that it was lost');
    assertEquals(await toldBlocks(transport, ref, handles[0].operationId), 1);
    await say(transport, 'and now?', ref);
    assertEquals(await toldBlocks(transport, ref, handles[0].operationId), 1);
  } finally {
    held.free();
  }
});

Deno.test('a call that ends in an error is read by the next turn as its failure', async () => {
  const { transport, handles, seen } = harness();
  held.fail = true;
  try {
    const ref = await say(transport, 'start the job');
    held.free();
    await handles[0].done.catch(() => {});
    const before = seen.length;
    await say(transport, 'any news?', ref);
    const view = await transport.conversation({ conversation: ref });
    const late = view.transcript.flatMap((b) => (b.kind === 'late-results' ? [b.text] : []));
    assertEquals(late.length, 1);
    assert(late[0]?.includes(TOOL));
    assert(late[0]?.includes('the-late-failure'));
    assert(seen.slice(before).some((req) => JSON.stringify(req).includes('the-late-failure')));
  } finally {
    held.fail = false;
    held.free();
  }
});
