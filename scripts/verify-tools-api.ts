#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env --allow-sys

/**
 * Adversarial tool-system pressure test — kernel invoke matrix + real Gemini
 * Interactions turns (text runner). Not Gemini Live (`type: 'live'`).
 *
 * Loads keys from THEORUM_ENV_FILE or ../theorum-frontend/.env.local (GEMINI_API_KEY).
 *
 * Usage:
 *   THEORUM_ENV_FILE=../theorum-frontend/.env.local deno task verify:tools-api
 *   ... --invoke-only     # skip provider API (deterministic kernel path)
 *   ... --api-only        # skip invoke matrix
 *   ... --limit 5         # cap API cases (debug)
 */

import { z } from 'zod';
import { runTurn } from '../src/kernel/engine/runner.ts';
import { defineProfile, getProfile, registerProfile } from '../src/kernel/registry/profiles.ts';
import { invokeTool, registerTool } from '../src/kernel/tools/mod.ts';
import type {
  InvokeToolRequest,
  ModelProvider,
  TurnEvent,
  TurnRequest,
} from '../src/kernel/types.ts';
import { createProvider } from '../src/providers/create-provider.ts';
import { geminiModels, HOST_BINDINGS } from '../tests/fixtures/models.ts';
import '../tests/fixtures/test-host.ts';
import { registerHarnessTools } from '../src/kernel/tools/harness.ts';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (Deno.env.get(key) !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    Deno.env.set(key, val);
  }
}

