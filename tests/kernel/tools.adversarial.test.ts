/**
 * Adversarial tool-system regression suite.
 *
 * @module
 */

import '../fixtures/test-host.ts';
import { z } from 'zod';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals, assertRejects } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { cloneTurnToolSnapshot, invokeTool } from '../../src/kernel/tools/mod.ts';
import { registerTool } from '../../src/kernel/tools/registry.ts';
import {
  prepareTurnToolSnapshot,
  promoteLoadedTools,
  resolveTurnTools,
} from '../../src/kernel/tools/resolve.ts';
import type { ModelProvider, ProfileToolsSpec, TurnEvent } from '../../src/kernel/types.ts';
import {
  foldArgumentsDelta,
  foldPayload,
  foldStepStart,
  newStreamFold,
} from '../../src/providers/google/interactions/stream.ts';
import { geminiModel, HOST_MODELS } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

function flashProfile(id: string, maxSteps: number, tools: ProfileToolsSpec) {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      model: { ...geminiModel('gemini35FlashLite'), maxSteps },
      tools,
      inputs: { text: true },
      guardrails: { quota: { perDay: 10_000 } },
    }),
  );
}

// ---------------------------------------------------------------------------
// Stream parser — alternate wire shapes
// ---------------------------------------------------------------------------

Deno.test('adversarial/stream: string args via delta + step.stop', () => {
  const fold = newStreamFold();
  const events = [
    ...(foldPayload(
      {
        event_type: 'step.start',
        index: 0,
        step: { type: 'function_call', id: 'c_delta', name: 'ping_tool' },
      },
      fold,
    ) as TurnEvent[]),
    ...(foldPayload(
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'arguments_delta', arguments: '{"step":' },
      },
      fold,
    ) as TurnEvent[]),
    ...(foldPayload(
      { event_type: 'step.delta', index: 0, delta: { type: 'arguments', arguments: '1}' } },
      fold,
    ) as TurnEvent[]),
    ...(foldPayload({ event_type: 'step.stop', index: 0 }, fold) as TurnEvent[]),
  ];
  const tool = events.find((e) => e.type === 'tool');
  assertEquals(tool?.tool?.name, 'ping_tool');
  assertEquals(tool?.tool?.arguments, { step: 1 });
});

Deno.test('adversarial/stream: step.start id-only flushes empty args on step.stop', () => {
  const fold = newStreamFold();
  foldPayload(
    {
      event_type: 'step.start',
      index: 2,
      step: { type: 'function_call', id: 'c_empty', name: 'stub_tool' },
    },
    fold,
  );
  const stopped = foldPayload({ event_type: 'step.stop', index: 2 }, fold) as TurnEvent[];
  assertEquals(stopped.length, 1);
  assertEquals(stopped[0]?.tool?.arguments, {});
});

Deno.test('adversarial/stream: malformed JSON args become tool failure events', () => {
  const fold = newStreamFold();
  foldStepStart(
    {
      event_type: 'step.start',
      index: 0,
      step: { type: 'function_call', id: 'c_bad', name: 'ping_tool' },
    },
    fold,
  );
  foldArgumentsDelta({ type: 'arguments_delta', arguments: '{not json' }, 0, fold);
  const stopped = foldPayload({ event_type: 'step.stop', index: 0 }, fold) as TurnEvent[];
  assertEquals(stopped[0]?.type, 'tool');
  assertEquals(stopped[0]?.tool?.phase, 'error');
  assertEquals(stopped[0]?.tool?.failure?.code, 'malformed_arguments');
  assertEquals(stopped[0]?.tool?.arguments, {});
});

Deno.test('adversarial/stream: duplicate function_call deduped', () => {
  const fold = newStreamFold();
  const payload = {
    event_type: 'step.start',
    index: 0,
    step: { type: 'function_call', id: 'c_dup', name: 'stub_tool', arguments: {} },
  };
  const first = foldPayload(payload, fold) as TurnEvent[];
  const second = foldPayload(payload, fold) as TurnEvent[];
  assertEquals(first.filter((e) => e.type === 'tool').length, 1);
  assertEquals(second.filter((e) => e.type === 'tool').length, 0);
});

