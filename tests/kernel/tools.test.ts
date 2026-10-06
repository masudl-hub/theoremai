import '../fixtures/test-host.ts';
import { z } from 'zod';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import {
  getProfile,
  invokeTool,
  registerProfile,
  registerTool,
  resolveTurn,
  runTurn,
} from '../../src/kernel/default-scope.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { executeRegisteredTool, formatToolResult } from '../../src/kernel/tools/mod.ts';
import {
  expandT1Policy,
  prepareTurnToolSnapshot,
  promoteLoadedTools,
  resolveTurnTools,
} from '../../src/kernel/tools/resolve.ts';
import { validateToolSchema } from '../../src/kernel/tools/schema.ts';
import type { ToolContext, ToolLoadContext } from '../../src/kernel/tools/types.ts';
import { uncheckedOutput } from '../../src/kernel/tools/unchecked-output.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import {
  eventsOf,
  failureOf,
  finalStop,
  firstOf,
  gateOf,
  lastOf,
  lastTool,
  outputOf,
  toolEventsOf,
} from '../fixtures/events.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';
import { invokeRegisteredTool } from '../fixtures/test-tools.ts';
import { catalogedSink, catalogGate } from '../fixtures/trace-catalog.ts';

Deno.test('runTurn ends with stop kind gate when execution gates', async () => {
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
        tool: { name: 'delete_resource', arguments: { id: 'x' }, callId: 'c1' },
      };
    },
  };

  const events = await Array.fromAsync(
    runTurn(
      {
        profile: 'pause_stop_probe',
        input: { text: 'delete' },
      },
      provider,
    ),
  );

  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool.phase === 'gate'),
    true,
  );
  const done = lastOf(events, 'done');
  assertEquals(done?.stop?.kind, 'gate');
  assertEquals(done?.tools?.gated.includes('delete_resource'), true);
  assertEquals(done?.tools?.visible.includes('delete_resource'), true);
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
        tool: { name: 'always_confirm_tool', arguments: {}, callId: 'c1' },
      };
    },
  };

  const paused = await Array.fromAsync(
    runTurn(
      {
        profile: 'always_confirm_probe',
        sessionPermissions: ['always_confirm_tool'],
        input: { text: 'go' },
      },
      provider,
    ),
  );
  assertEquals(lastTool(paused, 'always_confirm_tool')?.phase, 'gate');

  const resumed = await invokeRegisteredTool({
    profile: 'always_confirm_probe',
    name: 'always_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(lastTool(resumed, 'always_confirm_tool')?.phase, 'complete');
});

Deno.test('resume.granted false settles as denied with post_tool', async () => {
  registerProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id: 'deny_resume_probe',
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 1,
    tools: { allow: ['always_confirm_tool'] },
    inputs: { text: true },
    outputs: {},
    guardrails: { quota: { perDay: 50 } },
  });

  const stages: string[] = [];
  const denied = await invokeRegisteredTool({
    profile: 'deny_resume_probe',
    name: 'always_confirm_tool',
    input: {},
    resume: { granted: false },
    onStage: ({ stage }) => {
      stages.push(stage);
    },
  });
  assertEquals(lastTool(denied, 'always_confirm_tool')?.phase, 'error');
  assertEquals(failureOf(lastTool(denied, 'always_confirm_tool'))?.code, 'denied');
  assertEquals(stages.includes('post_tool'), true);
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
        tool: { name: 'web_only_tool', arguments: {}, callId: 'c1' },
      };
    },
  };

  const events = await Array.fromAsync(
    runTurn({ profile: 'path_mismatch_probe', input: { text: 'x' } }, provider),
  );
  const toolEv = lastTool(events, 'web_only_tool');
  assertEquals(toolEv?.phase, 'error');
  assertEquals(failureOf(toolEv)?.code, 'not_gated');
  assertEquals(failureOf(toolEv)?.kind, 'request');
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
        tool: { name: 'summon_dragon', arguments: { power: 9000 }, callId: 'c1' },
      };
    },
  };
  const events = await Array.fromAsync(
    runTurn({ profile: 'unknown_provider_tool_probe', input: { text: 'x' } }, provider),
  );
  const toolEv = lastTool(events, 'summon_dragon');
  assertEquals(toolEv?.phase, 'error');
  assertEquals(failureOf(toolEv)?.code, 'unknown_tool');
  assertEquals(failureOf(toolEv)?.kind, 'request');
});

