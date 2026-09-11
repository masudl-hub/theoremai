import '../fixtures/test-host.ts';
import { z } from 'zod';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { TheorumError } from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { resolveTurn } from '../../src/kernel/registry/resolve.ts';
import { formatToolResult, invokeTool, registerTool } from '../../src/kernel/tools/mod.ts';
import {
  expandT1Policy,
  prepareTurnToolSnapshot,
  promoteLoadedTools,
  resolveTurnTools,
} from '../../src/kernel/tools/resolve.ts';
import { validateToolInputSchema } from '../../src/kernel/tools/schema.ts';
import type { ToolContext, ToolLoadContext } from '../../src/kernel/tools/types.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

Deno.test('runTurn ends with stop kind tool when execution pauses', async () => {
  registerProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: 'pause_stop_probe',
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 2,
    tools: { allow: ['delete_resource'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'delete_resource', arguments: { id: 'x' }, id: 'c1' },
      };
    },
  };

  const events = await collect(
    runTurn(
      {
        profile: 'pause_stop_probe',
        input: { text: 'delete' },
      },
      provider,
    ),
  );

  assertEquals(
    events.some((e) => e.tool?.phase === 'pause'),
    true,
  );
  assertEquals(events.at(-1)?.stop?.kind, 'tool');
  assertEquals(events.at(-1)?.tools?.gated.includes('delete_resource'), true);
  assertEquals(events.at(-1)?.tools?.visible.includes('delete_resource'), true);
});

Deno.test('always_confirm ignores session permissions until resume.granted', async () => {
  registerProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: 'always_confirm_probe',
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 1,
    tools: { allow: ['always_confirm_tool'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'always_confirm_tool', arguments: {}, id: 'c1' },
      };
    },
  };

  const paused = await collect(
    runTurn(
      {
        profile: 'always_confirm_probe',
        sessionPermissions: ['always_confirm_tool'],
        input: { text: 'go' },
      },
      provider,
    ),
  );
  assertEquals(
    paused.findLast((e) => e.tool?.name === 'always_confirm_tool')?.tool?.phase,
    'pause',
  );

  const resumed = await invokeRegisteredTool({
    profile: 'always_confirm_probe',
    name: 'always_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(
    resumed.findLast((e) => e.tool?.name === 'always_confirm_tool')?.tool?.phase,
    'complete',
  );
});

Deno.test('path-mismatched allowed tool returns not_gated not not_loaded', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'path_mismatch_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['web_only_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const { generation } = resolveTurn({ profile: 'path_mismatch_probe', input: { text: 'x' } });
  assertEquals(generation.tools.gated.includes('web_only_tool'), false);

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'web_only_tool', arguments: {}, id: 'c1' },
      };
    },
  };

  const events = await collect(
    runTurn({ profile: 'path_mismatch_probe', input: { text: 'x' } }, provider),
  );
  const toolEv = events.findLast((e) => e.tool?.name === 'web_only_tool');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_gated');
});

Deno.test('provider tool call for unregistered name yields unknown_tool', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'unknown_provider_tool_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'summon_dragon', arguments: { power: 9000 }, id: 'c1' },
      };
    },
  };
  const events = await collect(
    runTurn({ profile: 'unknown_provider_tool_probe', input: { text: 'x' } }, provider),
  );
  const toolEv = events.findLast((e) => e.tool?.name === 'summon_dragon');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'unknown_tool');
});

Deno.test('preflight confirmation emits pause not error', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'preflight_confirm_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['preflight_confirm_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'preflight_confirm_bot',
    name: 'preflight_confirm_tool',
    input: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'preflight_confirm_tool');
  assertEquals(toolEv?.tool?.phase, 'pause');
  assertEquals(toolEv?.tool?.pause?.kind, 'confirmation');
});