Deno.test('adversarial/runTurn: provider malformed_arguments skips handler execution', async () => {
  let handlerCalls = 0;
  registerTool({
    type: 'function',
    name: 'malformed_args_probe',
    description: 'Must not run when provider already failed args parse',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => {
      handlerCalls += 1;
      return { finding: 'ran' };
    },
  });
  flashProfile('malformed_args_profile', 2, { allow: ['malformed_args_probe'] });
  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: {
          name: 'malformed_args_probe',
          id: 'c_bad',
          arguments: {},
          phase: 'error',
          failure: {
            code: 'malformed_arguments',
            message: 'malformed tool arguments JSON',
            details: { raw: '{bad' },
          },
        },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_malformed',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'malformed_args_profile', input: { text: 'x' } }, provider),
  );
  assertEquals(handlerCalls, 0);
  assertEquals(lastTool(events, 'malformed_args_probe')?.phase, 'error');
  assertEquals(lastTool(events, 'malformed_args_probe')?.failure?.code, 'malformed_arguments');
});

// ---------------------------------------------------------------------------
// runTurn batch semantics
// ---------------------------------------------------------------------------

Deno.test('adversarial/runTurn: load_tools + record_lookup in same provider batch', async () => {
  flashProfile('batch_t2_probe', 4, {
    allow: ['load_tools', 'record_lookup'],
    t2Loader: 'load_tools',
  });
  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'load_tools', arguments: { names: ['record_lookup'] }, id: 'c1' },
      };
      yield {
        type: 'tool',
        tool: { name: 'record_lookup', arguments: { q: 'batch' }, id: 'c2' },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_batch',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'batch_t2_probe', input: { text: 'x' } }, provider),
  );
  assertEquals(lastTool(events, 'load_tools')?.phase, 'complete');
  assertEquals(lastTool(events, 'record_lookup')?.phase, 'complete');
});

Deno.test('adversarial/runTurn: first tool error does not block second tool', async () => {
  flashProfile('batch_error_probe', 4, { allow: ['crashing_tool', 'stub_tool'] });
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'tool', tool: { name: 'crashing_tool', arguments: { id: '1' }, id: 'c1' } };
      yield { type: 'tool', tool: { name: 'stub_tool', arguments: {}, id: 'c2' } };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_err',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'batch_error_probe', input: { text: 'x' } }, provider),
  );
  assertEquals(lastTool(events, 'crashing_tool')?.failure?.code, 'handler_error');
  assertEquals(lastTool(events, 'stub_tool')?.phase, 'complete');
});