Deno.test('preTool confirmation emits gate not error', async () => {
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
  const toolEv = lastTool(events, 'preflight_confirm_tool');
  assertEquals(toolEv?.phase, 'gate');
  assertEquals(gateOf(toolEv)?.kind, 'confirmation');
});

Deno.test('preTool confirmation resumes after granted', async () => {
  const events = await invokeRegisteredTool({
    profile: 'preflight_confirm_bot',
    name: 'preflight_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  const toolEv = lastTool(events, 'preflight_confirm_tool');
  assertEquals(toolEv?.phase, 'complete');
  assertEquals((outputOf(toolEv) as { finding?: string })?.finding, 'preflight cleared');
});

Deno.test('preTool deny settles modelResult + post_tool callNotStarted', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'pretool_deny_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['denied_tool'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile('pretool_deny_bot');
  assertEquals(Boolean(profile), true);
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile: profile as NonNullable<typeof profile>,
    name: 'denied_tool',
    input: {},
    callId: 'deny_1',
    ctx: {},
    stages: {
      handlers: [],
      profile: profile as NonNullable<typeof profile>,
      step: 1,
      history: () => [],
      injectAllowed: false,
    },
  });
  let settlement: {
    callNotStarted?: boolean;
    failure?: { code: string; kind: string };
    modelResult?: unknown;
  } = {};
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
    events.push(next.value);
  }
  assertEquals(settlement.callNotStarted, true);
  assertEquals(settlement.failure?.code, 'not_authorized');
  assertEquals(settlement.failure?.kind, 'blocked');
  assertEquals(Boolean(settlement.modelResult), true);
  const post = events.find((e) => e.type === 'stage' && e.stage === 'post_tool');
  assertEquals(post?.type === 'stage' ? post.callNotStarted : undefined, true);
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
      if (event.type === 'tool' && event.tool.phase) {
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
        tool: { name: 'streaming_probe', arguments: {}, callId: 'c1' },
      };
    },
  };
  const turnEvents = await Array.fromAsync(
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
      turnEvents.some((e) => e.type === 'tool' && e.tool.phase === phase),
      true,
    );
  }
  assertEquals(lastTool(turnEvents, 'streaming_probe')?.phase, 'complete');
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
  const toolEv = lastTool(events, 'stub_tool');
  assertEquals(toolEv?.phase, 'complete');
  assertEquals(finalStop(events)?.kind, 'completed');
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
        toolResultText = req.continuation?.[0]?.content;
        yield { type: 'text', text: 'done' };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'hidden_from_model_tool', arguments: {}, callId: 'c1' },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'v1_hidden',
      };
    },
  };

  await Array.fromAsync(
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

Deno.test('permission check runs before preTool', async () => {
  let preToolRan = false;
  registerTool({
    type: 'function',
    name: 'permission_before_preflight_probe',
    description: 'Permission before preTool probe',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'session_consent',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    preTool: () => {
      preToolRan = true;
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
  assertEquals(preToolRan, false);
  assertEquals(lastTool(events, 'permission_before_preflight_probe')?.phase, 'gate');
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
  const complete = lastTool(events, 'load_tools');
  assertEquals(outputOf(complete), { loaded: ['record_lookup'] });
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
    defaultKernelScope.tools,
    profile,
    {
      profile: 'promote_tier_probe',
      input: { text: 'x' },
    },
    'gemini35FlashLite',
  );
  const result = promoteLoadedTools(defaultKernelScope.tools, snapshot, ['stub_tool'], profile);
  assertEquals(result.failure?.code, 'invalid_output');
  assertEquals(result.failure?.kind, 'bad_response');
  assertEquals(result.promoted, []);
});

Deno.test('profile.tools.t1Policy wires T2 function tools via prepareTurnToolSnapshot', async () => {
  const ContextualInput = z.object({ q: z.string() });
  registerTool({
    type: 'function',
    name: 'contextual_lookup',
    description: 'Lookup when host selects it',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
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
  const snapshot = await prepareTurnToolSnapshot(
    defaultKernelScope.tools,
    profile,
    req,
    'gemini35FlashLite',
  );
  assertEquals(snapshot.visible, ['contextual_lookup']);
});

Deno.test('a T2 tool nothing loaded says to run the loader', async () => {
  registerTool({
    type: 'function',
    name: 't2_not_loaded_probe',
    description: 'T2 visibility probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 't2_not_loaded_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['t2_not_loaded_probe'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const events = await invokeRegisteredTool({
    profile: 't2_not_loaded_bot',
    name: 't2_not_loaded_probe',
    input: {},
  });
  const toolEv = lastTool(events, 't2_not_loaded_probe');
  assertEquals(toolEv?.phase, 'error');
  assertEquals(failureOf(toolEv)?.code, 'not_loaded');
  assertEquals(failureOf(toolEv)?.kind, 'request');
  assertEquals(failureOf(toolEv)?.message?.includes('t2Loader'), true);
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
    resume: { granted: true },
  });
  const toolEv = lastTool(events, 'record_lookup');
  assertEquals(toolEv?.phase, 'error');
  assertEquals(failureOf(toolEv)?.code, 'not_loaded');
  assertEquals(failureOf(toolEv)?.kind, 'request');
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
    resume: { granted: true },
  });
  assertEquals(lastTool(events, 'record_lookup')?.phase, 'complete');
});

Deno.test('invokeTool wires T2 tools when profile.tools.t1Policy is set', async () => {
  registerTool({
    type: 'function',
    name: 'invoke_t1_probe',
    description: 'T2 invoke probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
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
  assertEquals(lastTool(events, 'invoke_t1_probe')?.phase, 'complete');
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
  const toolEv = lastTool(events, 'record_lookup');
  assertEquals(toolEv?.phase, 'error');
  assertEquals(failureOf(toolEv)?.code, 'not_loaded');
  assertEquals(failureOf(toolEv)?.kind, 'request');
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
  const complete = lastTool(events, 'load_tools');
  assertEquals(outputOf(complete), { loaded: ['record_lookup'] });
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

Deno.test('T2 builtins stay off wire until profile.tools.t1Policy selects them', async () => {
  registerTool({
    type: 'builtin',
    name: 'deferred_builtin_probe',
    description: 'Deferred builtin probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
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
      key: 'main',
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
  const snapshot = resolveTurnTools(defaultKernelScope.tools, profile, req, 'gemini35FlashLite');
  assertEquals(snapshot.builtins.includes('deferred_builtin_probe'), false);
  await expandT1Policy(defaultKernelScope.tools, snapshot, profile, req);
  assertEquals(snapshot.builtins, ['deferred_builtin_probe']);
});

Deno.test('runTurn expands profile.tools.t1Policy before provider sees the T2 tools it picked', async () => {
  registerTool({
    type: 'function',
    name: 'runturn_t1_probe',
    description: 'T2 runTurn probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
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
  await Array.fromAsync(
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
  assertEquals(failureOf(lastTool(invalidInput, 'stub_tool'))?.code, 'invalid_input');

  const notAllowed = await invokeRegisteredTool({
    profile: 'pinned',
    name: 'denied_tool',
    input: {},
  });
  assertEquals(failureOf(lastTool(notAllowed, 'denied_tool'))?.code, 'not_allowed');

  const unknown = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'missing_tool_xyz',
    input: {},
  });
  assertEquals(failureOf(lastTool(unknown, 'missing_tool_xyz'))?.code, 'unknown_tool');

  const unauthorized = await invokeRegisteredTool({
    profile: 'failure_codes_probe',
    name: 'denied_tool',
    input: {},
  });
  assertEquals(failureOf(lastTool(unauthorized, 'denied_tool'))?.code, 'not_authorized');
});

Deno.test('permission granted alone does not substitute ask_user answer', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'ask_user_resume_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['ask_user'] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const awaiting = await invokeRegisteredTool({
    profile: 'ask_user_resume_bot',
    name: 'ask_user',
    input: { kind: 'text', prompt: 'choose' },
  });
  const first = lastTool(awaiting, 'ask_user');
  assertEquals(first?.phase, 'complete');
  assertEquals((outputOf(first) as { status?: string })?.status, 'awaiting_user_input');
  assertEquals(finalStop(awaiting)?.kind, 'completed');

  const fakeResume = await invokeRegisteredTool({
    profile: 'ask_user_resume_bot',
    name: 'ask_user',
    input: { kind: 'text', prompt: 'choose' },
    resume: { granted: true },
  });
  const second = lastTool(fakeResume, 'ask_user');
  assertEquals(second?.phase, 'complete');
  assertEquals((outputOf(second) as { status?: string })?.status, 'awaiting_user_input');
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
  assertEquals(failureOf(lastTool(badOut, 'bad_output_probe'))?.code, 'invalid_output');

  const threw = await invokeRegisteredTool({
    profile: 'output_error_bot',
    name: 'throwing_handler_probe',
    input: {},
  });
  assertEquals(failureOf(lastTool(threw, 'throwing_handler_probe'))?.code, 'handler_error');
});

Deno.test('validateToolSchema checks structure and leaves provider keywords to the provider', () => {
  validateToolSchema(
    { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false },
    'input',
  );
  assertThrows(
    () => validateToolSchema({ type: 'object', properties: {}, required: ['toString'] }, 'input'),
    TheoremError,
    "required key 'toString' missing from properties",
  );
});

/** Register a T2 probe that records the `host` it observes at every hook. */
function registerHostProbe(name: string, seen: Array<{ hook: string; host: unknown }>): void {
  registerTool({
    type: 'function',
    name,
    description: 'Records ctx.host at every hook',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T2',
    permission: 'auto',
    input: z.object({ q: z.string().optional() }),
    output: z.object({ finding: z.string() }),
    preTool: (_input, ctx: ToolContext) => {
      seen.push({ hook: 'preTool', host: ctx.host });
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
      yield { type: 'tool', tool: { name, arguments: { q: 'x' }, callId: `${name}_call` } };
    },
  };
}

Deno.test('handler, preTool and t1Policy observe the same host object for a turn', async () => {
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
  await Array.fromAsync(
    runTurn(
      { profile: 'host_ctx_bot', input: { text: 'x' }, host },
      hostProbeProvider('host_ctx_probe'),
    ),
  );
  assertEquals(
    seen.map((s) => s.hook),
    ['t1Policy', 'preTool', 'handler'],
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
    Array.fromAsync(
      runTurn(
        { profile: 'host_iso_bot_a', input: { text: 'x' }, host: hostA },
        hostProbeProvider('host_iso_probe_a', 15),
      ),
    ),
    Array.fromAsync(
      runTurn(
        { profile: 'host_iso_bot_b', input: { text: 'x' }, host: hostB },
        hostProbeProvider('host_iso_probe_b', 1),
      ),
    ),
  ]);
  assertEquals(seenA.length, 2);
  assertEquals(seenB.length, 2);
  assertEquals(
    seenA.every((s) => s.host === hostA),
    true,
  );
  assertEquals(
    seenB.every((s) => s.host === hostB),
    true,
  );
});

Deno.test('invokeTool passes its own host to handler, preTool and t1Policy', async () => {
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
  assertEquals(lastTool(events, 'host_invoke_probe')?.phase, 'complete');
  assertEquals(
    seen.map((s) => s.hook),
    ['t1Policy', 'preTool', 'handler'],
  );
  assertEquals(
    seen.every((s) => s.host === host),
    true,
  );
});

Deno.test('host never appears in TurnEvents, trace records, gates, gate input, or provider requests', async () => {
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
        yield { type: 'tool', tool: { name: 'stub_tool', arguments: { value: 1 }, callId: 'c0' } };
        return;
      }
      yield {
        type: 'tool',
        tool: { name: 'delete_resource', arguments: { id: 'x' }, callId: 'c1' },
      };
    },
  };
  const records: TraceRecord[] = [];
  const events = await Array.fromAsync(
    runTurn(
      { profile: 'host_sentinel_bot', input: { text: 'delete' }, host },
      provider,
      catalogedSink(records),
    ),
  );
  const gate = toolEventsOf(events, 'gate')[0]?.gate;
  assertEquals(gate?.kind, 'permission');
  assertEquals(JSON.stringify(gate).includes(sentinel), false);
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
  const t2Event = lastTool(t2, 'record_lookup');
  assertEquals(t2Event?.phase, 'complete');
  assertEquals(outputOf(t2Event), { finding: 'found ok' });
  assertEquals(finalStop(t2)?.kind, 'completed');

  // paths: ['web'] — not applied on host, even without a request path.
  const pathless = await invokeRegisteredTool({
    profile: 'host_invoke_ceiling',
    name: 'web_only_tool',
    input: {},
  });
  assertEquals(lastTool(pathless, 'web_only_tool')?.phase, 'complete');
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
  const ev = lastTool(events, 'record_lookup');
  assertEquals(ev?.phase, 'error');
  assertEquals(failureOf(ev)?.code, 'not_allowed');
  assertEquals(finalStop(events)?.kind, 'completed');
});

Deno.test('invokeTool under a host profile runs preTool and honours its gate', async () => {
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
  const gated = lastTool(paused, 'preflight_confirm_tool');
  assertEquals(gated?.phase, 'gate');
  assertEquals(gateOf(gated)?.kind, 'confirmation');

  const resumed = await invokeRegisteredTool({
    profile: 'host_invoke_preflight',
    name: 'preflight_confirm_tool',
    input: {},
    resume: { granted: true },
  });
  assertEquals(lastTool(resumed, 'preflight_confirm_tool')?.phase, 'complete');
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
  const guardrail = firstOf(events, 'guardrail')?.guardrail;
  assertEquals(guardrail?.stage, 'tool_result');
  assertEquals(guardrail?.provenance?.tool, 'host_injecting_tool');
  assertEquals(lastTool(events, 'host_injecting_tool')?.phase, 'complete');
});

function postToolProfile(id: string, tool: string) {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [tool] },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile(id);
  if (!profile) throw new Error(`profile ${id} missing`);
  return profile;
}

function registerPostToolProbe(name: string, output: unknown) {
  registerTool({
    type: 'function',
    name,
    description: 'post_tool affordance probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string(), secret: z.string().optional() }),
    handler: () => uncheckedOutput(output),
  });
}

async function runPostToolProbe(args: {
  profile: NonNullable<ReturnType<typeof getProfile>>;
  tool: string;
  onStage: (ctx: { stage: string; outputRaw?: unknown; failure?: unknown }) => unknown;
}) {
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile: args.profile,
    name: args.tool,
    input: {},
    callId: `${args.tool}_1`,
    ctx: {},
    stages: {
      handlers: [args.onStage as never],
      profile: args.profile,
      step: 1,
      history: () => [],
      injectAllowed: false,
    },
  });
  while (true) {
    const next = await exec.next();
    if (next.done) return { events, settlement: next.value };
    events.push(next.value);
  }
}

Deno.test('post_tool mutate replaces the raw output, re-validates it, and the model sees the replacement', async () => {
  registerPostToolProbe('post_mutate_probe', { finding: 'ok', secret: 'hunter2' });
  const profile = postToolProfile('post_mutate_bot', 'post_mutate_probe');
  let sawRaw: unknown;
  const { events, settlement } = await runPostToolProbe({
    profile,
    tool: 'post_mutate_probe',
    onStage: (ctx) => {
      if (ctx.stage !== 'post_tool') return undefined;
      sawRaw = ctx.outputRaw;
      return { mutate: { output: { finding: 'ok' } } };
    },
  });
  assertEquals(sawRaw, { finding: 'ok', secret: 'hunter2' });
  assertEquals(settlement.outputRaw, { finding: 'ok' });
  assertEquals(settlement.failure, undefined);
  assertEquals(settlement.modelResult?.modelText?.includes('hunter2'), false);
  assertEquals(
    events.some((e) => e.type === 'stage' && e.stageWarnings),
    false,
  );
});

Deno.test('post_tool mutate that fails the output schema settles as invalid_output', async () => {
  registerPostToolProbe('post_mutate_bad_probe', { finding: 'ok' });
  const profile = postToolProfile('post_mutate_bad_bot', 'post_mutate_bad_probe');
  const { events, settlement } = await runPostToolProbe({
    profile,
    tool: 'post_mutate_bad_probe',
    onStage: (ctx) =>
      ctx.stage === 'post_tool' ? { mutate: { output: { finding: 42 } } } : undefined,
  });
  assertEquals(settlement.failure?.code, 'invalid_output');
  assertEquals(settlement.failure?.kind, 'bad_response');
  assertEquals(settlement.modelResult?.modelText?.includes('after mutate'), true);
  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool.phase === 'error'),
    true,
  );
});