Deno.test('preflight confirmation resumes after granted', async () => {
  const events = await invokeRegisteredTool({
    profile: 'preflight_confirm_bot',
    name: 'preflight_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'preflight_confirm_tool');
  assertEquals(toolEv?.tool?.phase, 'complete');
  assertEquals((toolEv?.tool?.output as { finding?: string })?.finding, 'preflight cleared');
});

Deno.test('handler streaming is live through invoke and runTurn', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerTool({
    type: 'function',
    name: 'live_stream_probe',
    description: 'Emits all streaming phases then blocks until released',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: async function* () {
      yield { kind: 'progress', data: { pct: 10 } };
      yield { kind: 'trace', step: { name: 'step1', kind: 'test', status: 'ok' } };
      yield { kind: 'artifact', artifact: { id: 'art-1' } };
      yield { kind: 'warning', warning: { code: 'slow', message: 'degraded' } };
      await gate;
      yield { kind: 'complete', output: { finding: 'released' } };
    },
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'live_stream_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['live_stream_probe', 'streaming_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const invokePhases: string[] = [];
  const invokeRun = (async () => {
    for await (const event of invokeTool({
      profile: 'live_stream_bot',
      name: 'live_stream_probe',
      input: {},
    })) {
      if (event.tool?.phase) {
        invokePhases.push(event.tool.phase);
        if (event.tool.phase === 'progress') {
          release();
        }
      }
    }
  })();
  await invokeRun;
  for (const phase of ['progress', 'trace', 'artifact', 'warning', 'complete']) {
    assertEquals(invokePhases.includes(phase), true);
  }
  assertEquals(invokePhases.indexOf('progress') < invokePhases.indexOf('complete'), true);

  const provider: ModelProvider = {
    async *complete() {
      yield {
        type: 'tool',
        tool: { name: 'streaming_probe', arguments: {}, id: 'c1' },
      };
    },
  };
  const turnEvents = await collect(
    runTurn(
      {
        profile: 'live_stream_bot',
        input: { text: 'stream' },
      },
      provider,
    ),
  );
  for (const phase of ['progress', 'trace', 'artifact', 'warning']) {
    assertEquals(
      turnEvents.some((e) => e.tool?.phase === phase),
      true,
    );
  }
  assertEquals(
    turnEvents.findLast((e) => e.tool?.name === 'streaming_probe')?.tool?.phase,
    'complete',
  );
});

Deno.test('invokeTool for allowed T0 tool succeeds and ends completed', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'invoke_allow_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_allow_probe',
    name: 'stub_tool',
    input: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'stub_tool');
  assertEquals(toolEv?.tool?.phase, 'complete');
  assertEquals(events.at(-1)?.stop?.kind, 'completed');
});

Deno.test('catalog path filter excludes tools from snapshot', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'path_filter_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['web_only_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'path_filter_probe',
    path: 'cli',
    input: { text: 'x' },
  });
  assertEquals(generation.tools.gated.includes('web_only_tool'), false);
  assertEquals(generation.tools.executable.includes('web_only_tool'), false);
});

Deno.test('exposeToModel false omits secret from provider tool result', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'hidden_model_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['hidden_from_model_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  let toolResultText: string | undefined;
  let callCount = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      callCount++;
      if (callCount > 1) {
        const step = req.interactionOnlyInput?.[0] as {
          result?: Array<{ text?: string }>;
        };
        toolResultText = step?.result?.[0]?.text;
        yield { type: 'text', text: 'done' };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'hidden_from_model_tool', arguments: {}, id: 'c1' },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'v1_hidden',
      };
    },
  };

  await collect(
    runTurn(
      {
        profile: 'hidden_model_probe',
        input: { text: 'x' },
      },
      provider,
    ),
  );

  assertEquals(toolResultText?.includes('classified'), false);
  assertEquals(toolResultText?.includes('Completed'), true);
});

Deno.test('formatToolResult sanitizes finding and includes data', () => {
  const text = formatToolResult({ finding: 'ok', data: { n: 1 } });
  assertEquals(text.includes('ok'), true);
  assertEquals(text.includes('"n":1'), true);
});

Deno.test('permission check runs before preflight', async () => {
  let preflightRan = false;
  registerTool({
    type: 'function',
    name: 'permission_before_preflight_probe',
    description: 'Permission before preflight probe',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'session_consent',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    preflight: () => {
      preflightRan = true;
    },
    handler: () => ({ finding: 'ran' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'permission_order_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['permission_before_preflight_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'permission_order_probe',
    name: 'permission_before_preflight_probe',
    input: {},
  });
  assertEquals(preflightRan, false);
  assertEquals(
    events.findLast((e) => e.tool?.name === 'permission_before_preflight_probe')?.tool?.phase,
    'pause',
  );
});

Deno.test('t2Loader function promotes T2 ids from { loaded }', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't2_promote_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['load_tools', 'record_lookup'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_promote_probe',
    name: 'load_tools',
    input: { names: ['record_lookup'] },
  });
  const complete = events.findLast(
    (e) => e.tool?.name === 'load_tools' && e.tool?.phase === 'complete',
  );
  assertEquals(complete?.tool?.output, { loaded: ['record_lookup'] });
});