Deno.test('adversarial/runTurn: pause on one tool does not skip siblings in batch', async () => {
  flashProfile('batch_pause_probe', 4, { allow: ['always_confirm_tool', 'stub_tool'] });
  const provider: ModelProvider = {
    async *complete() {
      yield { type: 'tool', tool: { name: 'always_confirm_tool', arguments: {}, id: 'c1' } };
      yield { type: 'tool', tool: { name: 'stub_tool', arguments: {}, id: 'c2' } };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_pause',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'batch_pause_probe', input: { text: 'x' } }, provider),
  );
  assertEquals(lastTool(events, 'always_confirm_tool')?.phase, 'pause');
  assertEquals(lastTool(events, 'stub_tool')?.phase, 'complete');
  assertEquals(events.at(-1)?.stop?.kind, 'tool');
});

Deno.test('adversarial/runTurn: maxSteps caps provider rounds not tools per round', async () => {
  flashProfile('maxsteps_probe', 1, { allow: ['ping_tool'] });
  let providerCalls = 0;
  const provider: ModelProvider = {
    async *complete() {
      providerCalls++;
      yield {
        type: 'tool',
        tool: { name: 'ping_tool', arguments: { step: providerCalls }, id: 'c1' },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_ms',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'maxsteps_probe', input: { text: 'x' } }, provider),
  );
  assertEquals(providerCalls, 1);
  assertEquals(lastTool(events, 'ping_tool')?.phase, 'complete');
});

// ---------------------------------------------------------------------------
// Handler / stream faults
// ---------------------------------------------------------------------------

Deno.test('adversarial/handler: stream throws after progress', async () => {
  registerTool({
    type: 'function',
    name: 'stream_throw_probe',
    description: 'Throws mid-stream',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: async function* () {
      yield { kind: 'progress', data: { pct: 1 } };
      throw new Error('stream exploded');
    },
  });
  flashProfile('stream_throw_bot', 1, { allow: ['stream_throw_probe'] });
  const events = await invokeRegisteredTool({
    profile: 'stream_throw_bot',
    name: 'stream_throw_probe',
    input: {},
  });
  assertEquals(
    events.some((e) => e.tool?.phase === 'progress'),
    true,
  );
  assertEquals(lastTool(events, 'stream_throw_probe')?.failure?.code, 'handler_error');
});

Deno.test('adversarial/handler: stream never yields complete', async () => {
  registerTool({
    type: 'function',
    name: 'stream_hang_probe',
    description: 'Stream without complete',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: async function* () {
      yield { kind: 'progress', data: { pct: 99 } };
    },
  });
  flashProfile('stream_hang_bot', 1, { allow: ['stream_hang_probe'] });
  const events = await invokeRegisteredTool({
    profile: 'stream_hang_bot',
    name: 'stream_hang_probe',
    input: {},
  });
  assertEquals(lastTool(events, 'stream_hang_probe')?.failure?.code, 'invalid_output');
});

Deno.test('adversarial/handler: abort signal during execution', async () => {
  registerTool({
    type: 'function',
    name: 'slow_probe',
    description: 'Blocks until aborted',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { finding: 'too late' };
    },
  });
  flashProfile('abort_bot', 1, { allow: ['slow_probe'] });
  const ac = new AbortController();
  const run = collect(
    invokeTool({
      profile: 'abort_bot',
      name: 'slow_probe',
      input: {},
      signal: ac.signal,
    }),
  );
  ac.abort();
  let events: TurnEvent[] = [];
  try {
    events = await run;
  } catch {
    /* invoke should not throw on abort */
  }
  assertEquals(
    events.some((e) => e.type === 'error'),
    true,
  );
});

Deno.test('adversarial/preflight: failure object not pause', async () => {
  registerTool({
    type: 'function',
    name: 'preflight_fail_probe',
    description: 'Preflight returns hard failure',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    preflight: () => ({ code: 'not_authorized', message: 'blocked by policy' }),
    handler: () => ({ finding: 'should not run' }),
  });
  flashProfile('preflight_fail_bot', 1, { allow: ['preflight_fail_probe'] });
  const events = await invokeRegisteredTool({
    profile: 'preflight_fail_bot',
    name: 'preflight_fail_probe',
    input: {},
  });
  const t = lastTool(events, 'preflight_fail_probe');
  assertEquals(t?.phase, 'error');
  assertEquals(t?.failure?.code, 'not_authorized');
});

// ---------------------------------------------------------------------------
// T1 / T2 / promotion adversarial
// ---------------------------------------------------------------------------

Deno.test('adversarial/t2Loader: loaded must be string[] not numbers', async () => {
  registerTool({
    type: 'function',
    name: 'bad_loader_shape',
    description: 'Returns numeric loaded ids',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ loaded: z.array(z.number()) }),
    handler: () => ({ loaded: [1, 2, 3] }),
  });
  flashProfile('bad_loader_bot', 1, {
    allow: ['bad_loader_shape', 'record_lookup'],
    t2Loader: 'bad_loader_shape',
  });
  const events = await invokeRegisteredTool({
    profile: 'bad_loader_bot',
    name: 'bad_loader_shape',
    input: {},
  });
  assertEquals(lastTool(events, 'bad_loader_shape')?.failure?.code, 'invalid_output');
});