Deno.test('post_tool deny swaps a completed result for a failure the model sees', async () => {
  registerPostToolProbe('post_deny_probe', { finding: 'ok', secret: 'hunter2' });
  const profile = postToolProfile('post_deny_bot', 'post_deny_probe');
  const { events, settlement } = await runPostToolProbe({
    profile,
    tool: 'post_deny_probe',
    onStage: (ctx) =>
      ctx.stage === 'post_tool'
        ? { deny: { code: 'policy_refused', message: 'result withheld by policy' } }
        : undefined,
  });
  assertEquals(settlement.failure, {
    code: 'policy_refused',
    kind: 'blocked',
    message: 'result withheld by policy',
  });
  assertEquals(settlement.modelResult?.modelText?.includes('hunter2'), false);
  assertEquals(settlement.modelResult?.modelText?.includes('result withheld by policy'), true);
  // One terminal event per call: the deny is the only thing the wire shows.
  const phases = eventsOf(events, 'tool').map((e) => e.tool.phase);
  assertEquals(phases.includes('complete'), false);
  assertEquals(phases.filter((p) => p === 'error').length, 1);
  assertEquals(settlement.outputRaw, undefined);
  assertEquals(settlement.awaiting, undefined);
  // post_tool saw the completed body; the terminal event came after it.
  const order = events.map((e) =>
    e.type === 'stage'
      ? `stage:${e.stage}`
      : `${e.type}:${e.type === 'tool' ? (e.tool.phase ?? '') : ''}`,
  );
  assertEquals(order.indexOf('stage:post_tool') < order.indexOf('tool:error'), true);
});

