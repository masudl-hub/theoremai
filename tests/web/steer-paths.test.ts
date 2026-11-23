import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  type TurnHistoryMessage,
  type TurnModel,
} from '../../mod.ts';
import {
  type ChatLine,
  createHttpTransport,
  TheoremStreamError,
  type TheoremTransport,
} from '../../web/src/client/transport.ts';
import { createMemoryConversationStore, createTheoremHandler } from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

registerFixtureProviders(defaultKernelScope);

const STORED: ProfileDefinition = {
  type: 'text',
  id: 'steer-paths',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};
const STATELESS: ProfileDefinition = {
  ...STORED,
  id: 'steer-paths-stateless',
  providerContinuation: { history: 'stateless' },
};

/** A model whose step `n` waits on `gates[n]`, and that keeps the user lines each step read. */
function gatedModel(steps: string[][], gates: Promise<void>[]): TurnModel {
  return {
    complete: (req) =>
      (async function* () {
        const step = steps.length;
        steps.push(userLines(req.history ?? []));
        await gates[step];
        yield { type: 'text' as const, text: `answer ${step}` };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function userLines(history: readonly TurnHistoryMessage[]): string[] {
  return history.flatMap((message) =>
    message.role === 'user' && message.content ? [message.content] : [],
  );
}

function gate() {
  const open = Promise.withResolvers<void>();
  return { wait: open.promise, free: () => open.resolve() };
}

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

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; !ready(); tries += 1) {
    if (tries > 2000) throw new Error('the wait ran out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function setup(profile: ProfileDefinition, gates: Promise<void>[], stored = profile === STORED) {
  const steps: string[][] = [];
  const handler = createTheoremHandler({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile,
    provider: () => fixtureHostOptions(gatedModel(steps, gates)),
    ...(stored ? { conversationStore: createMemoryConversationStore() } : {}),
  });
  return { steps, transport: browserFor(handler) };
}

const injectedOf = (lines: readonly ChatLine[]) =>
  lines.flatMap((line) => (line.type === 'stage' ? (line.injected ?? []) : []));

const refOf = (lines: readonly ChatLine[]) =>
  lines.flatMap((line) => (line.type === 'conversation' ? [line.ref] : [])).at(-1);

Deno.test("a steer on a stored chat goes by the turn and lands in the reply, through Theorem's own inbox", async () => {
  const first = gate();
  const { steps, transport } = setup(STORED, [first.wait]);
  const lines: ChatLine[] = [];
  const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) => lines.push(l));
  await until(() => steps.length === 1);
  await transport.steer({ turnId: 'turn-1', id: 'steer-1', input: { text: 'also this' } });
  first.free();
  await run;
  assertEquals(injectedOf(lines), [
    { id: 'steer-1', messages: [{ role: 'user', content: 'also this' }] },
  ]);
  assert(steps.at(-1)?.includes('also this'), 'the model never read the steer');
});

Deno.test('a steer on a stored chat goes by the conversation, and the reply says it saved it', async () => {
  const first = gate();
  const { steps, transport } = setup(STORED, [first.wait]);
  const lines: ChatLine[] = [];
  const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) => lines.push(l));
  await until(() => steps.length === 1 && refOf(lines) !== undefined);
  const conversation = refOf(lines);
  assert(conversation !== undefined);
  const reply = await transport.steer({
    conversation,
    id: 'steer-1',
    input: { text: 'by the chat' },
  });
  assertEquals(reply.saved?.landsAs, ['steer-1']);
  first.free();
  await run;
  assertEquals(
    injectedOf(lines).map((unit) => unit.id),
    ['steer-1'],
  );
});

Deno.test('a steer on a stateless chat goes by its run, and the run alone', async () => {
  const first = gate();
  const { steps, transport } = setup(STATELESS, [first.wait]);
  const lines: ChatLine[] = [];
  const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) => lines.push(l));
  await until(() => steps.length === 1);
  await transport.steer({ turnId: 'turn-1', id: 'steer-1', input: { text: 'also this' } });
  await assertRejects(
    () => transport.steer({ turnId: 'turn-2', id: 'steer-2', input: { text: 'no run' } }),
    TheoremStreamError,
  );
  first.free();
  await run;
  assertEquals(
    injectedOf(lines).map((unit) => unit.id),
    ['steer-1'],
  );
  await assertRejects(
    () => transport.steer({ turnId: 'turn-1', id: 'steer-3', input: { text: 'late' } }),
    TheoremStreamError,
  );
});

Deno.test('a steer during the last step is told before the reply ends, and runs one more step', async () => {
  const [one, two] = [gate(), gate()];
  const { steps, transport } = setup(STORED, [one.wait, two.wait]);
  const lines: ChatLine[] = [];
  const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) => lines.push(l));
  await until(() => steps.length === 1);
  await transport.steer({ turnId: 'turn-1', id: 'steer-1', input: { text: 'one more thing' } });
  one.free();
  await until(() => steps.length === 2);
  two.free();
  await run;
  assertEquals(steps.length, 2, 'the steer did not run a step of its own');
  assert(steps[1].includes('one more thing'));
});

Deno.test('a stop by the turn ends a stored chat reply, and a stop by the conversation does too', async () => {
  for (const by of ['turn', 'conversation'] as const) {
    const first = gate();
    const { steps, transport } = setup(STORED, [first.wait]);
    const lines: ChatLine[] = [];
    const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) =>
      lines.push(l),
    );
    await until(() => steps.length === 1 && refOf(lines) !== undefined);
    const conversation = refOf(lines);
    assert(conversation !== undefined);
    await transport.stop(by === 'turn' ? { turnId: 'turn-1' } : { conversation });
    first.free();
    await run;
    const view = await transport.conversation({ conversation: refOf(lines) ?? conversation });
    assert(
      view.transcript.some(
        (block) => block.kind === 'turn-done' && block.stop?.kind === 'cancelled',
      ),
      `the stop by the ${by} did not end the reply as stopped`,
    );
    await assertRejects(
      () => transport.stop(by === 'turn' ? { turnId: 'turn-1' } : { conversation }),
      TheoremStreamError,
    );
  }
});

Deno.test('a stop by the run ends a stateless chat reply', async () => {
  const first = gate();
  const { steps, transport } = setup(STATELESS, [first.wait]);
  const lines: ChatLine[] = [];
  const run = transport.turn({ input: { text: 'hello' }, turnId: 'turn-1' }, (l) => lines.push(l));
  await until(() => steps.length === 1);
  await transport.stop({ turnId: 'turn-1' });
  first.free();
  await run;
  assert(
    lines.some((line) => line.type === 'done' && line.stop.kind === 'cancelled'),
    'the stop did not end the run as stopped',
  );
  await assertRejects(() => transport.stop({ turnId: 'turn-1' }), TheoremStreamError);
});
