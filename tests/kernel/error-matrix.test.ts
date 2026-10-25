import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import {
  bearer,
  createKernelScope,
  createMemoryToolExecution,
  defineProvider,
  type InvokeToolRequest,
  invokeTool,
  openAi,
  runDecision,
  type ToolExecutionCoordinator,
  z,
} from '../../mod.ts';
import { describeError, errorKind, TheoremError } from '../../src/guardrails/error.ts';
import type { ErrorKind } from '../../src/guardrails/theorem-error.ts';
import { forClient } from '../../src/host/client-turn.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnStopKind } from '../../src/kernel/schema.ts';
import type { ModelEvent, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { finalStop } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { FIXTURE_VAULT } from '../fixtures/registered-runner.ts';
import { catalogedSink } from '../fixtures/trace-catalog.ts';

/** What every reader of one injected failure got. */
interface Observed {
  events: TurnEvent[];
  traces: TraceRecord[];
  /** What the turn threw, when it threw instead of ending. */
  thrown?: unknown;
}

/** What the honest-errors rules say this failure must look like (docs/proposals/honest-errors.md). */
interface Expected {
  /** Text from the injected failure and each cause the builder must read (R1.1). */
  reasons: string[];
  kind?: ErrorKind;
  stop?: TurnStopKind;
  /** Text that must reach no label, no visitor copy and no trace (S1). */
  secrets?: string[];
  /**
   * The host's own detector failed, so the trace's host scrub fails closed over the reason. The
   * trace holds this summary in the kernel's words instead, with the builder's error id (O9).
   */
  traceSummary?: string;
}

const SECRET = String(FIXTURE_VAULT.slot_a);

function builderText(observed: Observed): string {
  const events = observed.events.map((event) => forClient(event, { reader: 'builder' }));
  const thrown = observed.thrown === undefined ? [] : [describeError(observed.thrown)];
  return JSON.stringify([...events, ...thrown]);
}

function visitorText(observed: Observed): string {
  return JSON.stringify(observed.events.map((event) => forClient(event)));
}

/** Every label the failure reached the user with. */
function labels(observed: Observed): string[] {
  return observed.events.flatMap((event) => {
    const visitor = forClient(event);
    if (visitor.type === 'error') return visitor.error === undefined ? [] : [visitor.error];
    if (visitor.type === 'tool' && visitor.tool.phase === 'error') {
      return visitor.tool.failure.error === undefined ? [] : [visitor.tool.failure.error];
    }
    return [];
  });
}

function kinds(observed: Observed): ErrorKind[] {
  return observed.events
    .flatMap((event) => {
      if (event.type === 'error') return [event.errorKind];
      if (event.type === 'tool' && event.tool.phase === 'error') return [event.tool.failure.kind];
      return [];
    })
    .concat(observed.thrown === undefined ? [] : [errorKind(observed.thrown)]);
}

function check(observed: Observed, expected: Expected): void {
  const builder = builderText(observed);
  const visitor = visitorText(observed);
  const trace = JSON.stringify(observed.traces);
  for (const reason of expected.reasons) {
    assert(builder.includes(reason), `R1.1: the builder reads "${reason}" in ${builder}`);
    if (observed.traces.length > 0) {
      assertEquals(
        trace.includes(reason),
        !expected.traceSummary,
        `R1.1, S1: the trace and "${reason}"`,
      );
    }
    for (const label of labels(observed)) {
      assert(!label.includes(reason), `R2.2: the label "${label}" holds no reason`);
    }
  }
  if (expected.kind) {
    assertEquals(kinds(observed).at(-1), expected.kind, 'R1.2, R1.3: the kind');
  }
  assert(!visitor.includes('errorInternal'), `R2.4: the visitor reads no errorInternal`);
  if (expected.traceSummary) {
    assert(trace.includes(expected.traceSummary), `O9: the trace holds "${expected.traceSummary}"`);
    const id = /\(error ([0-9a-f]{8})\)/.exec(trace)?.[1];
    assert(id !== undefined && builder.includes(`(error ${id})`), 'O9: one error id in both');
  }
  if (expected.stop) {
    assertEquals(finalStop(observed.events)?.kind, expected.stop, 'R3.1, R3.2: the stop');
  }
  for (const secret of expected.secrets ?? []) {
    assert(!visitor.includes(secret), 'S1: no secret in the visitor copy');
    assert(!builder.includes(secret), 'S1: no secret in the builder copy');
    assert(!trace.includes(secret), 'S1: no secret in the trace');
  }
}

async function turn(profile: string, model: TurnModel): Promise<Observed> {
  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  try {
    for await (const event of runTurn(
      { profile, input: { text: 'x' } },
      model,
      catalogedSink(traces),
    )) {
      events.push(event);
    }
  } catch (thrown) {
    return { events, traces, thrown };
  }
  return { events, traces };
}

function textProfile(id: string, extra: Record<string, unknown> = {}): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 't', system: 't' },
      id,
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      ...extra,
    } as Parameters<typeof defineProfile>[0]),
  );
  return id;
}