Deno.test('post_tool mutate on a failed call is a mutate_invalid warning, deny still applies', async () => {
  registerTool({
    type: 'function',
    name: 'post_mutate_failed_probe',
    description: 'throws',
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
  const profile = postToolProfile('post_mutate_failed_bot', 'post_mutate_failed_probe');
  const { events, settlement } = await runPostToolProbe({
    profile,
    tool: 'post_mutate_failed_probe',
    onStage: (ctx) =>
      ctx.stage === 'post_tool'
        ? {
            mutate: { output: { finding: 'nope' } },
            deny: { code: 'replaced', message: 'replaced failure' },
          }
        : undefined,
  });
  const warned = events.find((e) => e.type === 'stage' && e.stageWarnings);
  assertEquals(
    warned?.type === 'stage' ? warned.stageWarnings?.[0]?.code : undefined,
    'mutate_invalid',
  );
  assertEquals(settlement.failure?.code, 'replaced');
  assertEquals(settlement.outputRaw, undefined);
});

Deno.test('post_tool deny of an awaiting result clears awaiting and outputRaw', async () => {
  registerPostToolProbe('post_deny_awaiting_probe', {
    finding: 'ask',
    status: 'awaiting_user_input',
    kind: 'text',
    prompt: 'Which one?',
  });
  registerTool({
    type: 'function',
    name: 'post_deny_awaiting_probe',
    description: 'awaiting probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ status: z.string(), kind: z.string(), prompt: z.string() }),
    handler: () => ({ status: 'awaiting_user_input', kind: 'text', prompt: 'Which one?' }),
  });
  const profile = postToolProfile('post_deny_awaiting_bot', 'post_deny_awaiting_probe');
  let stageSawAwaiting: boolean | undefined;
  const { events, settlement } = await runPostToolProbe({
    profile,
    tool: 'post_deny_awaiting_probe',
    onStage: (ctx) => {
      if (ctx.stage !== 'post_tool') return undefined;
      stageSawAwaiting = (ctx as { awaiting?: boolean }).awaiting;
      return { deny: { code: 'no_questions', message: 'not now' } };
    },
  });
  assertEquals(stageSawAwaiting, true);
  assertEquals(settlement.awaiting, undefined);
  assertEquals(settlement.outputRaw, undefined);
  assertEquals(settlement.failure?.code, 'no_questions');
  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool.phase === 'complete'),
    false,
  );
});

