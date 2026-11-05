import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type { ToolBackgroundHandle } from '../../src/kernel/tools/background.ts';
import { createMemoryToolExecution } from '../../src/kernel/tools/memory-execution.ts';
import type { AgentCallHook } from '../../src/kernel/tools/types.ts';
import type {
  ModelEvent,
  ModelRequest,
  TurnEvent,
  TurnEventOf,
  TurnModel,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const CALLER_SYSTEM = 'You help.';
const RESEARCHER_SYSTEM = 'You research.';
const HELPER_SYSTEM = 'You help the researcher.';
const STEER = 'It is on the monstera, not the fern.';

interface JobSetup {
  /** The researcher's step limit. */
  maxSteps?: number;
  allowSteering?: boolean;
  detect?: DetectSpec;
  /** The researcher can call the helper, an agent tool that runs inline in its turn. */
  helper?: boolean;
  /** The researcher's calls in one step run side by side. */
  parallel?: boolean;
}

function scopeFor(setup: JobSetup): KernelScope {
  const scope = createTestKernelScope();
  const text = (id: string, system: string, allow: string[], maxSteps = 4, parallel = false) =>
    defineProfile({
      type: 'text',
      id,
      identity: { handle: id, system },
      ...geminiModels('gemini35FlashLite'),
      maxSteps,
      tools: { allow, ...(parallel ? { parallel } : {}) },
      inputs: { text: true },
    });
  const agent = (name: string, profile: string, background: 'always' | 'never') => ({
    type: 'agent' as const,
    name,
    description: `Ask ${profile}.`,
    category: 'test',
    access: 'read-only' as const,
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    profile,
    background,
  });
  scope.tools.register({
    type: 'function',
    name: 'lookup',
    description: 'Look something up.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ found: z.string() }),
    handler: () => ({ found: 'fact' }),
  });
  scope.profiles.register(text('helper', HELPER_SYSTEM, []));
  scope.tools.register(agent('ask_helper', 'helper', 'never'));
  scope.profiles.register({
    ...text(
      'researcher',
      RESEARCHER_SYSTEM,
      setup.helper ? ['lookup', 'ask_helper'] : ['lookup'],
      setup.maxSteps,
      setup.parallel,
    ),
    ...(setup.allowSteering === false ? { turnBehaviour: { allowSteering: false } } : {}),
    ...(setup.detect ? { guardrails: { detect: setup.detect } } : {}),
  });
  scope.tools.register(agent('ask_researcher', 'researcher', 'always'));
  scope.profiles.register(text('caller', CALLER_SYSTEM, ['ask_researcher']));
  return scope;
}

/** The researcher's model: `step` counts from 1; `seen` holds what each call was sent. */
type Researcher = (req: ModelRequest, step: number) => AsyncGenerator<ModelEvent>;

/** A caller turn whose call to the researcher detached; the researcher keeps running. */
async function startJob(
  setup: JobSetup,
  researcher: Researcher,
  helper?: (req: ModelRequest) => AsyncGenerator<ModelEvent>,
  onAgentCall?: AgentCallHook,
) {
  const seen: ModelRequest[] = [];
  const helped: ModelRequest[] = [];
  const late: TurnEvent[] = [];
  const handed = Promise.withResolvers<ToolBackgroundHandle>();
  let step = 0;
  const model: TurnModel = {
    async *complete(req) {
      await Promise.resolve();
      if (req.system.includes(HELPER_SYSTEM)) {
        helped.push(req);
        if (helper) yield* helper(req);
        else yield { type: 'text', text: 'helped' };
        return;
      }
      if (req.system.includes(RESEARCHER_SYSTEM)) {
        step += 1;
        seen.push(req);
        yield* researcher(req, step);
        return;
      }
      if (JSON.stringify(req.history).includes('still running')) {
        yield { type: 'text', text: 'Looking into it.' };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'ask_researcher', arguments: { text: 'thrips' }, callId: 'call_0' },
      };
    },
  };
  const events = await Array.fromAsync(
    runScopedTurn(
      scopeFor(setup),
      {
        profile: 'caller',
        input: { text: 'Research thrips' },
        execution: createMemoryToolExecution(),
        background: {
          detached: (handle) => handed.resolve(handle),
          event: (event) => {
            late.push(event);
          },
        },
        ...(onAgentCall ? { onAgentCall } : {}),
      },
      model,
    ),
  );
  assert(
    events.some((e) => e.type === 'tool' && e.tool.phase === 'background'),
    'the call did not detach',
  );
  return { handle: await handed.promise, seen, helped, late };
}

