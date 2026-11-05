import { assert, assertEquals } from '@std/assert';
import {
  defaultKernelScope,
  type ProfileDefinition,
  registerTool,
  type ToolBackgroundHandle,
  type TurnModel,
  z,
} from '../../mod.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import { createHttpTransport } from '../../web/src/client/transport.ts';
import {
  createMemoryConversationStore,
  createMemoryNotifier,
  createMemorySessionStore,
  createTheoremHandler,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';

const TOOL = 'web_notify_fuzz_job';
const SEEDS = 60;
const STEPS = 30;

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'web-notify-fuzz',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [TOOL] },
  inputs: { text: true },
  guardrails: { detect: 'ignore' },
};

/** The bodies still running, oldest first. */
const bodies: (() => void)[] = [];
let calls = 0;

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
    await new Promise<void>((resolve) => bodies.push(resolve));
    return { done: 'late' };
  },
});

function caller(): TurnModel {
  let step = 0;
  return {
    complete: () =>
      (async function* () {
        await Promise.resolve();
        step += 1;
        if (step === 1) {
          calls += 1;
          yield {
            type: 'tool' as const,
            tool: { name: TOOL, callId: `call_${calls}`, arguments: {} },
          };
          return;
        }
        yield { type: 'text' as const, text: 'Looking into it.' };
        yield { type: 'done' as const, stop: { kind: 'completed' } };
      })(),
  };
}

function randomFrom(seed: number) {
  let state = seed;
  return (below: number) => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return Math.floor((state / 4294967296) * below);
  };
}

function waitFor(check: () => boolean, why: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > 2000) return reject(new Error(why));
      setTimeout(tick, 1);
    };
    tick();
  });
}

/**
 * invariant: Whatever order the ends, turns, cut streams and leaving tabs come in, a page that
 * stays ends up drawing what a fresh read shows, with no stream left open and no turn sent for it.
 */
async function run(seed: number): Promise<void> {
  const random = randomFrom(seed);
  const handles: ToolBackgroundHandle[] = [];
  const handler = createTheoremHandler({
    profile: PROFILE,
    provider: () => fixtureHostOptions(caller()),
    conversationStore: createMemoryConversationStore(),
    sessionStore: createMemorySessionStore(),
    session: () => 'one-person',
    notifier: createMemoryNotifier(),
    notifyRetryMs: 1,
    background: () => ({ detached: (handle) => handles.push(handle), event: () => {} }),
  });
  const transport = createHttpTransport({
    endpoint: 'http://host.test/api/theorem',
    fetch: (url, init) => handler(new Request(url, init)),
  });
  const open = new Set<AbortController>();
  const notify = transport.notify?.bind(transport);
  assert(notify);
  transport.notify = async (changed, signal) => {
    const cut = new AbortController();
    open.add(cut);
    try {
      await notify(changed, AbortSignal.any([signal, cut.signal]));
    } finally {
      open.delete(cut);
    }
  };
  const iface = await transport.describe();
  assert(iface.type === 'text');
  let ref: string | undefined;
  const chat = createChatController({
    iface,
    transport,
    onConversationChange: (next) => {
      ref = next;
    },
  });
  let leave: (() => void) | null = chat.subscribe(() => {});
  await chat.sendText('first');
  await waitFor(() => chat.getState().phase === 'idle', `seed ${seed}: the first turn hung`);
  const pending: Promise<unknown>[] = [];
  for (let step = 0; step < STEPS; step += 1) {
    const move = random(5);
    if (move === 0) bodies.shift()?.();
    if (move === 1 && chat.getState().phase === 'idle') {
      pending.push(chat.sendText(`turn ${step}`));
    }
    if (move === 2) for (const cut of open) cut.abort();
    if (move === 3) {
      if (leave) {
        leave();
        leave = null;
      } else leave = chat.subscribe(() => {});
    }
    if (move === 4) await new Promise((resolve) => setTimeout(resolve, random(3)));
  }
  await Promise.all(pending);
  const stay = leave ?? chat.subscribe(() => {});
  await waitFor(() => chat.getState().phase === 'idle', `seed ${seed}: a turn hung`);
  while (bodies.length) bodies.shift()?.();
  await Promise.all(handles.map((handle) => handle.done));
  await waitFor(() => {
    const blocks = chat.getState().blocks.filter((block) => block.kind === 'tool');
    return blocks.every((block) => block.kind === 'tool' && block.tool.state?.phase === 'complete');
  }, `seed ${seed}: the page never drew an end`);
  await waitFor(() => open.size === 0, `seed ${seed}: the stream stayed open`);
  assert(ref);
  const fresh = await transport.conversation({ conversation: ref });
  const phases = (blocks: typeof fresh.transcript) =>
    blocks.flatMap((block) => (block.kind === 'tool' ? [block.tool.state?.phase] : []));
  assertEquals(phases(chat.getState().blocks), phases(fresh.transcript), `seed ${seed}`);
  assertEquals(fresh.notify, undefined, `seed ${seed}`);
  stay();
}

Deno.test('a page settles on what a fresh read shows, in any order of events', async () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) await run(seed);
});