Deno.test('post_tool mutate: one complete event, carrying the mutated output, after the stage', async () => {
  registerPostToolProbe('post_mutate_wire_probe', { finding: 'ok', secret: 'hunter2' });
  const profile = postToolProfile('post_mutate_wire_bot', 'post_mutate_wire_probe');
  const { events } = await runPostToolProbe({
    profile,
    tool: 'post_mutate_wire_probe',
    onStage: (ctx) =>
      ctx.stage === 'post_tool' ? { mutate: { output: { finding: 'ok' } } } : undefined,
  });
  const completes = toolEventsOf(events, 'complete');
  assertEquals(completes.length, 1);
  assertEquals(completes[0]?.output, { finding: 'ok' });
  const order = events.map((e) =>
    e.type === 'stage'
      ? `stage:${e.stage}`
      : `${e.type}:${e.type === 'tool' ? (e.tool.phase ?? '') : ''}`,
  );
  assertEquals(order.indexOf('stage:post_tool') < order.indexOf('tool:complete'), true);
});

Deno.test('post_tool sees the guarded model result and a mutated result is re-guarded', async () => {
  registerPostToolProbe('post_guard_probe', { finding: `${INJ_IGNORE} original` });
  const profile = postToolProfile('post_guard_bot', 'post_guard_probe');
  let atStage: { modelText?: string; provenance?: unknown } | undefined;
  const { settlement } = await runPostToolProbe({
    profile,
    tool: 'post_guard_probe',
    onStage: (ctx) => {
      if (ctx.stage !== 'post_tool') return undefined;
      atStage = (ctx as { outputModel?: { modelText?: string; provenance?: unknown } }).outputModel;
      return { mutate: { output: { finding: `${INJ_IGNORE} replaced` } } };
    },
  });
  assertEquals(typeof atStage?.modelText, 'string');
  assertEquals(Boolean(atStage?.provenance), true);
  assertEquals(typeof settlement.modelResult?.modelText, 'string');
  assertEquals(settlement.modelResult?.modelText?.includes('replaced'), true);
  assertEquals(Boolean(settlement.modelResult?.provenance), true);
});