/** The researcher's turn events, as the host's service got them. */
function jobEvents(late: readonly TurnEvent[]): TurnEvent[] {
  return late.flatMap((e) => {
    if (e.type !== 'tool' || e.tool.phase !== 'progress') return [];
    const data = z.object({ event: z.custom<TurnEvent>() }).safeParse(e.tool.data);
    return data.success ? [data.data.event] : [];
  });
}

function landed(late: readonly TurnEvent[]) {
  return jobEvents(late).flatMap((e) =>
    e.type === 'stage' && e.injected ? [{ stage: e.stage, ids: e.injected.map((i) => i.id) }] : [],
  );
}

function reads(req: ModelRequest | undefined, text: string): boolean {
  return JSON.stringify(req?.history ?? []).includes(text);
}

/** Waits until the model call is aborted, then throws as an aborted call does. */
async function* heldUntilStopped(req: ModelRequest): AsyncGenerator<ModelEvent> {
  await new Promise<void>((resolve) => {
    if (req.signal?.aborted) resolve();
    req.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  yield* [];
  throw req.signal?.reason ?? new DOMException('stopped', 'AbortError');
}

Deno.test('a steer lands at post_tool, and the job reads it in its next model call', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob({}, async function* (_req, step) {
    if (step === 1) {
      entered.resolve();
      await release.promise;
      yield { type: 'tool', tool: { name: 'lookup', arguments: {}, callId: 'child' } };
      return;
    }
    yield { type: 'text', text: 'found' };
  });
  await entered.promise;
  assertEquals(job.handle.steer(STEER, { id: 'steer_1' }), { queued: true });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(
    job.seen.map((req) => reads(req, STEER)),
    [false, true],
  );
  assertEquals(landed(job.late), [{ stage: 'post_tool', ids: ['steer_1'] }]);
});

Deno.test('a steer lands once in a step whose calls run side by side', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob({ parallel: true }, async function* (_req, step) {
    if (step === 1) {
      entered.resolve();
      await release.promise;
      yield { type: 'tool', tool: { name: 'lookup', arguments: {}, callId: 'child_1' } };
      yield { type: 'tool', tool: { name: 'lookup', arguments: {}, callId: 'child_2' } };
      return;
    }
    yield { type: 'text', text: 'found' };
  });
  await entered.promise;
  job.handle.steer(STEER, { id: 'steer_1' });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(JSON.stringify(job.seen[1]?.history).split(STEER).length - 1, 1);
  assertEquals(landed(job.late), [{ stage: 'post_tool', ids: ['steer_1'] }]);
});

Deno.test('a steer lands at before_end, and the job makes one more model call with it', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob({}, async function* (_req, step) {
    if (step === 1) {
      entered.resolve();
      await release.promise;
    }
    yield { type: 'text', text: `answer ${step}` };
  });
  await entered.promise;
  job.handle.steer(STEER, { id: 'steer_1' });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(
    job.seen.map((req) => reads(req, STEER)),
    [false, true],
  );
  assertEquals(landed(job.late), [{ stage: 'before_end', ids: ['steer_1'] }]);
});

Deno.test('a steer given before the job turn starts lands at pre_turn', async () => {
  const handed = Promise.withResolvers<void>();
  const hold: AgentCallHook = async () => {
    await handed.promise;
    return undefined;
  };
  const job = await startJob(
    {},
    async function* () {
      yield { type: 'text', text: 'found' };
    },
    undefined,
    hold,
  );
  job.handle.steer(STEER, { id: 'steer_1' });
  handed.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(
    job.seen.map((req) => reads(req, STEER)),
    [true],
  );
  assertEquals(landed(job.late), [{ stage: 'pre_turn', ids: ['steer_1'] }]);
});

Deno.test('a steer on the last step never lands, and done lists it unread', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob({ maxSteps: 1 }, async function* () {
    entered.resolve();
    await release.promise;
    yield { type: 'text', text: 'answer' };
  });
  await entered.promise;
  assertEquals(job.handle.steer(STEER, { id: 'steer_1' }), { queued: true });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: ['steer_1'] });
  assertEquals(job.seen.length, 1);
  assertEquals(landed(job.late), []);
});

Deno.test('a stop with a steer waiting lists it unread, and a steer after the stop is refused', async () => {
  const entered = Promise.withResolvers<void>();
  const job = await startJob({}, (req) => {
    entered.resolve();
    return heldUntilStopped(req);
  });
  await entered.promise;
  assertEquals(job.handle.steer(STEER, { id: 'steer_1' }), { queued: true });
  job.handle.stop('stopped');
  assertEquals(job.handle.steer('Also the roots.', { id: 'steer_2' }), {
    queued: false,
    reason: 'stopped',
  });
  assertEquals(await job.handle.done, { unreadSteers: ['steer_1'] });
});