function throws(error: unknown): TurnModel {
  return {
    complete: () =>
      (async function* (): AsyncGenerator<ModelEvent> {
        await Promise.resolve();
        yield* [];
        throw error;
      })(),
  };
}

Deno.test('a provider failure keeps its cause for the builder, with no key', async () => {
  const profile = textProfile('matrix.provider.cause');
  const cause = new Error(`socket reset by upstream ${SECRET}`);
  const observed = await turn(
    profile,
    throws(new TheoremError('unavailable', 'stream broke', { cause })),
  );
  check(observed, {
    reasons: ['stream broke', 'socket reset by upstream'],
    kind: 'unavailable',
    secrets: [SECRET],
  });
});

Deno.test('a profile build that fails on a host bug reads as internal and keeps its cause', () => {
  const spec = {
    get sampleRate(): number {
      throw new TypeError('getter bug');
    },
  };
  let thrown: unknown;
  try {
    textProfile('matrix.profile.build', { observability: spec });
  } catch (error) {
    thrown = error;
  }
  assertInstanceOf(thrown, TheoremError);
  assertEquals(thrown.kind, 'internal');
  assertInstanceOf(thrown.cause, TypeError);
});

function script(...events: ModelEvent[]): TurnModel {
  return {
    complete: () =>
      (async function* () {
        await Promise.resolve();
        for (const event of events) yield event;
      })(),
  };
}

Deno.test('a host detector that throws stays closed and tells the builder why', async () => {
  const profile = textProfile('matrix.detector.throws', {
    guardrails: {
      detect: {
        'acme.down': {
          label: 'Down',
          action: 'flag',
          find: () => {
            throw new Error('classifier offline');
          },
        },
      },
    },
  });
  const observed = await turn(
    profile,
    script({ type: 'text', text: 'hi' }, { type: 'done', stop: { kind: 'completed' } }),
  );
  check(observed, {
    reasons: ['classifier offline'],
    traceSummary: "Host detector 'acme.down' find threw Error",
  });
});

Deno.test('a compactor that throws tells the builder why', async () => {
  const compactor = textProfile('matrix.compactor.compactor', {
    maxSteps: 1,
    guardrails: { detect: 'ignore' },
  });
  const speaker = 'matrix.compactor.speaker';
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 't', system: 't' },
      id: speaker,
      models: {
        matrixCompactorModel: {
          ...geminiModels('gemini35FlashLite').models.gemini35FlashLite,
          compaction: {
            maxTokens: 1000,
            compactAt: 0.5,
            previousExchanges: 2,
            timing: 'before',
            profile: compactor,
          },
        },
      },
      tools: { allow: [] },
      inputs: { text: true },
      guardrails: { detect: 'ignore' },
    } as Parameters<typeof defineProfile>[0]),
  );
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `message ${i}`,
  }));
  let calls = 0;
  const model: TurnModel = {
    complete: () => {
      calls++;
      if (calls === 1) {
        return throws(
          new TheoremError('unavailable', 'summary call down', {
            cause: new Error('pool drained'),
          }),
        ).complete({} as never);
      }
      return script(
        { type: 'text', text: 'ok' },
        { type: 'done', stop: { kind: 'completed' } },
      ).complete({} as never);
    },
  };
  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  for await (const event of runTurn(
    { profile: speaker, input: { text: 'q', history, historyTokens: 600 } },
    model,
    catalogedSink(traces),
  )) {
    events.push(event);
  }
  check({ events, traces }, { reasons: ['summary call down', 'pool drained'] });
});