Deno.test('post_tool mutate on the T2 loader is a warning, not a replacement', async () => {
  registerTool({
    type: 'function',
    name: 'post_mutate_t2_loader',
    description: 'loads tools',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ loaded: z.array(z.string()) }),
    handler: () => ({ loaded: [] }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'post_mutate_t2_bot',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: ['post_mutate_t2_loader'], t2Loader: 'post_mutate_t2_loader' },
      inputs: { text: true },
      guardrails: { quota: { perDay: 10 } },
    }),
  );
  const profile = getProfile('post_mutate_t2_bot');
  if (!profile) throw new Error('missing');
  const snapshot = (await resolveTurn({ profile: profile.id, input: { text: 'x' } })).generation
    .tools;
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile,
    name: 'post_mutate_t2_loader',
    input: {},
    callId: 't2_1',
    ctx: {},
    snapshot,
    stages: {
      handlers: [
        ((ctx: { stage: string }) =>
          ctx.stage === 'post_tool'
            ? { mutate: { output: { loaded: ['never_checked'] } } }
            : undefined) as never,
      ],
      profile,
      step: 1,
      history: () => [],
      injectAllowed: false,
    },
  });
  let settlement: { outputRaw?: unknown } = {};
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
    events.push(next.value);
  }
  assertEquals(settlement.outputRaw, { loaded: [] });
  const warned = events.find((e) => e.type === 'stage' && e.stageWarnings);
  assertEquals(
    warned?.type === 'stage' ? warned.stageWarnings?.[0]?.code : undefined,
    'mutate_invalid',
  );
});