Deno.test('adversarial/promote: invalid id fails with zero side effects', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'promote_partial_probe',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 1 },
      tools: { allow: ['load_tools', 'record_lookup', 'stub_tool'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile('promote_partial_probe');
  const snapshot = resolveTurnTools(
    profile,
    { profile: 'promote_partial_probe', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  const beforeVisible = [...snapshot.visible];
  const result = promoteLoadedTools(snapshot, ['record_lookup', 'stub_tool'], profile);
  assertEquals(result.failure?.code, 'invalid_output');
  assertEquals(result.promoted, []);
  assertEquals(snapshot.visible, beforeVisible);
});

Deno.test('adversarial/promote: invalid id in batch does not unlock later tools', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'partial_batch_probe',
      model: { ...geminiModel('gemini35FlashLite'), maxSteps: 4 },
      tools: { allow: ['load_tools', 'record_lookup', 'stub_tool'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: {
          name: 'load_tools',
          arguments: { names: ['record_lookup', 'stub_tool'] },
          id: 'c1',
        },
      };
      yield {
        type: 'tool',
        tool: { name: 'record_lookup', arguments: { q: 'after partial fail' }, id: 'c2' },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'ix_partial',
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'partial_batch_probe', input: { text: 'x' } }, provider),
  );
  assertEquals(lastTool(events, 'load_tools')?.failure?.code, 'invalid_output');
  assertEquals(lastTool(events, 'record_lookup')?.failure?.code, 'not_loaded');
});

Deno.test('adversarial/runTurn: geminiInteractions T2 promotion expands wire on continuation', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'gemini_t2_wire_probe',
      model: {
        ...geminiModel('gemini35FlashLite'),
        maxSteps: 3,
      },
      tools: { allow: ['load_tools', 'record_lookup'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  let callCount = 0;
  const seenWire: string[][] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      callCount++;
      seenWire.push((req.wireTools ?? []).map((t) => t.name));
      if (callCount === 1) {
        yield {
          type: 'tool',
          tool: { name: 'load_tools', arguments: { names: ['record_lookup'] }, id: 'c1' },
        };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'ix_t2',
        };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'record_lookup', arguments: { q: 'x' }, id: 'c2' },
      };
      yield { type: 'text', text: 'done' };
    },
  };
  await collect(runTurn({ profile: 'gemini_t2_wire_probe', input: { text: 'go' } }, provider));
  assertEquals(seenWire[0], ['load_tools']);
  assertEquals(seenWire[1], ['load_tools', 'record_lookup']);
});

Deno.test('adversarial/t1Policy: throw propagates', async () => {
  flashProfile('t1_throw_probe', 1, {
    allow: ['stub_tool'],
    t1Policy: () => {
      throw new TheorumError('t1 selector exploded');
    },
  });
  await assertRejects(
    () =>
      prepareTurnToolSnapshot(
        getProfile('t1_throw_probe'),
        { profile: 't1_throw_probe', input: { text: 'x' } },
        'gemini35FlashLite',
      ),
    TheorumError,
  );
});

Deno.test('adversarial/t1Policy: selecting T0 tool is ignored', async () => {
  flashProfile('t1_t0_ignore_probe', 1, {
    allow: ['stub_tool'],
    t1Policy: () => ['stub_tool'],
  });
  const snapshot = await prepareTurnToolSnapshot(
    getProfile('t1_t0_ignore_probe'),
    { profile: 't1_t0_ignore_probe', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  assertEquals(snapshot.visible.filter((id) => id === 'stub_tool').length, 1);
});

Deno.test('adversarial/resume: granted bypasses always_confirm but not session_consent', async () => {
  flashProfile('resume_bypass_probe', 1, { allow: ['delete_resource', 'always_confirm_tool'] });
  const confirm = await invokeRegisteredTool({
    profile: 'resume_bypass_probe',
    name: 'always_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(lastTool(confirm, 'always_confirm_tool')?.phase, 'complete');

  const deleteEv = await invokeRegisteredTool({
    profile: 'resume_bypass_probe',
    name: 'delete_resource',
    input: { id: 'x' },
    resume: { granted: true },
  });
  assertEquals(lastTool(deleteEv, 'delete_resource')?.phase, 'pause');
});

Deno.test('adversarial/invoke: promote failure attributes to host target tool', async () => {
  flashProfile('promote_attr_probe', 1, {
    allow: ['load_tools', 'stub_tool'],
    t2Loader: 'load_tools',
  });
  const events = await invokeRegisteredTool({
    profile: 'promote_attr_probe',
    name: 'stub_tool',
    input: {},
    promoted: ['stub_tool'],
  });
  const t = lastTool(events, 'stub_tool');
  assertEquals(t?.failure?.code, 'invalid_output');
});

Deno.test('adversarial/runTurn: tool error still feeds provider continuation text', async () => {
  flashProfile('error_continuation_probe', 2, { allow: ['crashing_tool'] });
  let secondInput: unknown;
  let calls = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool', tool: { name: 'crashing_tool', arguments: { id: '1' }, id: 'c1' } };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'ix_cont',
        };
        return;
      }
      secondInput = req.interactionOnlyInput;
      yield { type: 'text', text: 'ack' };
    },
  };
  await collect(runTurn({ profile: 'error_continuation_probe', input: { text: 'x' } }, provider));
  assertEquals(calls, 2);
  const step = (
    secondInput as { type: string; name: string; result?: Array<{ text?: string }> }[] | undefined
  )?.[0];
  assertEquals(step?.type, 'function_result');
  assertEquals(step?.name, 'crashing_tool');
  const text = step?.result?.[0]?.text ?? '';
  assertEquals(text.includes('handler_error'), true);
  assertEquals(text.includes('Tool error'), true);
});

