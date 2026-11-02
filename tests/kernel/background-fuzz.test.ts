import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  createMemoryToolExecution,
  type ToolBackground,
  type ToolBackgroundHandle,
  type ToolExecutionCoordinator,
} from '../../mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ToolContext } from '../../src/kernel/tools/types.ts';
import type { TurnEvent, TurnModel, TurnRequest } from '../../src/kernel/types.ts';
import type { TraceSink } from '../../src/observability/trace-sink.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'background_fuzz';
const TOOL = 'slow_job';
const BOUND_MS = 2000;

const BODIES = ['returns', 'throws', 'honours_stop', 'ignores_stop'] as const;
const STOPS = ['none', 'reason', 'no_reason', 'reason_grace', 'twice'] as const;
const SETTINGS: ToolBackground[] = ['always', 'ask', { afterMs: 0 }, { afterMs: 2 }];

interface Case {
  setting: ToolBackground;
  body: (typeof BODIES)[number];
  bodyTicks: number;
  stop: (typeof STOPS)[number];
  stopTicks: number;
  failSettle: boolean;
  failDetach: boolean;
  failSink: boolean;
  failService: boolean;
  failTrace: boolean;
  smallOutcomes: boolean;
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function caseOf(seed: number): Case {
  const next = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
  const sometimes = () => next() < 0.15;
  return {
    setting: pick(SETTINGS),
    body: pick(BODIES),
    bodyTicks: Math.floor(next() * 4),
    stop: pick(STOPS),
    stopTicks: Math.floor(next() * 4),
    failSettle: sometimes(),
    failDetach: sometimes(),
    failSink: sometimes(),
    failService: sometimes(),
    failTrace: sometimes(),
    smallOutcomes: sometimes(),
  };
}

const ticks = (count: number) => new Promise<void>((resolve) => setTimeout(resolve, count));

function faulty(given: Case): ToolExecutionCoordinator {
  const memory = createMemoryToolExecution();
  return {
    ...memory,
    ...(given.smallOutcomes ? { maxOutcomeBytes: 300 } : {}),
    ...(given.failDetach ? { detach: () => Promise.reject(new Error('reply store down')) } : {}),
    ...(given.failSettle ? { settle: () => Promise.reject(new Error('result store down')) } : {}),
  };
}

const throwingSink: TraceSink = {
  write: () => {
    throw new Error('trace store down');
  },
};

function model(given: Case): TurnModel {
  let step = 0;
  return {
    async *complete() {
      step += 1;
      if (step > 1) {
        yield { type: 'text', text: 'Looking into it.' };
        return;
      }
      const args = given.setting === 'ask' ? { background: true } : {};
      yield { type: 'tool', tool: { name: TOOL, callId: 'call_1', arguments: args } };
    },
  };
}

async function runCase(given: Case) {
  const release = Promise.withResolvers<void>();
  let bodies = 0;
  const scope = createTestKernelScope();
  scope.tools.register({
    type: 'function',
    name: TOOL,
    description: 'A slow job.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    background: given.setting,
    input: z.strictObject({}),
    output: z.object({ done: z.string() }),
    handler: async (_input: unknown, ctx: ToolContext) => {
      bodies += 1;
      if (given.body === 'honours_stop') {
        await new Promise((_, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('stopped')));
          release.promise.then(() => reject(new Error('stopped')));
        });
      }
      if (given.body === 'ignores_stop') await release.promise;
      await ticks(given.bodyTicks);
      if (given.body === 'throws') throw new Error('body failed');
      return { done: 'x'.repeat(1000) };
    },
  });
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: PROFILE,
      identity: { handle: PROFILE, system: 'You help.' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 4,
      tools: { allow: [TOOL] },
      inputs: { text: true },
    }),
  );
  const execution = faulty(given);
  const handles: ToolBackgroundHandle[] = [];
  const sink: TurnEvent[] = [];
  const request = {
    profile: PROFILE,
    input: { text: 'Go' },
    execution,
    background: {
      detached: (handle: ToolBackgroundHandle) => {
        if (given.failService) throw new Error('host refused');
        handles.push(handle);
      },
      event: (event: TurnEvent) => {
        sink.push(event);
        if (given.failSink) throw new Error('sink down');
      },
    },
  } as TurnRequest;
  // why: `honours_stop` and `ignores_stop` would otherwise wait for a stop this case may not send.
  const unblock = setTimeout(() => release.resolve(), 40);
  try {
    await Array.fromAsync(
      runScopedTurn(scope, request, model(given), given.failTrace ? throwingSink : undefined),
    ).catch(() => {});
    const handle = handles[0];
    if (handle) {
      await ticks(given.stopTicks);
      if (given.stop === 'reason') handle.stop('person');
      if (given.stop === 'no_reason') handle.stop();
      if (given.stop === 'reason_grace') handle.stop('timeout', { graceMs: 2 });
      if (given.stop === 'twice') {
        handle.stop('first');
        handle.stop('second', { graceMs: 1 });
      }
      await handle.done;
      const known = await execution.lookup({ ...handle, profileId: PROFILE, invocationHash: '' });
      assert(
        given.failSettle || known?.kind === 'settled' || known?.kind === 'uncertain',
        `left as ${known?.kind}: ${JSON.stringify(given)}`,
      );
      if (given.stop === 'reason' || given.stop === 'reason_grace' || given.stop === 'twice') {
        const events = sink.length;
        release.resolve();
        await ticks(5);
        assertEquals(sink.length, events, 'an event came after the call settled');
      }
    }
    return { handle, bodies, execution };
  } finally {
    clearTimeout(unblock);
    release.resolve();
  }
}

Deno.test('a detached call always ends, once, with nothing left unhandled', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandled.push(event.reason);
  };
  globalThis.addEventListener('unhandledrejection', onUnhandled);
  try {
    let detached = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const given = caseOf(seed);
      const timer = Promise.withResolvers<'hung'>();
      const bound = setTimeout(() => timer.resolve('hung'), BOUND_MS);
      const ended = await Promise.race([runCase(given), timer.promise]);
      clearTimeout(bound);
      assert(ended !== 'hung', `hung: ${seed} ${JSON.stringify(given)}`);
      assert(ended.bodies <= 1, `second body: ${seed} ${JSON.stringify(given)}`);
      if (ended.handle) detached += 1;
    }
    await ticks(10);
    assertEquals(unhandled, []);
    assert(detached > 100, `only ${detached} cases detached`);
  } finally {
    globalThis.removeEventListener('unhandledrejection', onUnhandled);
  }
});