Deno.test('abort during a post_tool handler does not masquerade as handler_error', async () => {
  registerPostToolProbe('post_abort_probe', { finding: 'ok' });
  const profile = postToolProfile('post_abort_bot', 'post_abort_probe');
  const controller = new AbortController();
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile,
    name: 'post_abort_probe',
    input: {},
    callId: 'abort_1',
    ctx: { signal: controller.signal },
    stages: {
      handlers: [
        ((ctx: { stage: string }) => {
          if (ctx.stage === 'post_tool') controller.abort();
          return undefined;
        }) as never,
      ],
      profile,
      step: 1,
      history: () => [],
      injectAllowed: false,
      signal: controller.signal,
    },
  });
  let threw: unknown;
  try {
    while (true) {
      const next = await exec.next();
      if (next.done) break;
      events.push(next.value);
    }
  } catch (err) {
    threw = err;
  }
  assertEquals(Boolean(threw), true);
  assertEquals(
    events.some((e) => e.type === 'tool' && e.tool.phase === 'error'),
    false,
  );
});

Deno.test('pre_tool pipeline: no stages and no preTool emits no pre_tool stage at all', async () => {
  registerPostToolProbe('pre_passthrough_probe', { finding: 'ok' });
  const profile = postToolProfile('pre_passthrough_bot', 'pre_passthrough_probe');
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile,
    name: 'pre_passthrough_probe',
    input: {},
    callId: 'pt_1',
    ctx: {},
  });
  while (true) {
    const next = await exec.next();
    if (next.done) break;
    events.push(next.value);
  }
  assertEquals(
    events.some((e) => e.type === 'stage' && e.stage === 'pre_tool'),
    false,
  );
  assertEquals(
    events.some((e) => e.type === 'stage' && e.stage === 'post_tool'),
    false,
  );
});