Deno.test('a host detector that throws on the reply stays closed and tells the builder why', async () => {
  const profile = textProfile('matrix.detector.reply', {
    guardrails: {
      detect: {
        'acme.reply': {
          label: 'Reply check',
          at: { reply: 'flag' },
          find: () => {
            throw new Error('reply classifier offline');
          },
        },
      },
    },
  });
  const observed = await turn(
    profile,
    script({ type: 'text', text: 'hi' }, { type: 'done', stop: { kind: 'completed' } }),
  );
  check(observed, {
    reasons: ['reply classifier offline'],
    traceSummary: "Host detector 'acme.reply' find threw Error",
  });
});

Deno.test('a host detector that throws an error named with data puts none of it in the trace', async () => {
  const profile = textProfile('matrix.detector.named', {
    guardrails: {
      detect: {
        'acme.named': {
          label: 'Named',
          action: 'flag',
          find: () => {
            const error = new Error('named classifier down');
            error.name = `Leak${SECRET}`;
            throw error;
          },
        },
      },
    },
  });
  const observed = await turn(
    profile,
    script({ type: 'text', text: 'hi' }, { type: 'done', stop: { kind: 'completed' } }),
  );
  check(observed, {
    reasons: ['named classifier down'],
    traceSummary: "Host detector 'acme.named' find threw Error",
    secrets: [SECRET],
  });
});

async function invoked(name: string, options: Partial<InvokeToolRequest> = {}): Promise<Observed> {
  const events: TurnEvent[] = [];
  try {
    for await (const event of invokeTool({ profile: name, name, input: {}, ...options })) {
      events.push(event);
    }
  } catch (thrown) {
    return { events, traces: [], thrown };
  }
  return { events, traces: [] };
}

Deno.test('a page tool with no execution coordinator reads as config and says what is missing', async () => {
  const name = 'matrix_page_tool';
  registerTool({
    type: 'function',
    name,
    description: 'Ask the page',
    category: 'test',
    access: 'read-write',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    answeredBy: 'page',
    input: z.object({}),
    output: z.object({ text: z.string() }),
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
  const observed = await invoked(name, {
    pageExecution: {
      dispatch: () =>
        Promise.resolve({ grantId: 'grant', result: Promise.resolve({ output: { text: 'ok' } }) }),
    },
  });
  check(observed, { reasons: ['needs a tool execution coordinator'], kind: 'config' });
});

function httpTool(name: string): void {
  registerTool({
    name,
    description: 'Fetch a thing',
    type: 'http',
    endpoint: 'https://api.example.com/thing',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.unknown(),
    mapping: {},
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
}

const publicHost = () => Promise.resolve(['93.184.215.14']);

async function withFetch<T>(fetchFn: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test('an HTTP tool keeps the kind of what it threw', async () => {
  const name = 'matrix_http_tool';
  httpTool(name);
  for (const [error, kind, reason] of [
    [new TypeError('socket hang up'), 'network', 'socket hang up'],
    [new DOMException('stopped by host', 'AbortError'), 'cancelled', 'stopped by host'],
    [new TheoremError('internal', 'resolver bug'), 'internal', 'resolver bug'],
  ] as const) {
    const observed = await withFetch(
      () => Promise.reject(error),
      () => invoked(name, { resolveHost: publicHost }),
    );
    check(observed, { reasons: [reason], kind });
  }
});

Deno.test('an HTTP tool whose body read fails reads as network', async () => {
  const name = 'matrix_http_body';
  httpTool(name);
  const observed = await withFetch(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError('body reset'));
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    () => invoked(name, { resolveHost: publicHost }),
  );
  check(observed, { reasons: ['body reset'], kind: 'network' });
});

function decisionProfile(id: string): string {
  registerProfile(
    defineProfile({
      type: 'decision',
      id,
      identity: { handle: 'Decision' },
      models: {
        jev: { protocol: 'systemOne', provider: 'typesafe', apiId: 'jev-latest', timeoutMs: 1000 },
      },
      inputs: { state: 'json', maxStateBytes: 1000 },
      decision: { contract: 'test.v1' },
    }),
  );
  return id;
}

Deno.test('a decision keeps the kind of what failed under it', async () => {
  const profile = decisionProfile('matrix.decision');
  for (const [fetchFn, kind, reason] of [
    [
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError('decision body reset'));
              },
            }),
          ),
        ),
      'network',
      'decision body reset',
    ],
    [
      () => Promise.reject(new TheoremError('internal', 'host fetch bug')),
      'internal',
      'host fetch bug',
    ],
  ] as const) {
    let thrown: unknown;
    try {
      await runDecision(
        {
          profile,
          state: { a: 1 },
          questions: {
            next: { type: 'choice', instructions: 'Pick.', criteria: { a: 'A.', b: 'B.' } },
          },
        },
        { vault: FIXTURE_VAULT, fetch: fetchFn },
      );
    } catch (error) {
      thrown = error;
    }
    check({ events: [], traces: [], thrown }, { reasons: [reason], kind });
  }
});