Deno.test('loader promote rejects non-T2 tool ids', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'promote_tier_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['load_tools', 'stub_tool'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile('promote_tier_probe');
  const snapshot = resolveTurnTools(
    profile,
    {
      profile: 'promote_tier_probe',
      input: { text: 'x' },
    },
    'gemini35FlashLite',
  );
  const result = promoteLoadedTools(snapshot, ['stub_tool'], profile);
  assertEquals(result.failure?.code, 'invalid_output');
  assertEquals(result.promoted, []);
});

Deno.test('profile.tools.t1Policy wires T1 function tools via prepareTurnToolSnapshot', async () => {
  const ContextualInput = z.object({ q: z.string() });
  registerTool({
    type: 'function',
    name: 'contextual_lookup',
    description: 'Lookup when host selects it',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: ContextualInput,
    output: z.object({ finding: z.string() }),
    handler: (input) => ({ finding: `found ${(input as { q: string }).q}` }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't1_loader_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: {
        allow: ['contextual_lookup'],
        t1Policy: () => ['contextual_lookup'],
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const req = {
    profile: 't1_loader_probe',
    input: { text: 'find my order' },
  };
  const profile = getProfile('t1_loader_probe');
  const snapshot = await prepareTurnToolSnapshot(profile, req, 'gemini35FlashLite');
  assertEquals(snapshot.visible, ['contextual_lookup']);
});

Deno.test('T1 not_loaded message cites t1Policy', async () => {
  registerTool({
    type: 'function',
    name: 't1_not_loaded_probe',
    description: 'T1 visibility probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't1_not_loaded_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['t1_not_loaded_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't1_not_loaded_bot',
    name: 't1_not_loaded_probe',
    input: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 't1_not_loaded_probe');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_loaded');
  assertEquals(toolEv?.tool?.failure?.message?.includes('t1Policy'), true);
});

Deno.test('invokeTool resume cannot bypass T2 not_loaded without promoted', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't2_resume_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_resume_probe',
    name: 'record_lookup',
    input: { q: 'secret' },
    resume: { value: true },
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_loaded');
});

Deno.test('invokeTool resume runs T2 when promoted ids are supplied', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't2_resume_promoted_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_resume_promoted_probe',
    name: 'record_lookup',
    input: { q: 'ok' },
    promoted: ['record_lookup'],
    resume: { value: true },
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'record_lookup')?.tool?.phase, 'complete');
});

Deno.test('invokeTool wires T1 tools when profile.tools.t1Policy is set', async () => {
  registerTool({
    type: 'function',
    name: 'invoke_t1_probe',
    description: 'T1 invoke probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({ q: z.string() }),
    output: z.object({ finding: z.string() }),
    handler: (input) => ({ finding: `invoke ${(input as { q: string }).q}` }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'invoke_t1_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: {
        allow: ['invoke_t1_probe'],
        t1Policy: () => ['invoke_t1_probe'],
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'invoke_t1_bot',
    name: 'invoke_t1_probe',
    input: { q: 'x' },
  });
  assertEquals(events.findLast((e) => e.tool?.name === 'invoke_t1_probe')?.tool?.phase, 'complete');
});

Deno.test('empty resume object does not bypass T2 load checks', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'empty_resume_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['record_lookup'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'empty_resume_probe',
    name: 'record_lookup',
    input: { q: 'x' },
    resume: {},
  });
  const toolEv = events.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(toolEv?.tool?.phase, 'error');
  assertEquals(toolEv?.tool?.failure?.code, 'not_loaded');
});