Deno.test('pre_tool mutate: replaced input is re-parsed, failing input settles invalid_input', async () => {
  registerTool({
    type: 'function',
    name: 'pre_mutate_probe',
    description: 'echoes',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ n: z.number() }),
    output: z.object({ finding: z.string() }),
    handler: (input: { n: number }) => ({ finding: `n=${input.n}` }),
  });
  const profile = postToolProfile('pre_mutate_bot', 'pre_mutate_probe');
  const run = async (mutate: unknown) => {
    const exec = executeRegisteredTool({
      tools: defaultKernelScope.tools,
      profile,
      name: 'pre_mutate_probe',
      input: { n: 1 },
      callId: 'pm_1',
      ctx: {},
      stages: {
        handlers: [
          ((ctx: { stage: string }) =>
            ctx.stage === 'pre_tool' ? { mutate: { input: mutate } } : undefined) as never,
        ],
        profile,
        step: 1,
        history: () => [],
        injectAllowed: false,
      },
    });
    while (true) {
      const next = await exec.next();
      if (next.done) return next.value;
    }
  };
  const good = await run({ n: 2, __proto__: { polluted: true } });
  assertEquals(good.outputRaw, { finding: 'n=2' });
  const bad = await run({ n: 'two' });
  assertEquals(bad.failure?.code, 'invalid_input');
  assertEquals(bad.failure?.kind, 'bad_response');
  assertEquals(bad.callNotStarted, true);
});

Deno.test('pre_tool: tool-local preTool is skipped on a granted resume but host stages still run', async () => {
  let preToolRan = 0;
  let hostRan = 0;
  registerTool({
    type: 'function',
    name: 'pre_resume_probe',
    description: 'resume probe',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    preTool: () => {
      preToolRan += 1;
      return { confirm: true };
    },
    handler: () => ({ finding: 'ran' }),
  });
  const profile = postToolProfile('pre_resume_bot', 'pre_resume_probe');
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile,
    name: 'pre_resume_probe',
    input: {},
    callId: 'pr_1',
    ctx: { resume: { granted: true } },
    stages: {
      handlers: [
        ((ctx: { stage: string }) => {
          if (ctx.stage === 'pre_tool') hostRan += 1;
          return undefined;
        }) as never,
      ],
      profile,
      step: 1,
      history: () => [],
      injectAllowed: false,
    },
  });
  let settlement: { outputRaw?: unknown } = {};
  while (true) {
    const next = await exec.next();
    if (next.done) {
      settlement = next.value;
      break;
    }
  }
  assertEquals(preToolRan, 0);
  assertEquals(hostRan, 1);
  assertEquals(settlement.outputRaw, { finding: 'ran' });
});

catalogGate();