// ---------------------------------------------------------------------------
// Builtin runner, t1Policy misconfig, concurrency, fuzz
// ---------------------------------------------------------------------------

Deno.test('adversarial/runTurn: builtin function_call surfaces provider_native error', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'builtin_runner_probe',
      model: {
        thinking: 'minimal',
        key: 'freeA',
        protocol: 'geminiInteractions',
        provider: 'google',
        allow: ['gemini35FlashLite'],
        config: {
          gemini35FlashLite: {
            ...HOST_MODELS.gemini35FlashLite,
            builtInTools: ['googleSearch'],
          },
        },
        maxSteps: 2,
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  let secondInput: unknown;
  let calls = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      calls++;
      if (calls === 1) {
        yield { type: 'tool', tool: { name: 'googleSearch', arguments: { q: 'x' }, id: 'c1' } };
        yield {
          type: 'tokens',
          tokens: { input: 1, output: 0, total: 1 },
          interactionId: 'ix_builtin',
        };
        return;
      }
      secondInput = req.interactionOnlyInput;
      yield { type: 'text', text: 'ack' };
    },
  };
  const events = await collect(
    runTurn({ profile: 'builtin_runner_probe', input: { text: 'x' } }, provider),
  );
  const tool = lastTool(events, 'googleSearch');
  assertEquals(tool?.phase, 'error');
  assertEquals(tool?.failure?.code, 'provider_native');
  assertEquals(calls, 2);
  const text =
    (secondInput as { result?: Array<{ text?: string }> }[] | undefined)?.[0]?.result?.[0]?.text ??
    '';
  assertEquals(text.includes('provider_native'), true);
});

Deno.test('adversarial/runTurn: t1Policy async rejection fails turn', async () => {
  flashProfile('t1_async_reject_probe', 1, {
    allow: ['stub_tool'],
    t1Policy: async () => {
      await Promise.resolve();
      throw new Error('async selector misconfigured');
    },
  });
  await assertRejects(
    () =>
      collect(
        runTurn(
          { profile: 't1_async_reject_probe', input: { text: 'x' } },
          {
            async *complete() {
              yield { type: 'text', text: 'never' };
            },
          },
        ),
      ),
    TheorumError,
    'tools.t1Policy rejected',
  );
});