Deno.test('loader output lists only ids actually promoted', async () => {
  registerTool({
    type: 'function',
    name: 'ungated_t2_probe',
    description: 'T2 tool whose paths exclude the default turn',
    category: 'test',
    access: 'read-only',
    paths: ['web'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ungated' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'loader_output_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['load_tools', 'record_lookup', 'ungated_t2_probe'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 'loader_output_probe',
    name: 'load_tools',
    input: { names: ['record_lookup', 'ungated_t2_probe'] },
  });
  const complete = events.findLast(
    (e) => e.tool?.name === 'load_tools' && e.tool?.phase === 'complete',
  );
  assertEquals(complete?.tool?.output, { loaded: ['record_lookup'] });
});

Deno.test('path omitted excludes tools without wildcard paths', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'path_default_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['web_only_tool', 'stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 'path_default_probe',
    input: { text: 'x' },
  });
  assertEquals(generation.tools.gated.includes('web_only_tool'), false);
  assertEquals(generation.tools.gated.includes('stub_tool'), true);
});

Deno.test('T1 builtins stay off wire until profile.tools.t1Policy selects them', async () => {
  registerTool({
    type: 'builtin',
    name: 'deferred_builtin_probe',
    description: 'Deferred builtin probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    wire: { interactions: 'deferred_probe' },
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't1_builtin_probe',
      models: {
        gemini35FlashLite: {
          ...HOST_BINDINGS.gemini35FlashLite,
          builtInTools: ['deferred_builtin_probe'],
        },
      },
      key: 'slotA',
      maxSteps: 1,
      tools: {
        allow: [],
        t1Policy: () => ['deferred_builtin_probe'],
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const req = {
    profile: 't1_builtin_probe',
    input: { text: 'x' },
  };
  const profile = getProfile('t1_builtin_probe');
  const snapshot = resolveTurnTools(profile, req, 'gemini35FlashLite');
  assertEquals(snapshot.builtins.includes('deferred_builtin_probe'), false);
  await expandT1Policy(snapshot, profile, req);
  assertEquals(snapshot.builtins, ['deferred_builtin_probe']);
});

Deno.test('runTurn expands profile.tools.t1Policy before provider sees T1 tools', async () => {
  registerTool({
    type: 'function',
    name: 'runturn_t1_probe',
    description: 'T1 runTurn probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'runturn ok' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'runturn_t1_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: {
        allow: ['runturn_t1_probe'],
        t1Policy: () => ['runturn_t1_probe'],
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  let sawWire = false;
  const provider: ModelProvider = {
    async *complete(req) {
      sawWire = req.wireTools?.some((w) => w.name === 'runturn_t1_probe') ?? false;
      yield { type: 'text', text: 'done' };
    },
  };
  await collect(
    runTurn(
      {
        profile: 'runturn_t1_bot',
        input: { text: 'x' },
      },
      provider,
    ),
  );
  assertEquals(sawWire, true);
});

Deno.test('failure codes surface on invokeTool path', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'failure_codes_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['stub_tool', 'denied_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const invalidInput = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'stub_tool',
    input: { value: 'not-a-number' },
  });
  assertEquals(
    invalidInput.findLast((e) => e.tool?.name === 'stub_tool')?.tool?.failure?.code,
    'invalid_input',
  );

  const notAllowed = await invokeRegisteredTool({
    profile: 'pinned',
    name: 'denied_tool',
    input: {},
  });
  assertEquals(
    notAllowed.findLast((e) => e.tool?.name === 'denied_tool')?.tool?.failure?.code,
    'not_allowed',
  );

  const unknown = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'missing_tool_xyz',
    input: {},
  });
  assertEquals(
    unknown.findLast((e) => e.tool?.name === 'missing_tool_xyz')?.tool?.failure?.code,
    'unknown_tool',
  );

  const unauthorized = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'denied_tool',
    input: {},
  });
  assertEquals(
    unauthorized.findLast((e) => e.tool?.name === 'denied_tool')?.tool?.failure?.code,
    'not_authorized',
  );
});