Deno.test('a connection that drops mid-reply reads as network and keeps the text', async () => {
  const scope = createKernelScope();
  const provider = scope.providers.register(
    defineProvider({
      id: 'matrix-drop',
      name: 'Drop',
      description: 'Drops mid-reply',
      key: z.string(),
      authorize: bearer(),
      serves: () => [{ protocol: openAi, baseUrl: 'https://drop.test/v1' }],
    }),
    { keySlot: 'main' },
  );
  scope.profiles.register(
    defineProfile({
      id: 'matrix.drop',
      type: 'text',
      identity: { handle: 'Drop' },
      models: { main: provider.model(openAi, 'm') },
      inputs: { text: true },
      tools: { allow: [] },
      maxSteps: 1,
    }),
  );
  const chunk = new TextEncoder().encode(
    'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
  );
  let sent = false;
  const send: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) controller.error(new TypeError('connection reset'));
            else controller.enqueue(chunk);
            sent = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  for await (const event of scope.runTurn(
    { profile: 'matrix.drop', input: { text: 'x' } },
    { fetch: send, vault: { main: 'fixture-key' }, wait: () => Promise.resolve() },
    catalogedSink(traces),
  )) {
    events.push(event);
  }
  check({ events, traces }, { reasons: ['connection reset'], kind: 'network' });
  assert(
    events.some((event) => event.type === 'text' && event.text === 'hi'),
    'R3: the text before the drop is kept',
  );
});

/** A memory coordinator that also notes each begin, so a cell can tell when the claim was taken. */
function noting(begin?: () => Promise<never>): {
  execution: ToolExecutionCoordinator;
  begins: () => number;
  effects: (operationId: string, callId: string) => Promise<string | undefined>;
} {
  const memory = createMemoryToolExecution();
  let begins = 0;
  return {
    execution: {
      ...memory,
      begin: (operation) => {
        begins++;
        return begin ? begin() : memory.begin(operation);
      },
    },
    begins: () => begins,
    effects: async (operationId, callId) => {
      const known = await memory.lookup({
        operationId,
        callId,
        profileId: '',
        toolId: '',
        invocationHash: '',
      });
      return known?.kind === 'settled' ? known.outcome.effects : known?.kind;
    },
  };
}

Deno.test('a tool that fails before it sends takes no claim and saves as not started', async () => {
  const name = 'matrix_http_blocked';
  httpTool(name);
  const coordinator = noting();
  let sent = 0;
  const observed = await withFetch(
    () => {
      sent++;
      return Promise.resolve(new Response('{}'));
    },
    () =>
      invoked(name, {
        execution: coordinator.execution,
        operationId: 'op-blocked',
        callId: 'call-blocked',
        resolveHost: () => Promise.resolve(['10.0.0.1']),
      }),
  );
  check(observed, { reasons: [], kind: 'blocked' });
  assertEquals([sent, coordinator.begins()], [0, 0]);
  assertEquals(await coordinator.effects('op-blocked', 'call-blocked'), 'not_started');
});