Deno.test('a steer after the call settled is refused as settled', async () => {
  const job = await startJob({}, async function* () {
    yield { type: 'text', text: 'found' };
  });
  await job.handle.done;
  assertEquals(job.handle.steer(STEER, { id: 'steer_1' }), {
    queued: false,
    reason: 'settled',
  });
});

Deno.test('a steer to an agent whose profile turns steering off is refused at once', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob({ allowSteering: false }, async function* () {
    entered.resolve();
    await release.promise;
    yield { type: 'text', text: 'found' };
  });
  await entered.promise;
  assertEquals(job.handle.steer(STEER, { id: 'steer_1' }), {
    queued: false,
    reason: 'steering_off',
  });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(
    job.seen.map((req) => reads(req, STEER)),
    [false],
  );
});

Deno.test('a steer to a function tool is refused at once: it has no turn', async () => {
  const scope = createTestKernelScope();
  const release = Promise.withResolvers<{ done: string }>();
  scope.tools.register({
    type: 'function',
    name: 'slow_job',
    description: 'A slow job.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    background: 'always',
    input: z.object({}),
    output: z.object({ done: z.string() }),
    handler: () => release.promise,
  });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: 'caller',
      identity: { handle: 'caller', system: CALLER_SYSTEM },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 4,
      tools: { allow: ['slow_job'] },
      inputs: { text: true },
    }),
  );
  const handles: ToolBackgroundHandle[] = [];
  let step = 0;
  const model: TurnModel = {
    async *complete() {
      await Promise.resolve();
      step += 1;
      if (step === 1) {
        yield { type: 'tool', tool: { name: 'slow_job', arguments: {}, callId: 'call_0' } };
        return;
      }
      yield { type: 'text', text: 'Started.' };
    },
  };
  await Array.fromAsync(
    runScopedTurn(
      scope,
      {
        profile: 'caller',
        input: { text: 'Go' },
        execution: createMemoryToolExecution(),
        background: { detached: (handle) => handles.push(handle), event: () => {} },
      },
      model,
    ),
  );
  const [handle] = handles;
  assert(handle, 'the call did not detach');
  assertEquals(handle.steer(STEER, { id: 'steer_1' }), { queued: false, reason: 'not_agent' });
  release.resolve({ done: 'ok' });
  assertEquals(await handle.done, { unreadSteers: [] });
});

Deno.test("a child agent tool of the job never reads the job's steer; the job does", async () => {
  const helping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob(
    { helper: true },
    async function* (_req, step) {
      if (step === 1) {
        yield { type: 'tool', tool: { name: 'ask_helper', arguments: { text: 'q' }, callId: 'h' } };
        return;
      }
      yield { type: 'text', text: 'found' };
    },
    async function* () {
      helping.resolve();
      await release.promise;
      yield { type: 'text', text: 'helped' };
    },
  );
  await helping.promise;
  job.handle.steer(STEER, { id: 'steer_1' });
  release.resolve();
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assert(job.helped.length > 0, 'the helper never ran');
  assertEquals(
    job.helped.some((req) => reads(req, STEER)),
    false,
  );
  assertEquals(
    job.seen.map((req) => reads(req, STEER)),
    [false, true],
  );
});

Deno.test("a steer passes the job profile's guardrails like a host inject", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const job = await startJob(
    { detect: { credentials: { at: { injected: 'redact' } } } },
    async function* (_req, step) {
      if (step === 1) {
        entered.resolve();
        await release.promise;
      }
      yield { type: 'text', text: `answer ${step}` };
    },
  );
  await entered.promise;
  job.handle.steer(`The key is ${TEST_OPENAI_KEY}`, { id: 'steer_1' });
  release.resolve();
  await job.handle.done;
  assertEquals(job.seen.length, 2);
  assertEquals(reads(job.seen[1], TEST_OPENAI_KEY), false);
  assertEquals(reads(job.seen[1], 'The key is'), true);
  const guarded = jobEvents(job.late).filter(
    (e): e is TurnEventOf<'guardrail'> =>
      e.type === 'guardrail' && e.guardrail.boundary === 'injected',
  );
  assertEquals(
    guarded.map((e) => e.guardrail.action),
    ['redact'],
  );
});

Deno.test('a job with no steers runs every stage as before', async () => {
  const job = await startJob({}, async function* (_req, step) {
    if (step === 1) {
      yield { type: 'tool', tool: { name: 'lookup', arguments: {}, callId: 'child' } };
      return;
    }
    yield { type: 'text', text: 'found' };
  });
  assertEquals(await job.handle.done, { unreadSteers: [] });
  assertEquals(job.seen.length, 2);
  assertEquals(landed(job.late), []);
});