Deno.test('permission granted alone does not resume interactive tools', async () => {
  registerTool({
    type: 'function',
    name: 'interactive_resume_probe',
    description: 'Interactive resume probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ prompt: z.string() }),
    output: z.object({ finding: z.string() }),
    interactive: {
      render: (input) => ({ kind: 'text', prompt: (input as { prompt: string }).prompt }),
    },
    handler: (_input, ctx) => ({ finding: String(ctx.resume?.value ?? 'missing') }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'interactive_resume_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['interactive_resume_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const paused = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
  });
  assertEquals(
    paused.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'pause',
  );

  const fakeResume = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
    resume: { granted: true },
  });
  assertEquals(
    fakeResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'pause',
  );

  const realResume = await invokeRegisteredTool({
    profile: 'interactive_resume_bot',
    name: 'interactive_resume_probe',
    input: { prompt: 'choose' },
    resume: { value: 'picked' },
  });
  assertEquals(
    realResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.phase,
    'complete',
  );
  assertEquals(
    (
      realResume.findLast((e) => e.tool?.name === 'interactive_resume_probe')?.tool?.output as {
        finding?: string;
      }
    )?.finding,
    'picked',
  );
});

Deno.test('T2 tools are not visible until loader promotes them', () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't2_probe',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['load_tools', 'record_lookup'], t2Loader: 'load_tools' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const { generation } = resolveTurn({
    profile: 't2_probe',
    input: { text: 'x' },
  });
  assertEquals(generation.tools.visible, ['load_tools']);
  assertEquals(generation.tools.visible.includes('record_lookup'), false);
});