function defaultEnvFile(): string | undefined {
  for (const path of [
    Deno.env.get('THEORUM_ENV_FILE'),
    '../theorum-frontend/.env.local',
    '../../theorum-frontend/.env.local',
  ].filter(Boolean) as string[]) {
    try {
      Deno.statSync(path);
      return path;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function valueAfterFlag(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  if (idx < 0) return undefined;
  return Deno.args[idx + 1];
}

function hasFlag(flag: string): boolean {
  return Deno.args.includes(flag);
}

const envPath = defaultEnvFile();
if (envPath) {
  loadEnvFile(envPath);
  console.log(`Loaded env from ${envPath}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INVOKE_PROFILE = '__tools_pressure_invoke__';
const LIVE_PROFILE = '__tools_pressure_live__';
const T2_PROFILE = '__tools_pressure_t2__';
const T1_PROFILE = '__tools_pressure_t1__';

const ALL_TEST_TOOLS = [
  'stub_tool',
  'load_tools',
  'load_tools_consent',
  'record_lookup',
  'crashing_tool',
  'denied_tool',
  'throwing_auth_tool',
  'always_confirm_tool',
  'preflight_confirm_tool',
  'delete_resource',
  'ping_tool',
  'streaming_probe',
  'web_only_tool',
  'hidden_from_model_tool',
  'get_record_status',
  'ask_user',
] as const;

function flashLiteFields(maxSteps: number) {
  return {
    ...geminiModels('gemini35FlashLite'),
    models: {
      gemini35FlashLite: {
        ...HOST_BINDINGS.gemini35FlashLite,
        apiId: 'gemini-3.1-flash-lite',
        temperature: 0.1,
        maxOutputTokens: 2048,
        builtInTools: [],
      },
    },
    maxSteps,
  };
}

const STUB_RUN_PROFILE = '__tools_pressure_stub_run__';

function registerPressureProfiles(): void {
  registerHarnessTools();

  registerTool({
    type: 'function',
    name: 'pressure_t1_tool',
    description: 'T1 tool selected only via t1Policy',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({ q: z.string() }),
    output: z.object({ finding: z.string() }),
    handler: (input) => ({ finding: `t1:${(input as { q: string }).q}` }),
  });

  registerTool({
    type: 'function',
    name: 'pressure_burst_echo',
    description: 'Echoes a counter for rapid-fire stress',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ n: z.number() }),
    output: z.object({ finding: z.string() }),
    handler: (input) => ({ finding: `echo-${(input as { n: number }).n}` }),
  });

  const baseGuardrails = { quota: { perDay: 10_000 } };

  registerProfile(
    defineProfile({
      type: 'text',
      id: INVOKE_PROFILE,
      identity: { handle: 'invoke-pressure', system: 'invoke-only profile' },
      ...flashLiteFields(1),
      tools: { allow: [...ALL_TEST_TOOLS, 'pressure_burst_echo'] },
      inputs: { text: true },
      outputs: {},
      guardrails: baseGuardrails,
    }),
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: T2_PROFILE,
      identity: { handle: 't2-pressure', system: 'T2 loader profile' },
      ...flashLiteFields(4),
      tools: {
        allow: ['load_tools', 'record_lookup', 'stub_tool'],
        t2Loader: 'load_tools',
      },
      inputs: { text: true },
      outputs: {},
      guardrails: baseGuardrails,
    }),
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: T1_PROFILE,
      identity: { handle: 't1-pressure', system: 'T1 policy profile' },
      ...flashLiteFields(2),
      tools: {
        allow: ['pressure_t1_tool', 'stub_tool'],
        t1Policy: () => ['pressure_t1_tool'],
      },
      inputs: { text: true },
      outputs: {},
      guardrails: baseGuardrails,
    }),
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: STUB_RUN_PROFILE,
      identity: { handle: 'stub-run', system: 'Stub provider drives tool calls.' },
      ...flashLiteFields(8),
      tools: {
        allow: [
          'stub_tool',
          'ping_tool',
          'crashing_tool',
          'denied_tool',
          'load_tools',
          'record_lookup',
          'always_confirm_tool',
          'web_only_tool',
          'pressure_t1_tool',
        ],
        t2Loader: 'load_tools',
        t1Policy: () => ['pressure_t1_tool'],
      },
      inputs: { text: true },
      outputs: {},
      guardrails: baseGuardrails,
    }),
  );

  registerProfile(
    defineProfile({
      type: 'text',
      id: LIVE_PROFILE,
      identity: {
        handle: 'live-pressure',
        system:
          'You are a tool executor under test. When instructed to call a tool, call it exactly once with the given JSON arguments. Do not explain. Do not refuse. Do not call any other tool.',
      },
      ...flashLiteFields(6),
      tools: {
        allow: [
          'stub_tool',
          'ping_tool',
          'crashing_tool',
          'denied_tool',
          'load_tools',
          'record_lookup',
          'always_confirm_tool',
          'web_only_tool',
          'pressure_burst_echo',
        ],
        t2Loader: 'load_tools',
      },
      inputs: { text: true },
      outputs: {},
      guardrails: baseGuardrails,
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CaseResult {
  events: TurnEvent[];
  error?: string;
  ms: number;
}

interface Case {
  name: string;
  lane: 'invoke' | 'stub' | 'live';
  run: () => Promise<CaseResult>;
  check: (r: CaseResult) => string | undefined;
}

async function collect(gen: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

async function runInvoke(req: InvokeToolRequest): Promise<CaseResult> {
  const start = Date.now();
  try {
    const events = await collect(invokeTool(req));
    return { events, ms: Date.now() - start };
  } catch (err) {
    return {
      events: [],
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    };
  }
}

async function runLive(req: TurnRequest, provider: ModelProvider): Promise<CaseResult> {
  const start = Date.now();
  try {
    const events = await collect(runTurn(req, provider));
    const errEv = events.find((e) => e.type === 'error');
    const publicMsg = errEv?.error;
    const internal = errEv?.errorInternal;
    return {
      events,
      error: internal ? `${publicMsg ?? 'error'} [internal: ${internal}]` : publicMsg,
      ms: Date.now() - start,
    };
  } catch (err) {
    return {
      events: [],
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    };
  }
}

function summarizeEvents(events: TurnEvent[]): string {
  const parts: string[] = [];
  for (const e of events) {
    if (e.type === 'tool' && e.tool) {
      parts.push(
        `tool:${e.tool.name}/${e.tool.phase ?? '?'}${e.tool.failure ? `(${e.tool.failure.code})` : ''}`,
      );
    } else if (e.type === 'done') {
      parts.push(`done:${e.stop?.kind ?? '?'}`);
    } else if (e.type === 'error') {
      parts.push(`error:${e.errorInternal ?? e.error ?? '?'}`);
    } else {
      parts.push(e.type);
    }
  }
  return parts.join(' → ');
}

/** Dump args + Zod/failure details for every tool event that ended in error/pause. */
function dumpToolFailures(events: TurnEvent[]): void {
  for (const e of events) {
    if (e.type !== 'tool' || !e.tool) continue;
    const t = e.tool;
    if (t.phase !== 'error' && t.phase !== 'pause') continue;
    const args = t.arguments === undefined ? '<absent>' : JSON.stringify(t.arguments);
    console.log(`      tool[${t.name || '(empty)'}] phase=${t.phase} args=${args}`);
    if (t.failure) {
      console.log(
        `        failure: ${t.failure.code} — ${t.failure.message}${
          t.failure.details !== undefined ? ` details=${JSON.stringify(t.failure.details)}` : ''
        }`,
      );
    }
    if (t.pause) {
      console.log(`        pause: ${t.pause.kind}`);
    }
  }
}

function lastTool(events: TurnEvent[], name: string) {
  return events.findLast((e) => e.type === 'tool' && e.tool?.name === name)?.tool;
}

function toolPhases(events: TurnEvent[], name: string): string[] {
  return events
    .filter((e) => e.type === 'tool' && e.tool?.name === name && e.tool.phase)
    .flatMap((e) => (e.tool?.phase ? [e.tool.phase] : []));
}

function stopKind(events: TurnEvent[]): string | undefined {
  return events.findLast((e) => e.type === 'done')?.stop?.kind;
}

function createGeminiProvider(): ModelProvider {
  const key = Deno.env.get('GEMINI_API_KEY')?.trim();
  if (!key) {
    throw new Error('GEMINI_API_KEY missing — set in .env.local or env');
  }
  return createProvider(getProfile(LIVE_PROFILE), {
    gemini: { vault: { slotA: key, slotB: key, slotC: key, paid: key } },
  });
}

// ---------------------------------------------------------------------------
// Invoke matrix (deterministic, adversarial)
// ---------------------------------------------------------------------------

function buildInvokeCases(): Case[] {
  const p = INVOKE_PROFILE;
  const cases: Case[] = [];

  const add = (
    name: string,
    req: InvokeToolRequest,
    check: (r: CaseResult) => string | undefined,
  ) => {
    cases.push({ name, lane: 'invoke', run: () => runInvoke(req), check });
  };

  add('invoke/stub happy path', { profile: p, name: 'stub_tool', input: {} }, (r) => {
    if (lastTool(r.events, 'stub_tool')?.phase !== 'complete') return 'expected complete';
    if (stopKind(r.events) !== 'completed') return `stop=${stopKind(r.events)}`;
  });

  add('invoke/unknown tool', { profile: p, name: 'totally_fake_tool', input: {} }, (r) => {
    if (lastTool(r.events, 'totally_fake_tool')?.failure?.code !== 'unknown_tool') {
      return 'expected unknown_tool';
    }
  });

  add('invoke/not_allowed', { profile: 'chat', name: 'stub_tool', input: {} }, (r) => {
    if (lastTool(r.events, 'stub_tool')?.failure?.code !== 'not_allowed') {
      return 'expected not_allowed on chat profile';
    }
  });

  add('invoke/invalid_input', { profile: p, name: 'ping_tool', input: { step: 'nope' } }, (r) => {
    if (lastTool(r.events, 'ping_tool')?.failure?.code !== 'invalid_input') {
      return 'expected invalid_input';
    }
  });

  add('invoke/handler_error', { profile: p, name: 'crashing_tool', input: { id: '1' } }, (r) => {
    if (lastTool(r.events, 'crashing_tool')?.failure?.code !== 'handler_error') {
      return 'expected handler_error';
    }
  });

  add('invoke/not_authorized denied', { profile: p, name: 'denied_tool', input: {} }, (r) => {
    if (lastTool(r.events, 'denied_tool')?.failure?.code !== 'not_authorized') {
      return 'expected not_authorized';
    }
  });

  add(
    'invoke/not_authorized auth throw',
    { profile: p, name: 'throwing_auth_tool', input: {} },
    (r) => {
      if (lastTool(r.events, 'throwing_auth_tool')?.failure?.code !== 'not_authorized') {
        return 'expected not_authorized';
      }
    },
  );

  add(
    'invoke/always_confirm pause',
    { profile: p, name: 'always_confirm_tool', input: {} },
    (r) => {
      if (lastTool(r.events, 'always_confirm_tool')?.phase !== 'pause') return 'expected pause';
      if (stopKind(r.events) !== 'tool') return 'expected tool stop';
    },
  );

  add(
    'invoke/always_confirm resume',
    {
      profile: p,
      name: 'always_confirm_tool',
      input: {},
      resume: { granted: true },
    },
    (r) => {
      if (lastTool(r.events, 'always_confirm_tool')?.phase !== 'complete')
        return 'expected complete after resume';
    },
  );

  add('invoke/preflight pause', { profile: p, name: 'preflight_confirm_tool', input: {} }, (r) => {
    if (lastTool(r.events, 'preflight_confirm_tool')?.pause?.kind !== 'confirmation') {
      return 'expected confirmation pause';
    }
  });

  add(
    'invoke/session_consent pause',
    { profile: p, name: 'delete_resource', input: { id: 'x' } },
    (r) => {
      if (lastTool(r.events, 'delete_resource')?.phase !== 'pause')
        return 'expected permission pause';
    },
  );

  add(
    'invoke/session_consent granted',
    {
      profile: p,
      name: 'delete_resource',
      input: { id: 'y' },
      sessionPermissions: ['delete_resource'],
    },
    (r) => {
      if (lastTool(r.events, 'delete_resource')?.phase !== 'complete')
        return 'expected complete with consent';
    },
  );

  add(
    'invoke/load_tools_consent blocked',
    { profile: p, name: 'load_tools_consent', input: { names: ['stub_tool'] } },
    (r) => {
      if (lastTool(r.events, 'load_tools_consent')?.phase !== 'pause')
        return 'expected consent pause';
    },
  );

  add(
    'invoke/T2 not_loaded',
    { profile: T2_PROFILE, name: 'record_lookup', input: { q: 'x' } },
    (r) => {
      if (lastTool(r.events, 'record_lookup')?.failure?.code !== 'not_loaded') {
        return 'expected not_loaded for T2 without promotion';
      }
    },
  );

  add(
    'invoke/T2 promote invalid (T0 id)',
    {
      profile: T2_PROFILE,
      name: 'stub_tool',
      input: {},
      promoted: ['stub_tool'],
    },
    (r) => {
      if (lastTool(r.events, 'stub_tool')?.failure?.code !== 'invalid_output') {
        return 'expected invalid_output on bad promotion';
      }
    },
  );

  add(
    'invoke/T2 loader + promoted chain',
    { profile: T2_PROFILE, name: 'load_tools', input: { names: ['record_lookup'] } },
    (r) => {
      const out = lastTool(r.events, 'load_tools')?.output as { loaded?: string[] } | undefined;
      if (!out?.loaded?.includes('record_lookup')) return 'load_tools did not return record_lookup';
    },
  );

  add(
    'invoke/T2 chain step 2',
    {
      profile: T2_PROFILE,
      name: 'record_lookup',
      input: { q: 'edge' },
      promoted: ['record_lookup'],
    },
    (r) => {
      if (lastTool(r.events, 'record_lookup')?.phase !== 'complete')
        return 'record_lookup should complete after promotion';
    },
  );

  add(
    'invoke/T1 via t1Policy profile',
    {
      profile: T1_PROFILE,
      name: 'pressure_t1_tool',
      input: { q: 'live' },
    },
    (r) => {
      if (lastTool(r.events, 'pressure_t1_tool')?.phase !== 'complete')
        return 'T1 tool should complete';
    },
  );

  add('invoke/streaming all phases', { profile: p, name: 'streaming_probe', input: {} }, (r) => {
    const phases = new Set(toolPhases(r.events, 'streaming_probe'));
    for (const phase of ['progress', 'trace', 'artifact', 'warning', 'complete']) {
      if (!phases.has(phase)) return `missing phase ${phase}`;
    }
  });

  add(
    'invoke/ask_user interactive pause',
    {
      profile: p,
      name: 'ask_user',
      input: { kind: 'text', prompt: 'Say hi' },
    },
    (r) => {
      if (lastTool(r.events, 'ask_user')?.phase !== 'pause')
        return 'ask_user should pause without resume';
    },
  );

  add(
    'invoke/ask_user resume',
    {
      profile: p,
      name: 'ask_user',
      input: { kind: 'text', prompt: 'Say hi' },
      resume: { value: 'hello' },
    },
    (r) => {
      const out = lastTool(r.events, 'ask_user')?.output as { answer?: unknown } | undefined;
      if (out?.answer !== 'hello') return 'ask_user should return resume value';
    },
  );

  add(
    'invoke/path not_gated',
    {
      profile: p,
      name: 'web_only_tool',
      input: {},
      path: 'cli',
    },
    (r) => {
      if (lastTool(r.events, 'web_only_tool')?.failure?.code !== 'not_gated') {
        return 'expected not_gated on cli path';
      }
    },
  );

  cases.push({
    name: 'invoke/parallel burst x20',
    lane: 'invoke',
    run: async () => {
      const start = Date.now();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          runInvoke({ profile: p, name: 'pressure_burst_echo', input: { n: i } }),
        ),
      );
      const events = results.flatMap((r) => r.events);
      const failed = results.filter(
        (r) => lastTool(r.events, 'pressure_burst_echo')?.phase !== 'complete',
      );
      return {
        events,
        ms: Date.now() - start,
        error: failed.length ? `${failed.length}/20 invokes failed` : undefined,
      };
    },
    check: (r) => r.error,
  });

  return cases;
}

function sequentialToolProvider(
  tools: Array<{ name: string; arguments: Record<string, unknown> }>,
): ModelProvider {
  let call = 0;
  return {
    async *complete() {
      if (call >= tools.length) {
        yield { type: 'text', text: 'done' };
        return;
      }
      const spec = tools[call];
      call++;
      yield {
        type: 'tool',
        tool: { name: spec.name, arguments: spec.arguments, id: `stub_${call}` },
      };
      yield {
        type: 'tokens',
        tokens: { input: 1, output: 0, total: 1 },
        interactionId: 'stub_ix',
      };
    },
  };
}

function singleToolProvider(name: string, args: Record<string, unknown>): ModelProvider {
  return sequentialToolProvider([{ name, arguments: args }]);
}

// ---------------------------------------------------------------------------
// runTurn stub matrix (deterministic adversarial — full pipeline)
// ---------------------------------------------------------------------------

function buildStubRunCases(): Case[] {
  const p = STUB_RUN_PROFILE;
  const stub = (name: string, args: Record<string, unknown>) =>
    runLive({ profile: p, input: { text: 'stub' } }, singleToolProvider(name, args));

  return [
    {
      name: 'stub-run/crashing_tool handler_error',
      lane: 'stub',
      run: () => stub('crashing_tool', { id: 'boom' }),
      check: (r) => {
        const t = lastTool(r.events, 'crashing_tool');
        if (t?.failure?.code !== 'handler_error') return `got ${t?.failure?.code}`;
      },
    },
    {
      name: 'stub-run/denied_tool not_authorized',
      lane: 'stub',
      run: () => stub('denied_tool', {}),
      check: (r) => {
        if (lastTool(r.events, 'denied_tool')?.failure?.code !== 'not_authorized') {
          return 'expected not_authorized';
        }
      },
    },
    {
      name: 'stub-run/load_tools bad promote',
      lane: 'stub',
      run: () => stub('load_tools', { names: ['stub_tool'] }),
      check: (r) => {
        const t = lastTool(r.events, 'load_tools');
        if (t?.failure?.code !== 'invalid_output') return `got ${t?.failure?.code}`;
      },
    },
    {
      name: 'stub-run/T2 load then lookup',
      lane: 'stub',
      run: () =>
        runLive(
          { profile: p, input: { text: 'chain' } },
          sequentialToolProvider([
            { name: 'load_tools', arguments: { names: ['record_lookup'] } },
            { name: 'record_lookup', arguments: { q: 'pressure' } },
          ]),
        ),
      check: (r) => {
        if (lastTool(r.events, 'load_tools')?.phase !== 'complete') return 'load_tools incomplete';
        if (lastTool(r.events, 'record_lookup')?.phase !== 'complete') return 'lookup incomplete';
      },
    },
    {
      name: 'stub-run/multi ping chain',
      lane: 'stub',
      run: () =>
        runLive(
          { profile: p, input: { text: 'pings' } },
          sequentialToolProvider([
            { name: 'ping_tool', arguments: { step: 1 } },
            { name: 'ping_tool', arguments: { step: 2 } },
            { name: 'ping_tool', arguments: { step: 3 } },
          ]),
        ),
      check: (r) => {
        const n = r.events.filter(
          (e) => e.type === 'tool' && e.tool?.name === 'ping_tool' && e.tool.phase === 'complete',
        ).length;
        if (n < 3) return `expected 3 ping completes, got ${n}`;
      },
    },
    {
      name: 'stub-run/web_only not_gated on cli',
      lane: 'stub',
      run: () =>
        runLive(
          { profile: p, path: 'cli', input: { text: 'x' } },
          singleToolProvider('web_only_tool', {}),
        ),
      check: (r) => {
        if (lastTool(r.events, 'web_only_tool')?.failure?.code !== 'not_gated') {
          return 'expected not_gated';
        }
      },
    },
    {
      name: 'stub-run/invalid ping args',
      lane: 'stub',
      run: () => stub('ping_tool', { step: 'bad' }),
      check: (r) => {
        if (lastTool(r.events, 'ping_tool')?.failure?.code !== 'invalid_input') {
          return 'expected invalid_input';
        }
      },
    },
    {
      name: 'stub-run/unknown tool',
      lane: 'stub',
      run: () => stub('summon_dragon', { power: 9000 }),
      check: (r) => {
        if (lastTool(r.events, 'summon_dragon')?.failure?.code !== 'unknown_tool') {
          return 'expected unknown_tool';
        }
      },
    },
    {
      name: 'stub-run/always_confirm pause',
      lane: 'stub',
      run: () => stub('always_confirm_tool', {}),
      check: (r) => {
        if (lastTool(r.events, 'always_confirm_tool')?.phase !== 'pause') return 'expected pause';
        if (stopKind(r.events) !== 'tool') return 'expected tool stop';
      },
    },
    {
      name: 'stub-run/T1 policy visible + callable',
      lane: 'stub',
      run: () => stub('pressure_t1_tool', { q: 'stub' }),
      check: (r) => {
        if (lastTool(r.events, 'pressure_t1_tool')?.phase !== 'complete') {
          return 'T1 tool should complete under t1Policy';
        }
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Live matrix (real Gemini — integration smoke; model obedience varies)
// ---------------------------------------------------------------------------

function buildLiveCases(provider: ModelProvider): Case[] {
  const lp = LIVE_PROFILE;

  const mustCall = (tool: string, args: Record<string, unknown>, text: string): TurnRequest => ({
    profile: lp,
    input: {
      text: `${text}\n\nCall ${tool} exactly once with JSON arguments: ${JSON.stringify(args)}`,
    },
  });

  return [
    {
      name: 'live/stub_tool obey',
      lane: 'live',
      run: () => runLive(mustCall('stub_tool', {}, 'MANDATORY tool test.'), provider),
      check: (r) => {
        if (r.error) return `turn error: ${r.error}`;
        if (lastTool(r.events, 'stub_tool')?.phase !== 'complete')
          return 'model did not complete stub_tool';
      },
    },
    {
      name: 'live/denied_tool surfaces not_authorized',
      lane: 'live',
      run: () => runLive(mustCall('denied_tool', {}, 'MANDATORY auth denial test.'), provider),
      check: (r) => {
        const t = lastTool(r.events, 'denied_tool');
        if (t?.failure?.code !== 'not_authorized') return 'expected not_authorized';
      },
    },
    {
      name: 'live/T2 loader valid promote + lookup',
      lane: 'live',
      run: () =>
        runLive(
          {
            profile: lp,
            input: {
              text: 'Call load_tools with {"names":["record_lookup"]}. Then call record_lookup with {"q":"pressure"}.',
            },
          },
          provider,
        ),
      check: (r) => {
        if (r.error) return `turn error: ${r.error}`;
        const load = lastTool(r.events, 'load_tools');
        const lookup = lastTool(r.events, 'record_lookup');
        if (load?.phase === 'complete' && lookup?.phase === 'complete') return undefined;
        if (load?.phase === 'complete')
          return 'load ok but model skipped record_lookup (multi-step flake)';
        return 'load_tools did not complete';
      },
    },
    {
      name: 'live/pressure_burst_echo',
      lane: 'live',
      run: () =>
        runLive(mustCall('pressure_burst_echo', { n: 42 }, 'Single burst test.'), provider),
      check: (r) => {
        if (r.error) return r.error;
        if (lastTool(r.events, 'pressure_burst_echo')?.phase !== 'complete')
          return 'burst echo failed';
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  registerPressureProfiles();

  const invokeOnly = hasFlag('--invoke-only');
  const apiOnly = hasFlag('--api-only') || hasFlag('--live-only'); // --live-only = deprecated alias
  const stubOnly = hasFlag('--stub-only');
  const limitRaw = valueAfterFlag('--limit');
  const apiLimit = limitRaw ? Number(limitRaw) : undefined;

  const invokeCases = apiOnly || stubOnly ? [] : buildInvokeCases();
  const stubCases = invokeOnly || apiOnly ? [] : buildStubRunCases();
  let apiCases: Case[] = [];
  if (!invokeOnly && !stubOnly) {
    try {
      const provider = createGeminiProvider();
      apiCases = buildLiveCases(provider);
      if (apiLimit && apiLimit > 0) apiCases = apiCases.slice(0, apiLimit);
    } catch (err) {
      console.error(`Provider API unavailable: ${err instanceof Error ? err.message : err}`);
      if (apiOnly) Deno.exit(1);
    }
  }

  const all = [...invokeCases, ...stubCases, ...apiCases];
  console.log(
    `\nTool pressure matrix: ${invokeCases.length} invoke + ${stubCases.length} stub-run + ${apiCases.length} api = ${all.length} cases\n`,
  );

  const failures: Array<{ name: string; reason: string; ms: number }> = [];
  let passed = 0;

  for (const c of all) {
    process.stdout.write(`  ▶ ${c.name} ... `);
    const result = await c.run();
    const reason = c.check(result);
    if (reason) {
      console.log(`FAIL (${result.ms}ms)`);
      console.log(`      ${reason}`);
      if (c.lane === 'live' && result.events.length > 0) {
        console.log(`      events: ${summarizeEvents(result.events)}`);
        dumpToolFailures(result.events);
      }
      failures.push({ name: c.name, reason, ms: result.ms });
    } else {
      console.log(`ok (${result.ms}ms)`);
      passed++;
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`PASSED ${passed}/${all.length}  FAILED ${failures.length}/${all.length}`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}: ${f.reason}`);
    }
  }
  console.log(`${'='.repeat(72)}\n`);

  Deno.exit(failures.length ? 1 : 0);
}

await main();