Deno.test('a tool whose send fails after the claim saves its effects as unknown', async () => {
  const name = 'matrix_http_sent';
  httpTool(name);
  const coordinator = noting();
  const observed = await withFetch(
    () => Promise.reject(new DOMException('stopped mid-send', 'AbortError')),
    () =>
      invoked(name, {
        execution: coordinator.execution,
        operationId: 'op-sent',
        callId: 'call-sent',
        resolveHost: publicHost,
      }),
  );
  check(observed, { reasons: ['stopped mid-send'], kind: 'cancelled' });
  assertEquals(coordinator.begins(), 1);
  assertEquals(await coordinator.effects('op-sent', 'call-sent'), 'unknown');
});

Deno.test('a call stopped before it sends leaves no claim and reads as cancelled', async () => {
  const name = 'matrix_http_stopped';
  httpTool(name);
  const coordinator = noting();
  const stop = new AbortController();
  const observed = await invoked(name, {
    execution: coordinator.execution,
    operationId: 'op-stopped',
    callId: 'call-stopped',
    signal: stop.signal,
    resolveHost: () => {
      stop.abort(new DOMException('stopped while checking', 'AbortError'));
      return publicHost();
    },
  });
  check(observed, { reasons: ['stopped while checking'], kind: 'cancelled' });
  assertEquals(coordinator.begins(), 0);
  assertEquals(await coordinator.effects('op-stopped', 'call-stopped'), undefined);
});

function mcpTool(name: string): void {
  registerTool({
    name,
    description: 'Search the docs',
    type: 'mcp',
    serverUrl: 'https://mcp.example.com/mcp',
    mcpToolName: 'search_docs',
    category: 'docs',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    input: z.object({}),
    output: z.unknown(),
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
}

Deno.test('a coordinator that throws at the claim keeps its kind, and nothing is sent', async () => {
  const http = 'matrix_claim_http';
  const mcp = 'matrix_claim_mcp';
  httpTool(http);
  mcpTool(mcp);
  for (const name of [http, mcp]) {
    const coordinator = noting(() => Promise.reject(new Error('operation store down')));
    let sent = 0;
    const observed = await withFetch(
      () => {
        sent++;
        return Promise.resolve(new Response('{}'));
      },
      () => invoked(name, { execution: coordinator.execution, resolveHost: publicHost }),
    );
    check(observed, { reasons: ['operation store down'], kind: 'internal' });
    assertEquals([sent, coordinator.begins()], [0, 1], name);
  }
});

Deno.test('a page dispatch that fails after the claim keeps its cause kind, with the uncertain copy', async () => {
  const name = 'matrix_page_dropped';
  registerTool({
    type: 'function',
    name,
    description: 'Ask the page',
    category: 'test',
    access: 'read-write',
    permission: 'auto',
    loadTier: 'T0',
    paths: ['*'],
    answeredBy: 'page',
    input: z.object({}),
    output: z.object({ text: z.string() }),
  });
  registerProfile({ type: 'host', id: name, tools: { allow: [name] } });
  const coordinator = noting();
  const observed = await invoked(name, {
    execution: coordinator.execution,
    operationId: 'op-page',
    callId: 'call-page',
    pageExecution: {
      dispatch: () => Promise.reject(new TheoremError('network', 'page link dropped')),
    },
  });
  check(observed, { reasons: ['page link dropped'], kind: 'network' });
  const copies = observed.events.flatMap((event) =>
    event.type === 'error' ? [event.errorCopy] : [],
  );
  assertEquals(copies, [{ key: 'tool.execution_uncertain' }]);
  assertEquals(await coordinator.effects('op-page', 'call-page'), 'uncertain');
  const again = await invoked(name, {
    execution: coordinator.execution,
    operationId: 'op-page',
    callId: 'call-page',
    pageExecution: {
      dispatch: () =>
        Promise.resolve({ grantId: 'grant', result: Promise.resolve({ output: { text: 'ok' } }) }),
    },
  });
  check(again, { reasons: ['is uncertain, so it does not run again'], kind: 'request' });
  assertEquals(coordinator.begins(), 1);
});