Deno.test('invalid handler output and throws surface failure codes', async () => {
  /** Intentional invalid output for validation coverage. */
  function invalidOutput(): { finding: string } {
    const bad: Record<string, unknown> = { wrong: true };
    return bad as { finding: string };
  }
  registerTool({
    type: 'function',
    name: 'bad_output_probe',
    description: 'Returns wrong output shape',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => invalidOutput(),
  });
  registerTool({
    type: 'function',
    name: 'throwing_handler_probe',
    description: 'Throws from handler',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => {
      throw new Error('boom');
    },
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'output_error_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['bad_output_probe', 'throwing_handler_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );

  const badOut = await invokeRegisteredTool({
    profile: 'output_error_bot',
    name: 'bad_output_probe',
    input: {},
  });
  assertEquals(
    badOut.findLast((e) => e.tool?.name === 'bad_output_probe')?.tool?.failure?.code,
    'invalid_output',
  );

  const threw = await invokeRegisteredTool({
    profile: 'output_error_bot',
    name: 'throwing_handler_probe',
    input: {},
  });
  assertEquals(
    threw.findLast((e) => e.tool?.name === 'throwing_handler_probe')?.tool?.failure?.code,
    'handler_error',
  );
});

Deno.test('validateToolInputSchema rejects Gemini-unsupported keys', () => {
  assertThrows(
    () =>
      validateToolInputSchema({
        type: 'object',
        properties: { n: { type: 'number' } },
        additionalProperties: false,
      }),
    TheorumError,
  );
});

// ── T01 host context slot ──────────────────────────────────────────────

/** Register a T1 probe that records the `host` it observes at every hook. */
function registerHostProbe(name: string, seen: Array<{ hook: string; host: unknown }>): void {
  registerTool({
    type: 'function',
    name,
    description: 'Records ctx.host at every hook',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({ q: z.string().optional() }),
    output: z.object({ finding: z.string() }),
    canExecute: (_input, ctx: ToolContext) => {
      seen.push({ hook: 'canExecute', host: ctx.host });
      return true;
    },
    preflight: (_input, ctx: ToolContext) => {
      seen.push({ hook: 'preflight', host: ctx.host });
      return undefined;
    },
    handler: (_input, ctx: ToolContext) => {
      seen.push({ hook: 'handler', host: ctx.host });
      return { finding: 'observed' };
    },
  });
}

function hostProbeProvider(name: string, delayMs = 0): ModelProvider {
  return {
    async *complete() {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield { type: 'tool', tool: { name, arguments: { q: 'x' }, id: `${name}_call` } };
    },
  };
}

Deno.test('handler, preflight, canExecute and t1Policy observe the same host object for a turn', async () => {
  const seen: Array<{ hook: string; host: unknown }> = [];
  registerHostProbe('host_ctx_probe', seen);
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_ctx_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: {
        allow: ['host_ctx_probe'],
        t1Policy: (ctx: ToolLoadContext) => {
          seen.push({ hook: 't1Policy', host: ctx.host });
          return ['host_ctx_probe'];
        },
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const host = { db: Symbol('db'), user: 'u1' };
  await collect(
    runTurn(
      { profile: 'host_ctx_bot', input: { text: 'x' }, host },
      hostProbeProvider('host_ctx_probe'),
    ),
  );
  assertEquals(
    seen.map((s) => s.hook),
    ['t1Policy', 'canExecute', 'preflight', 'handler'],
  );
  for (const entry of seen) {
    assertEquals(entry.host === host, true);
  }
});

Deno.test("concurrent runTurn calls never observe each other's host", async () => {
  const seenA: Array<{ hook: string; host: unknown }> = [];
  const seenB: Array<{ hook: string; host: unknown }> = [];
  registerHostProbe('host_iso_probe_a', seenA);
  registerHostProbe('host_iso_probe_b', seenB);
  for (const [id, name] of [
    ['host_iso_bot_a', 'host_iso_probe_a'],
    ['host_iso_bot_b', 'host_iso_probe_b'],
  ] as const) {
    registerProfile(
      defineProfile({
        type: 'text',
        identity: { handle: 'test', system: 'test' },
        id,
        ...geminiModels('gemini35FlashLite'),
        maxSteps: 1,
        tools: { allow: [name], t1Policy: () => [name] },
        inputs: { text: true },
        guardrails: { quota: { perDay: 10 } },
      }),
    );
  }
  const hostA = { tenant: 'A' };
  const hostB = { tenant: 'B' };
  await Promise.all([
    collect(
      runTurn(
        { profile: 'host_iso_bot_a', input: { text: 'x' }, host: hostA },
        hostProbeProvider('host_iso_probe_a', 15),
      ),
    ),
    collect(
      runTurn(
        { profile: 'host_iso_bot_b', input: { text: 'x' }, host: hostB },
        hostProbeProvider('host_iso_probe_b', 1),
      ),
    ),
  ]);
  assertEquals(seenA.length, 3);
  assertEquals(seenB.length, 3);
  assertEquals(
    seenA.every((s) => s.host === hostA),
    true,
  );
  assertEquals(
    seenB.every((s) => s.host === hostB),
    true,
  );
});

Deno.test('invokeTool passes its own host to handler, preflight, canExecute and t1Policy', async () => {
  const seen: Array<{ hook: string; host: unknown }> = [];
  registerHostProbe('host_invoke_probe', seen);
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_invoke_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: {
        allow: ['host_invoke_probe'],
        t1Policy: (ctx: ToolLoadContext) => {
          seen.push({ hook: 't1Policy', host: ctx.host });
          return ['host_invoke_probe'];
        },
      },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const host = { invoked: true };
  const events = await invokeRegisteredTool({
    profile: 'host_invoke_bot',
    name: 'host_invoke_probe',
    input: { q: 'x' },
    host,
  });
  assertEquals(
    events.findLast((e) => e.tool?.name === 'host_invoke_probe')?.tool?.phase,
    'complete',
  );
  assertEquals(
    seen.map((s) => s.hook),
    ['t1Policy', 'canExecute', 'preflight', 'handler'],
  );
  assertEquals(
    seen.every((s) => s.host === host),
    true,
  );
});

Deno.test('host never appears in TurnEvents, trace records, pauses, pause input, or provider requests', async () => {
  const sentinel = `HOST_SENTINEL_${crypto.randomUUID()}`;
  const host = { sentinel, nested: { again: sentinel }, toString: () => sentinel };
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'host_sentinel_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['delete_resource', 'stub_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const providerRequests: ProviderCompleteRequest[] = [];
  const provider: ModelProvider = {
    async *complete(req) {
      providerRequests.push(req);
      if (providerRequests.length === 1) {
        yield { type: 'tool', tool: { name: 'stub_tool', arguments: { value: 1 }, id: 'c0' } };
        return;
      }
      yield { type: 'tool', tool: { name: 'delete_resource', arguments: { id: 'x' }, id: 'c1' } };
    },
  };
  const records: TraceRecord[] = [];
  const events = await collect(
    runTurn(
      { profile: 'host_sentinel_bot', input: { text: 'delete' }, host },
      provider,
      memorySink(records),
    ),
  );
  const pause = events.find((e) => e.tool?.phase === 'pause')?.tool?.pause;
  assertEquals(pause?.kind, 'permission');
  assertEquals(JSON.stringify(pause).includes(sentinel), false);
  assertEquals(JSON.stringify(pause?.input).includes(sentinel), false);
  assertEquals(JSON.stringify(events).includes(sentinel), false);
  assertEquals(records.length, 1);
  assertEquals(JSON.stringify(records).includes(sentinel), false);
  assertEquals(providerRequests.length, 2);
  assertEquals(JSON.stringify(providerRequests).includes(sentinel), false);
  assertEquals(
    providerRequests.some((r) => 'host' in r),
    false,
  );

  const invoked = await invokeRegisteredTool({
    profile: 'host_sentinel_bot',
    name: 'delete_resource',
    input: { id: 'y' },
    host,
  });
  assertEquals(JSON.stringify(invoked).includes(sentinel), false);
});

// ── T04 host profile ───────────────────────────────────────────────────

Deno.test('invokeTool under a host profile executes a T2 tool without promotion and ignores path', async () => {
  registerProfile({
    type: 'host',
    id: 'host_invoke_ceiling',
    tools: { allow: ['record_lookup', 'web_only_tool', 'preflight_confirm_tool', 'stub_tool'] },
  });
  const t2 = await invokeRegisteredTool({
    profile: 'host_invoke_ceiling',
    name: 'record_lookup',
    input: { q: 'ok' },
  });
  const t2Event = t2.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(t2Event?.tool?.phase, 'complete');
  assertEquals(t2Event?.tool?.output, { finding: 'found ok' });
  assertEquals(t2.at(-1)?.stop?.kind, 'completed');

  // paths: ['web'] — not applied on host, even without a request path.
  const pathless = await invokeRegisteredTool({
    profile: 'host_invoke_ceiling',
    name: 'web_only_tool',
    input: {},
  });
  assertEquals(pathless.findLast((e) => e.tool?.name === 'web_only_tool')?.tool?.phase, 'complete');
});

Deno.test('invokeTool under a host profile rejects tools outside allow', async () => {
  registerProfile({
    type: 'host',
    id: 'host_invoke_denied',
    tools: { allow: ['stub_tool'] },
  });
  const events = await invokeRegisteredTool({
    profile: 'host_invoke_denied',
    name: 'record_lookup',
    input: { q: 'x' },
  });
  const ev = events.findLast((e) => e.tool?.name === 'record_lookup');
  assertEquals(ev?.tool?.phase, 'error');
  assertEquals(ev?.tool?.failure?.code, 'not_allowed');
  assertEquals(events.at(-1)?.stop?.kind, 'tool');
});

Deno.test('invokeTool under a host profile runs preflight and honours its pause', async () => {
  registerProfile({
    type: 'host',
    id: 'host_invoke_preflight',
    tools: { allow: ['preflight_confirm_tool'] },
  });
  const paused = await invokeRegisteredTool({
    profile: 'host_invoke_preflight',
    name: 'preflight_confirm_tool',
    input: {},
  });
  const pause = paused.findLast((e) => e.tool?.name === 'preflight_confirm_tool');
  assertEquals(pause?.tool?.phase, 'pause');
  assertEquals(pause?.tool?.pause?.kind, 'confirmation');

  const resumed = await invokeRegisteredTool({
    profile: 'host_invoke_preflight',
    name: 'preflight_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(
    resumed.findLast((e) => e.tool?.name === 'preflight_confirm_tool')?.tool?.phase,
    'complete',
  );
});

Deno.test('invokeTool under a host profile applies guardrails to tool output', async () => {
  registerTool({
    type: 'function',
    name: 'host_injecting_tool',
    description: 'Returns a directive in its finding',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: `report: ${INJ_IGNORE}` }),
  });
  registerProfile({
    type: 'host',
    id: 'host_invoke_guarded',
    tools: { allow: ['host_injecting_tool'] },
  });
  const events = await invokeRegisteredTool({
    profile: 'host_invoke_guarded',
    name: 'host_injecting_tool',
    input: {},
  });
  const guardrail = events.find((e) => e.type === 'guardrail')?.guardrail;
  assertEquals(guardrail?.stage, 'tool_result');
  assertEquals(guardrail?.provenance?.tool, 'host_injecting_tool');
  assertEquals(
    events.findLast((e) => e.tool?.name === 'host_injecting_tool')?.tool?.phase,
    'complete',
  );
});
