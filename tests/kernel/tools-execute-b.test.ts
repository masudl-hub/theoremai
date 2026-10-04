import { z } from 'zod';
import { lexiconText } from '../../src/guardrails/lexicon.ts';
import { DIRECTIVE_RULES } from '../../src/guardrails/rules.ts';
import { TheoremError } from '../../src/guardrails/theorem-error.ts';
import {
  memoryCredentialSource,
  type ToolCredentialSource,
} from '../../src/kernel/auth/credential-source.ts';
import type { ToolCredential } from '../../src/kernel/auth/types.ts';
import { registerTool } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import {
  executeBuiltin,
  executeRegisteredTool,
  type RegisteredToolCall,
  type ToolExecuteSettlement,
} from '../../src/kernel/tools/execute.ts';
import { formatToolFailureForModel } from '../../src/kernel/tools/model-text.ts';
import { CredentialRefusedError } from '../../src/kernel/tools/signed-in-fetch.ts';
import type {
  FunctionToolDef,
  HttpToolDef,
  ToolAuthConfig,
  TurnToolSnapshot,
} from '../../src/kernel/tools/types.ts';
import type { Profile, TurnEvent } from '../../src/kernel/types.ts';
import { startTrace } from '../../src/observability/trace-span.ts';
import { toolEventsOf } from '../fixtures/events.ts';

const RESOLVE = () => Promise.resolve(['93.184.216.34']);
const TOKEN = 'xb-token-sentinel';

const allowed: string[] = [];