Deno.test('adversarial/invoke: concurrent calls clone shared snapshot', async () => {
  flashProfile('concurrent_snapshot_probe', 1, {
    allow: ['load_tools', 'record_lookup', 'stub_tool'],
    t2Loader: 'load_tools',
  });
  const profile = getProfile('concurrent_snapshot_probe');
  const shared = resolveTurnTools(
    profile,
    { profile: 'concurrent_snapshot_probe', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  const beforeVisible = [...shared.visible];
  const [a, b] = await Promise.all([
    collect(
      invokeTool({
        profile: 'concurrent_snapshot_probe',
        name: 'load_tools',
        input: { names: ['record_lookup'] },
        snapshot: shared,
      }),
    ),
    collect(
      invokeTool({
        profile: 'concurrent_snapshot_probe',
        name: 'stub_tool',
        input: {},
        snapshot: shared,
      }),
    ),
  ]);
  assertEquals(shared.visible, beforeVisible);
  assertEquals(lastTool(a, 'load_tools')?.phase, 'complete');
  assertEquals(lastTool(b, 'stub_tool')?.phase, 'complete');
  const cloned = cloneTurnToolSnapshot(shared);
  promoteLoadedTools(cloned, ['record_lookup'], profile);
  assertEquals(shared.visible, beforeVisible);
  assertEquals(cloned.visible.includes('record_lookup'), true);
});

Deno.test('adversarial/fuzz: loaded[] with 1000 unknown ids fails atomically', () => {
  flashProfile('fuzz_loaded_probe', 1, {
    allow: ['load_tools', 'record_lookup'],
    t2Loader: 'load_tools',
  });
  const profile = getProfile('fuzz_loaded_probe');
  const snapshot = resolveTurnTools(
    profile,
    { profile: 'fuzz_loaded_probe', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  const beforeVisible = [...snapshot.visible];
  const ids = Array.from({ length: 1000 }, (_, i) => `missing_tool_${i}`);
  const result = promoteLoadedTools(snapshot, ids, profile);
  assertEquals(result.promoted, []);
  assertEquals(result.failure?.code, 'invalid_output');
  assertEquals(snapshot.visible, beforeVisible);
});

Deno.test('adversarial/fuzz: unicode tool name executes', async () => {
  const unicodeName = '工具_🔧_probe';
  registerTool({
    type: 'function',
    name: unicodeName,
    description: 'Unicode tool id probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ q: z.string() }),
    output: z.object({ finding: z.string() }),
    handler: (input) => ({ finding: input.q }),
  });
  flashProfile('unicode_tool_probe', 1, { allow: [unicodeName] });
  const events = await invokeRegisteredTool({
    profile: 'unicode_tool_probe',
    name: unicodeName,
    input: { q: '你好' },
  });
  assertEquals(lastTool(events, unicodeName)?.phase, 'complete');
});

Deno.test('adversarial/fuzz: prototype pollution keys stripped from tool args', async () => {
  registerTool({
    type: 'function',
    name: 'proto_strip_probe',
    description: 'Ensures polluted keys never reach handler',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ safe: z.string() }),
    output: z.object({ finding: z.string(), keys: z.array(z.string()) }),
    handler: (input) => ({
      finding: input.safe,
      keys: Object.keys(input),
    }),
  });
  flashProfile('proto_strip_bot', 1, { allow: ['proto_strip_probe'] });
  const polluted = JSON.parse('{"safe":"ok","__proto__":{"polluted":true}}') as Record<
    string,
    unknown
  >;
  Object.assign(polluted, { constructor: { polluted: true } });
  const events = await invokeRegisteredTool({
    profile: 'proto_strip_bot',
    name: 'proto_strip_probe',
    input: polluted,
  });
  const tool = lastTool(events, 'proto_strip_probe');
  assertEquals(tool?.phase, 'complete');
  const output = tool?.output as { keys?: string[] } | undefined;
  assertEquals(output?.keys, ['safe']);
  assertEquals((Object.prototype as { polluted?: boolean }).polluted, undefined);
});

Deno.test('adversarial/fuzz: loaded[] rejects __proto__ id', () => {
  flashProfile('fuzz_proto_id_probe', 1, {
    allow: ['load_tools', 'record_lookup'],
    t2Loader: 'load_tools',
  });
  const profile = getProfile('fuzz_proto_id_probe');
  const snapshot = resolveTurnTools(
    profile,
    { profile: 'fuzz_proto_id_probe', input: { text: 'x' } },
    'gemini35FlashLite',
  );
  const beforeVisible = [...snapshot.visible];
  const result = promoteLoadedTools(snapshot, ['record_lookup', '__proto__'], profile);
  assertEquals(result.promoted, []);
  assertEquals(result.failure?.code, 'invalid_output');
  assertEquals(snapshot.visible, beforeVisible);
});

function lastTool(events: TurnEvent[], name: string) {
  return events.findLast((e) => e.type === 'tool' && e.tool?.name === name)?.tool;
}