function makeProfile(): Profile {
  return {
    id: 'xb-profile',
    type: 'text',
    identity: { handle: 'test-agent' },
    models: {
      'test-model': {
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: 'test-model-id',
        efforts: { normal: 'minimal' },
        maxOutputTokens: 1000,
        temperature: 0.5,
      },
    },
    defaultModel: 'test-model',
    tools: { allow: [...allowed] },
    inputs: { text: true },
    outputs: {},
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function check(actual: unknown, expected: unknown, label: string): void {
  try {
    assertEquals(canonical(actual), canonical(expected));
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

function registerFn(
  name: string,
  over: Partial<FunctionToolDef> = {},
  listed = true,
): FunctionToolDef {
  if (listed) allowed.push(name);
  const def = {
    type: 'function',
    name,
    description: name,
    category: 'test',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
    ...over,
  } as FunctionToolDef;
  registerTool(def);
  return def;
}

function registerHttp(name: string, over: Partial<HttpToolDef> = {}): void {
  allowed.push(name);
  registerTool({
    type: 'http',
    name,
    description: name,
    endpoint: 'https://api.example.com/x',
    method: 'GET',
    category: 'test',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.object({ text: z.string() }),
    ...over,
  } as HttpToolDef);
}

type Drained = { events: TurnEvent[]; settlement: ToolExecuteSettlement };

async function drain(
  name: string,
  over: Partial<Omit<RegisteredToolCall, 'name'>> = {},
): Promise<Drained> {
  const events: TurnEvent[] = [];
  const exec = executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile: makeProfile(),
    name,
    input: {},
    callId: 'call_1',
    ctx: { resolveHost: RESOLVE },
    ...over,
  });
  for (;;) {
    const next = await exec.next();
    if (next.done) return { events, settlement: next.value };
    events.push(next.value);
  }
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  return undefined;
}

function bare(settlement: ToolExecuteSettlement) {
  const { modelResult: _modelResult, ...rest } = settlement;
  return rest;
}

function shapeFailure(settlement: ToolExecuteSettlement) {
  const { failure, ...rest } = bare(settlement);
  return {
    ...rest,
    failure: failure && { code: failure.code, kind: failure.kind, message: failure.message },
  };
}

function stagesWith(...handlers: StageHandler[]) {
  return { handlers, profile: makeProfile(), step: 1, history: () => [], injectAllowed: false };
}

function gateEvents(events: TurnEvent[]) {
  return {
    stage: events.filter((e) => e.type === 'stage' && e.stage === 'pre_tool' && e.gate),
    tool: toolEventsOf(events, 'gate'),
  };
}

async function withFetch<T>(fetchFn: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function answering(status: number, text: string, headers: Record<string, string> = {}) {
  const sent: { url: string; authorization: string | null }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({
      url: input.toString(),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(new Response(text, { status, headers }));
  };
  return { fetchFn, sent };
}

function credentials(slots: Record<string, ToolCredential>): ToolCredentialSource {
  return memoryCredentialSource(slots);
}

const BEARER = { sheets: { type: 'bearer', token: TOKEN } } satisfies Record<
  string,
  ToolCredential
>;
const SHEET_URL = 'https://sheets.example.com/v4/s/1';

function registerSheet(
  name: string,
  auth: Omit<ToolAuthConfig, 'service' | 'slot'> = { type: 'bearer' },
  url = SHEET_URL,
) {
  const seen = { calls: 0, signedInFetch: undefined as unknown };
  registerFn(name, {
    auth: { slot: 'sheets', service: 'Sheets', ...auth },
    output: z.object({ body: z.string() }),
    handler: async (_input, ctx) => {
      seen.calls += 1;
      seen.signedInFetch = ctx.signedInFetch;
      const response = await ctx.signedInFetch?.(url);
      return { body: (await response?.text()) ?? 'no fetch' };
    },
  } as Partial<FunctionToolDef>);
  return seen;
}

Deno.test('a call the host or user refuses settles denied on every path, and a failed re-parse does not', async () => {
  registerFn('xb_denied_resume', { permission: 'always_confirm' });
  const resumed = await drain('xb_denied_resume', { ctx: { resume: { granted: false } } });
  check(
    shapeFailure(resumed.settlement),
    {
      failure: {
        code: 'denied',
        kind: 'declined',
        message: lexiconText('session.tool_denied', { tool: 'xb_denied_resume' }),
      },
      callNotStarted: true,
      denied: true,
    },
    'resume declined',
  );

  registerFn('xb_denied_host');
  const host = await drain('xb_denied_host', {
    stages: stagesWith((ctx) =>
      ctx.stage === 'pre_tool' ? { deny: { code: 'nope', message: 'no way' } } : undefined,
    ),
  });
  check(
    shapeFailure(host.settlement),
    {
      failure: { code: 'nope', kind: 'blocked', message: 'no way' },
      callNotStarted: true,
      denied: true,
    },
    'host pre_tool deny',
  );

  registerHttp('xb_denied_http', {
    preTool: () => ({ deny: { code: 'http_nope', message: 'http no way' } }),
  });
  const http = await drain('xb_denied_http');
  check(
    shapeFailure(http.settlement),
    {
      failure: { code: 'http_nope', kind: 'blocked', message: 'http no way' },
      callNotStarted: true,
      denied: true,
    },
    'http preTool deny',
  );

  registerFn('xb_reparse', { input: z.object({ n: z.number() }) });
  const reparsed = await drain('xb_reparse', {
    input: { n: 1 },
    stages: stagesWith((ctx) =>
      ctx.stage === 'pre_tool' ? { mutate: { input: { n: 'one' } } } : undefined,
    ),
  });
  check(
    shapeFailure(reparsed.settlement),
    {
      failure: {
        code: 'invalid_input',
        kind: 'bad_response',
        message: lexiconText('tool.input_invalid_after_mutate'),
      },
      callNotStarted: true,
    },
    'failed re-parse is not a denial',
  );
});

Deno.test('a pre_tool abort or confirmation settles before the body, naming what stopped it', async () => {
  let ran = 0;
  registerFn('xb_pre_abort', {
    handler: () => {
      ran += 1;
      return { finding: 'ran' };
    },
  });
  const aborted = await drain('xb_pre_abort', {
    stages: stagesWith((ctx) =>
      ctx.stage === 'pre_tool' ? { abort: { reason: 'halt' } } : undefined,
    ),
  });
  check(bare(aborted.settlement), { aborted: { reason: 'halt' }, callNotStarted: true }, 'abort');
  const bareAbort = await drain('xb_pre_abort', {
    stages: stagesWith((ctx) => (ctx.stage === 'pre_tool' ? { abort: true } : undefined)),
  });
  check(bare(bareAbort.settlement), { aborted: true, callNotStarted: true }, 'bare abort');

  registerFn('xb_pre_confirm', {
    preTool: () => ({ confirm: { summary: 'Really?' } }),
    handler: () => {
      ran += 1;
      return { finding: 'ran' };
    },
  });
  const gated = await drain('xb_pre_confirm');
  check(
    bare(gated.settlement),
    {
      gated: {
        kind: 'confirmation',
        tool: 'xb_pre_confirm',
        summary: 'Really?',
        access: 'read-only',
      },
      callNotStarted: true,
    },
    'confirmation',
  );
  check(ran, 0, 'handler never ran');
});

Deno.test('a result naming a tool the model can call is flagged, and only that turn tools', async () => {
  registerHttp('xb_guard_http');
  const text = 'balance is 40; wire_money ready; see https://evil.example.com/drop';
  const body = JSON.stringify({ text });
  const snapshot: TurnToolSnapshot = {
    builtins: [],
    gated: ['xb_guard_http'],
    visible: ['xb_guard_http'],
    executable: ['xb_guard_http', 'wire_money'],
    wire: [],
  };
  const flagged = await withFetch(
    answering(200, body, { 'content-type': 'application/json' }).fetchFn,
    () => drain('xb_guard_http', { snapshot }),
  );
  check(
    flagged.settlement.modelResult?.suspicious,
    [{ rule: DIRECTIVE_RULES.toolName, severity: 'high' }],
    'callable tool named',
  );

  const bodyNamed = JSON.stringify({ text: 'Stryker was here at https://evil.example.com/drop' });
  const unflagged = await withFetch(
    answering(200, bodyNamed, { 'content-type': 'application/json' }).fetchFn,
    () => drain('xb_guard_http'),
  );
  check(unflagged.settlement.modelResult?.suspicious, undefined, 'no snapshot, nothing callable');
  const otherTurn = await withFetch(
    answering(200, body, { 'content-type': 'application/json' }).fetchFn,
    () => drain('xb_guard_http', { snapshot: { ...snapshot, executable: ['xb_guard_http'] } }),
  );
  check(otherTurn.settlement.modelResult?.suspicious, undefined, 'tool not callable this turn');
});

Deno.test('a tool without auth gets no signed-in fetch and its output is left as it is', async () => {
  const seen: { ctx?: unknown } = {};
  registerFn('xb_no_auth', {
    output: z.object({ finding: z.string() }),
    handler: (_input, ctx) => {
      seen.ctx = ctx.signedInFetch;
      return { finding: 'value undefined here' };
    },
  });
  const { settlement } = await drain('xb_no_auth');
  check(seen.ctx, undefined, 'signedInFetch');
  check(bare(settlement), { outputRaw: { finding: 'value undefined here' } }, 'settlement');
});

Deno.test('a function tool that signs in gates with the sign-in note when the slot is empty', async () => {
  const seen = registerSheet('xb_sheet_gate');
  const { events, settlement } = await drain('xb_sheet_gate', {
    ctx: { credentials: credentials({}) },
  });
  const { gated, ...rest } = bare(settlement);
  check(
    rest,
    {
      callNotStarted: true,
      gateReadBack: lexiconText('sign_in.pending', { service: 'Sheets' }),
    },
    'settlement',
  );
  check(gated?.kind, 'auth', 'gate kind');
  check(gated?.kind === 'auth' ? gated.authChallenge.service : undefined, 'Sheets', 'service');
  check(settlement.modelResult, undefined, 'no model result');
  check(seen.calls, 0, 'handler never ran');
  const heard = gateEvents(events);
  check(heard.stage.length, 1, 'one pre_tool gate stage');
  check(heard.tool.length, 1, 'one gate event');
  check(heard.tool[0]?.readBack, lexiconText('sign_in.pending', { service: 'Sheets' }), 'readBack');
});

Deno.test('a function tool that signs in tells the model, without running, when its policy says so', async () => {
  const seen = registerSheet('xb_sheet_report', {
    type: 'bearer',
    onUnauthenticated: 'report_to_model',
  });
  const { settlement } = await drain('xb_sheet_report', { ctx: { credentials: credentials({}) } });
  const message = "Authentication required for 'xb_sheet_report' (auth slot: 'sheets').";
  check(bare(settlement), { outputRaw: { unauthenticated: true, message } }, 'settlement');
  check(settlement.modelResult?.finding, message, 'finding');
  check(seen.calls, 0, 'handler never ran');
});

Deno.test('the handler requests with the credential, never holds it, and an echo of it is omitted', async () => {
  const seen = registerSheet('xb_sheet_ok');
  const { fetchFn, sent } = answering(200, `you sent ${TOKEN}`);
  const { settlement } = await withFetch(fetchFn, () =>
    drain('xb_sheet_ok', { ctx: { credentials: credentials(BEARER), resolveHost: RESOLVE } }),
  );
  check(sent, [{ url: SHEET_URL, authorization: `Bearer ${TOKEN}` }], 'request');
  check(typeof seen.signedInFetch, 'function', 'signedInFetch');
  check(bare(settlement), { outputRaw: { body: 'you sent [omitted - credential]' } }, 'settlement');
  check(JSON.stringify(settlement.modelResult).includes(TOKEN), false, 'model never reads it');
});

Deno.test('a handler failure never carries the credential either', async () => {
  registerFn('xb_sheet_leak', {
    auth: { slot: 'sheets', service: 'Sheets', type: 'bearer' },
    handler: () => {
      throw new Error(`rejected ${TOKEN}`);
    },
  });
  const { settlement } = await drain('xb_sheet_leak', {
    ctx: { credentials: credentials(BEARER) },
  });
  check(
    shapeFailure(settlement),
    {
      failure: {
        code: 'handler_error',
        kind: 'failed',
        message: 'rejected [omitted - credential]',
      },
    },
    'failure',
  );
});

Deno.test('an OAuth token is sent only to the resource it was issued for', async () => {
  const oauth = (resource: string) => ({
    sheets: {
      type: 'oauth2' as const,
      issuer: 'https://auth.example.com',
      resource,
      accessToken: TOKEN,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  registerSheet('xb_sheet_oauth', { type: 'oauth2' }, 'https://elsewhere.example.com/x');
  const mismatch = answering(200, 'ok');
  const refused = await withFetch(mismatch.fetchFn, () =>
    drain('xb_sheet_oauth', {
      ctx: { credentials: credentials(oauth('https://sheets.example.com')), resolveHost: RESOLVE },
    }),
  );
  check(mismatch.sent.length, 0, 'nothing sent');
  check(refused.settlement.failure?.code, 'handler_error', 'refused by the handler path');

  registerSheet('xb_sheet_oauth_ok', { type: 'oauth2' });
  const match = answering(200, 'ok');
  const sent = await withFetch(match.fetchFn, () =>
    drain('xb_sheet_oauth_ok', {
      ctx: { credentials: credentials(oauth('https://sheets.example.com')), resolveHost: RESOLVE },
    }),
  );
  check(match.sent.length, 1, 'sent to its own resource');
  check(bare(sent.settlement), { outputRaw: { body: 'ok' } }, 'settlement');
});

Deno.test('a credential the service refuses gates a new sign-in, and a refusal that asks for none fails', async () => {
  const seen = registerSheet('xb_sheet_refused');
  const { fetchFn } = answering(401, 'refused', {
    'WWW-Authenticate': 'Bearer error="invalid_token"',
  });
  const { events, settlement } = await withFetch(fetchFn, () =>
    drain('xb_sheet_refused', { ctx: { credentials: credentials(BEARER), resolveHost: RESOLVE } }),
  );
  check(seen.calls, 1, 'handler ran once');
  check(settlement.gated?.kind, 'auth', 'gate kind');
  check(settlement.callNotStarted, true, 'callNotStarted');
  check(settlement.failure, undefined, 'not a failure');
  check(gateEvents(events).tool.length, 1, 'one gate event');

  registerFn('xb_sheet_odd_refusal', {
    auth: { slot: 'sheets', service: 'Sheets', type: 'bearer' },
    handler: () => {
      throw new CredentialRefusedError({ status: 403, challenge: null });
    },
  });
  const odd = await drain('xb_sheet_odd_refusal', { ctx: { credentials: credentials(BEARER) } });
  check(
    shapeFailure(odd.settlement),
    {
      failure: {
        code: 'handler_error',
        kind: 'failed',
        message: 'The service refused the credential (HTTP 403).',
      },
    },
    'refusal without a sign-in request',
  );

  registerFn('xb_plain_refusal', {
    handler: () => {
      throw new CredentialRefusedError({ status: 401, challenge: null });
    },
  });
  const plain = await drain('xb_plain_refusal');
  check(
    shapeFailure(plain.settlement),
    {
      failure: {
        code: 'handler_error',
        kind: 'failed',
        message: 'The service refused the credential (HTTP 401).',
      },
    },
    'no sign-in, no refusal handling',
  );
});

Deno.test('only a signed-in tool turns a blocked error into a network block', async () => {
  const blockedHandler = () => {
    throw new TheoremError('blocked', 'nope');
  };
  registerFn('xb_blocked_auth', {
    auth: { slot: 'sheets', service: 'Sheets', type: 'bearer' },
    handler: blockedHandler,
  });
  const signed = await drain('xb_blocked_auth', { ctx: { credentials: credentials(BEARER) } });
  check(
    shapeFailure(signed.settlement),
    { failure: { code: 'network_blocked', kind: 'blocked', message: 'nope' } },
    'signed in and blocked',
  );
  check(
    signed.events.filter((e) => e.type === 'guardrail').map((e) => e.guardrail.stage),
    ['network'],
    'network guardrail reported',
  );

  registerFn('xb_blocked_plain', { handler: blockedHandler });
  const unsigned = await drain('xb_blocked_plain');
  check(
    shapeFailure(unsigned.settlement),
    { failure: { code: 'handler_error', kind: 'failed', message: 'nope' } },
    'not signed in',
  );
  check(unsigned.events.filter((e) => e.type === 'guardrail').length, 0, 'no guardrail event');

  registerFn('xb_boom_auth', {
    auth: { slot: 'sheets', service: 'Sheets', type: 'bearer' },
    handler: () => {
      throw new Error('boom');
    },
  });
  const boom = await drain('xb_boom_auth', { ctx: { credentials: credentials(BEARER) } });
  check(
    shapeFailure(boom.settlement),
    { failure: { code: 'handler_error', kind: 'failed', message: 'boom' } },
    'signed in, not blocked',
  );
  check(
    boom.events.filter((e) => e.type === 'guardrail').length,
    0,
    'no guardrail for a plain error',
  );
});

Deno.test('a signed-in request that ran is timed on the call span', async () => {
  registerSheet('xb_sheet_span');
  const tree = startTrace('root');
  const { fetchFn } = answering(200, 'fine');
  await withFetch(fetchFn, () =>
    drain('xb_sheet_span', {
      ctx: { credentials: credentials(BEARER), resolveHost: RESOLVE },
      stages: stagesWith(),
      openSpan: (name, attributes) => tree.root.child(name, { attributes }),
    }),
  );
  const spans = tree.collect();
  const [, span] = spans;
  const checks = (span?.events ?? []).filter(
    (e) => e.name === 'theorem.guardrail' && e.attributes.check === 'network_request',
  );
  check(
    checks.map((e) => e.attributes.action),
    ['allow'],
    'one allowed network_request check',
  );
});

Deno.test('a handler that returns nothing, or the wrong shape, fails with its own message', async () => {
  registerFn('xb_nothing', { handler: (() => undefined) as never });
  const nothing = await drain('xb_nothing');
  check(
    nothing.settlement.failure,
    {
      code: 'invalid_output',
      kind: 'bad_response',
      message: lexiconText('tool.handler_no_output'),
    },
    'no output',
  );
  check(nothing.settlement.callNotStarted, undefined, 'the body ran');

  registerFn('xb_wrong_shape', { handler: (() => ({ finding: 1 })) as never });
  const wrong = await drain('xb_wrong_shape');
  check(wrong.settlement.failure?.message, lexiconText('tool.output_invalid'), 'wrong shape');
  check(wrong.settlement.failure?.details !== undefined, true, 'with details');
});

Deno.test('an input that fails its schema settles before anything else, naming the call', async () => {
  registerFn('xb_bad_input', { input: z.object({ n: z.number() }) });
  const post: { tool?: string; callId?: string; callNotStarted?: boolean }[] = [];
  const { settlement } = await drain('xb_bad_input', {
    input: { n: 'x' },
    callId: 'call_bad',
    stages: stagesWith((ctx) => {
      if (ctx.stage === 'post_tool') {
        post.push({ tool: ctx.tool, callId: ctx.callId, callNotStarted: ctx.callNotStarted });
      }
      return undefined;
    }),
  });
  check(
    shapeFailure(settlement),
    {
      failure: {
        code: 'invalid_input',
        kind: 'bad_response',
        message: lexiconText('tool.input_invalid'),
      },
      callNotStarted: true,
    },
    'settlement',
  );
  check(
    post,
    [{ tool: 'xb_bad_input', callId: 'call_bad', callNotStarted: true }],
    'post_tool saw it',
  );
});

Deno.test('a tool that needs confirmation gates with the permission, without running', async () => {
  let ran = 0;
  registerFn('xb_confirm_perm', {
    permission: 'always_confirm',
    handler: () => {
      ran += 1;
      return { finding: 'ran' };
    },
  });
  const { events, settlement } = await drain('xb_confirm_perm');
  check(
    bare(settlement),
    {
      gated: {
        kind: 'permission',
        tool: 'xb_confirm_perm',
        permission: 'always_confirm',
        access: 'read-only',
      },
      callNotStarted: true,
    },
    'settlement',
  );
  check(ran, 0, 'handler never ran');
  const heard = gateEvents(events);
  check([heard.stage.length, heard.tool.length], [1, 1], 'gate announced once');
  check(heard.tool[0]?.readBack, undefined, 'no readBack for a permission gate');
});

Deno.test('an abort stops the call before sign-in and before the handler', async () => {
  const early = new AbortController();
  let preTool = 0;
  registerFn('xb_abort_early', {
    input: z.object({}).refine(() => {
      early.abort();
      return true;
    }),
    preTool: () => {
      preTool += 1;
      return undefined;
    },
  });
  const first = await thrown(() => drain('xb_abort_early', { ctx: { signal: early.signal } }));
  check((first as Error)?.name, 'AbortError', 'aborted');
  check(preTool, 0, 'preTool never ran');

  const late = new AbortController();
  let ran = 0;
  registerFn('xb_abort_late', {
    preTool: () => {
      late.abort();
      return undefined;
    },
    handler: () => {
      ran += 1;
      return { finding: 'ran' };
    },
  });
  const second = await thrown(() => drain('xb_abort_late', { ctx: { signal: late.signal } }));
  check((second as Error)?.name, 'AbortError', 'aborted after the pre-body stages');
  check(ran, 0, 'handler never ran');
});

Deno.test('a failed handler tells post_tool the tool, call and input it failed on', async () => {
  registerFn('xb_post_fail', {
    input: z.object({ n: z.number() }),
    handler: () => {
      throw new Error('broke');
    },
  });
  const seen: unknown[] = [];
  const { settlement } = await drain('xb_post_fail', {
    input: { n: 7 },
    callId: 'call_fail',
    stages: stagesWith((ctx) => {
      if (ctx.stage === 'post_tool') {
        seen.push({
          tool: ctx.tool,
          callId: ctx.callId,
          input: ctx.input,
          failure: ctx.failure?.code,
          callNotStarted: ctx.callNotStarted,
        });
      }
      return undefined;
    }),
  });
  check(
    seen,
    [
      {
        tool: 'xb_post_fail',
        callId: 'call_fail',
        input: { n: 7 },
        failure: 'handler_error',
        callNotStarted: undefined,
      },
    ],
    'post_tool context',
  );
  check(settlement.callNotStarted, undefined, 'the body ran');
});

Deno.test('a call to a tool that is not registered or a builtin settles as an early failure', async () => {
  const unknown = await drain('xb_nobody');
  const failure = {
    code: 'unknown_tool',
    kind: 'request',
    message: lexiconText('tool.not_registered', { tool: 'xb_nobody' }),
  };
  check(
    unknown.settlement,
    { failure, callNotStarted: true, modelResult: formatToolFailureForModel(failure) },
    'unknown',
  );
});

Deno.test('a builtin the kernel is asked to run settles with the reason, and an abort still wins', async () => {
  const profile = makeProfile();
  const base = { name: 'googleSearch', callId: 'b1' };
  const snapshot = (builtins: string[]): TurnToolSnapshot => ({
    builtins,
    gated: [],
    visible: [],
    executable: [],
    wire: [],
  });
  const run = async (builtins: string[], signal?: AbortSignal) => {
    const events: TurnEvent[] = [];
    const exec = executeBuiltin(
      { name: 'googleSearch' },
      { profile, callId: 'b1', signal },
      base,
      snapshot(builtins),
    );
    for (;;) {
      const next = await exec.next();
      if (next.done) return { events, settlement: next.value };
      events.push(next.value);
    }
  };
  const off = await run([]);
  const offFailure = {
    code: 'not_loaded',
    kind: 'request',
    message: lexiconText('tool.builtin_not_enabled', { tool: 'googleSearch' }),
  };
  check(
    off.settlement,
    {
      failure: offFailure,
      callNotStarted: true,
      modelResult: formatToolFailureForModel(offFailure),
    },
    'not enabled',
  );
  const on = await run(['googleSearch']);
  const onFailure = {
    code: 'provider_native',
    kind: 'request',
    message: lexiconText('tool.provider_native', { tool: 'googleSearch' }),
  };
  check(
    on.settlement,
    { failure: onFailure, callNotStarted: true, modelResult: formatToolFailureForModel(onFailure) },
    'provider native',
  );
  check(
    toolEventsOf(on.events, 'error').map((e) => e.failure),
    [onFailure],
    'error event',
  );

  const controller = new AbortController();
  controller.abort();
  const error = await thrown(() => run(['googleSearch'], controller.signal));
  check((error as Error)?.name, 'AbortError', 'aborted');
});

Deno.test('a tool is refused when the profile leaves it out or the turn did not gate it', async () => {
  registerFn('xb_unlisted', {}, false);
  const refused = await drain('xb_unlisted');
  check(
    shapeFailure(refused.settlement),
    {
      failure: {
        code: 'not_allowed',
        kind: 'blocked',
        message: lexiconText('tool.not_allowed', { tool: 'xb_unlisted', profile: 'xb-profile' }),
      },
      callNotStarted: true,
    },
    'not allowed',
  );

  registerFn('xb_ungated');
  const snapshot: TurnToolSnapshot = {
    builtins: [],
    gated: [],
    visible: ['xb_ungated'],
    executable: ['xb_ungated'],
    wire: [],
  };
  const ungated = await drain('xb_ungated', { snapshot });
  check(
    shapeFailure(ungated.settlement),
    {
      failure: {
        code: 'not_gated',
        kind: 'request',
        message: lexiconText('tool.not_eligible', { tool: 'xb_ungated' }),
      },
      callNotStarted: true,
    },
    'not gated',
  );
});

Deno.test('a resumed T0 call needs no load, while any other unloaded tool is refused', async () => {
  registerFn('xb_t0_resume', { permission: 'always_confirm' });
  const snapshot = (name: string): TurnToolSnapshot => ({
    builtins: [],
    gated: [name],
    visible: [],
    executable: [],
    wire: [],
  });
  const resumed = await drain('xb_t0_resume', {
    snapshot: snapshot('xb_t0_resume'),
    ctx: { resume: { granted: true } },
  });
  check(bare(resumed.settlement), { outputRaw: { finding: 'ok' } }, 'resumed T0 runs');

  const fresh = await drain('xb_t0_resume', { snapshot: snapshot('xb_t0_resume') });
  check(
    shapeFailure(fresh.settlement),
    {
      failure: {
        code: 'not_loaded',
        kind: 'request',
        message: lexiconText('tool.not_visible', { tool: 'xb_t0_resume' }),
      },
      callNotStarted: true,
    },
    'a fresh unloaded T0 call',
  );

  registerFn('xb_t2_resume', { loadTier: 'T2' });
  const t2 = await drain('xb_t2_resume', {
    snapshot: snapshot('xb_t2_resume'),
    ctx: { resume: { granted: true } },
  });
  check(
    shapeFailure(t2.settlement),
    {
      failure: {
        code: 'not_loaded',
        kind: 'request',
        message: lexiconText('tool.not_loaded_t2', { tool: 'xb_t2_resume' }),
      },
      callNotStarted: true,
    },
    'a resumed T2 call is still unloaded',
  );
});

Deno.test('a remote body settles by its outcome: a result, a failure, an abort or a gate', async () => {
  registerHttp('xb_http_ok');
  const post: unknown[] = [];
  const ok = await withFetch(
    answering(200, '{"text":"hello"}', { 'content-type': 'application/json' }).fetchFn,
    () =>
      drain('xb_http_ok', {
        callId: 'call_http',
        stages: stagesWith((ctx) => {
          if (ctx.stage === 'post_tool') post.push([ctx.tool, ctx.callId, ctx.input]);
          return undefined;
        }),
      }),
  );
  check(bare(ok.settlement), { outputRaw: { text: 'hello' } }, 'ok settlement');
  check(post, [['xb_http_ok', 'call_http', {}]], 'post_tool context');
  const complete = toolEventsOf(ok.events, 'complete');
  check(
    complete.map((e) => [e.name, e.callId, e.output]),
    [['xb_http_ok', 'call_http', { text: 'hello' }]],
    'complete',
  );

  const failed = await withFetch(answering(500, 'down').fetchFn, () => drain('xb_http_ok'));
  check(failed.settlement.failure?.code, 'http_500', 'failure code');
  check(failed.settlement.callNotStarted, undefined, 'the request went out');
  check('outputRaw' in failed.settlement, false, 'no output');

  const aborted = await drain('xb_http_ok', {
    stages: stagesWith((ctx) => (ctx.stage === 'pre_tool' ? { abort: true } : undefined)),
  });
  check(bare(aborted.settlement), { aborted: true, callNotStarted: true }, 'aborted');

  const post2: unknown[] = [];
  registerHttp('xb_http_pre_deny', {
    preTool: () => ({ deny: { code: 'no', message: 'denied' } }),
  });
  await drain('xb_http_pre_deny', {
    callId: 'call_deny',
    stages: stagesWith((ctx) => {
      if (ctx.stage === 'post_tool')
        post2.push([ctx.tool, ctx.callId, ctx.input, ctx.callNotStarted]);
      return undefined;
    }),
  });
  check(post2, [['xb_http_pre_deny', 'call_deny', {}, true]], 'post_tool saw the denial');

  registerHttp('xb_http_perm', { permission: 'always_confirm' });
  const perm = await drain('xb_http_perm');
  check(
    bare(perm.settlement),
    {
      gated: {
        kind: 'permission',
        tool: 'xb_http_perm',
        permission: 'always_confirm',
        access: 'read-only',
      },
      callNotStarted: true,
    },
    'permission gate',
  );
  const permEvents = gateEvents(perm.events);
  check(
    [permEvents.stage.length, permEvents.tool.length],
    [1, 1],
    'permission gate announced once',
  );

  registerHttp('xb_http_confirm', { preTool: () => ({ confirm: { summary: 'Sure?' } }) });
  const confirm = await drain('xb_http_confirm');
  check(
    bare(confirm.settlement),
    {
      gated: {
        kind: 'confirmation',
        tool: 'xb_http_confirm',
        summary: 'Sure?',
        access: 'read-only',
      },
      callNotStarted: true,
    },
    'confirmation gate',
  );
  const confirmEvents = gateEvents(confirm.events);
  check(
    [confirmEvents.stage.length, confirmEvents.tool.length],
    [1, 1],
    'confirmation announced once',
  );
});

Deno.test('a remote tool that signs in gates with the sign-in note', async () => {
  registerHttp('xb_http_auth', { auth: { slot: 'sheets', service: 'Sheets', type: 'bearer' } });
  const { events, settlement } = await drain('xb_http_auth', {
    ctx: { credentials: credentials({}) },
  });
  check(settlement.gated?.kind, 'auth', 'gate');
  check(settlement.callNotStarted, true, 'callNotStarted');
  check(
    settlement.gateReadBack,
    lexiconText('sign_in.pending', { service: 'Sheets' }),
    'gateReadBack',
  );
  const heard = gateEvents(events);
  check([heard.stage.length, heard.tool.length], [1, 1], 'announced once');
});

Deno.test('a signed-in request is timed on the call span even when the call then fails on it', async () => {
  const networkChecks = (tree: ReturnType<typeof startTrace>) =>
    (tree.collect()[1]?.events ?? [])
      .filter((e) => e.name === 'theorem.guardrail' && e.attributes.check === 'network_request')
      .map((e) => e.attributes.action);

  registerSheet('xb_sheet_span_refused');
  const refusedTree = startTrace('root');
  const refused = answering(401, 'refused', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  await withFetch(refused.fetchFn, () =>
    drain('xb_sheet_span_refused', {
      ctx: { credentials: credentials(BEARER), resolveHost: RESOLVE },
      stages: stagesWith(),
      openSpan: (name, attributes) => refusedTree.root.child(name, { attributes }),
    }),
  );
  check(networkChecks(refusedTree), ['allow'], 'refused credential');

  registerSheet('xb_sheet_span_blocked');
  const blockedTree = startTrace('root');
  const blocked = answering(200, 'never sent');
  await withFetch(blocked.fetchFn, () =>
    drain('xb_sheet_span_blocked', {
      ctx: { credentials: credentials(BEARER), resolveHost: () => Promise.resolve(['10.0.0.1']) },
      stages: stagesWith(),
      openSpan: (name, attributes) => blockedTree.root.child(name, { attributes }),
    }),
  );
  check(blocked.sent.length, 0, 'blocked request not sent');
  check(networkChecks(blockedTree), ['block'], 'blocked request');
});
