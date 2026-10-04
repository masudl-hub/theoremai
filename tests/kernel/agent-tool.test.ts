import '../fixtures/test-host.ts';
import { assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { createKernelScope, type KernelScope } from '../../src/kernel/scope.ts';
import { agentToolOrigin } from '../../src/kernel/tools/agent.ts';
import type { AgentCallHook, AgentToolDef } from '../../src/kernel/tools/types.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnEventOf,
  TurnTokens,
} from '../../src/kernel/types.ts';
import { memorySink } from '../../src/observability/trace.ts';
import type { TraceRecord } from '../../src/observability/trace-schema.ts';
import { geminiModels, HOST_BINDINGS } from '../fixtures/models.ts';

const CALLER = 'agent_tool_caller';
const RESEARCHER = 'agent_tool_researcher';
const RESEARCHER_SYSTEM = 'You research.';

const CALLER_TOKENS: TurnTokens = { input: 100, output: 10, total: 110 };
const RESEARCHER_TOKENS: TurnTokens = { input: 40, output: 5, total: 45 };

function agentTool(over: Partial<AgentToolDef> = {}): AgentToolDef {
  return {
    type: 'agent',
    name: 'ask_researcher',
    description: 'Ask the researcher.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    profile: RESEARCHER,
    ...over,
  };
}

function textProfile(
  id: string,
  system: string,
  allow: string[],
  models = geminiModels('gemini35FlashLite'),
) {
  return defineProfile({
    type: 'text',
    identity: { handle: id, system },
    id,
    ...models,
    maxSteps: 4,
    tools: { allow },
    inputs: { text: true },
  });
}

/** A scope where the caller can ask the researcher, which has `researcherTools`. */
function scopeWith(tool: Partial<AgentToolDef> = {}, researcherTools: string[] = []): KernelScope {
  const scope = createKernelScope();
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
  scope.profiles.register(textProfile(RESEARCHER, RESEARCHER_SYSTEM, researcherTools));
  scope.tools.register(agentTool(tool));
  scope.profiles.register(textProfile(CALLER, 'You help.', [tool.name ?? 'ask_researcher']));
  return scope;
}

function isResearcher(req: ProviderCompleteRequest): boolean {
  return req.system.includes(RESEARCHER_SYSTEM);
}

/** The text the called agent was sent, inside the user-data frame every turn input gets. */
function inputText(req: ProviderCompleteRequest): string {
  const last = req.history?.at(-1);
  const content = typeof last?.content === 'string' ? last.content : '';
  return content.replace(/^<user_data>\n|\n<\/user_data>$/g, '');
}

/**
 * The caller asks the researcher `calls` times in its first step, then answers
 * with what came back. The researcher answers with the text it was sent.
 */
function routedProvider(calls = 1, seen: string[] = []): ModelProvider {
  let callerStep = 0;
  return {
    async *complete(req) {
      await Promise.resolve();
      if (isResearcher(req)) {
        seen.push(inputText(req));
        yield { type: 'text', text: `found: ${inputText(req)}` };
        yield { type: 'tokens', tokens: RESEARCHER_TOKENS };
        return;
      }
      callerStep += 1;
      yield { type: 'tokens', tokens: CALLER_TOKENS };
      if (callerStep === 1) {
        for (let i = 0; i < calls; i++) {
          yield {
            type: 'tool',
            tool: {
              name: 'ask_researcher',
              arguments: { text: `question ${i}` },
              callId: `call_${i}`,
            },
          };
        }
        return;
      }
      yield { type: 'text', text: 'Done.' };
    },
  };
}

async function collect(
  scope: KernelScope,
  provider: ModelProvider,
  onAgentCall?: AgentCallHook,
  records?: TraceRecord[],
): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  const req = { profile: CALLER, input: { text: 'Help' }, ...(onAgentCall ? { onAgentCall } : {}) };
  for await (const event of scope.runTurn(
    req,
    provider,
    records ? memorySink(records) : undefined,
  )) {
    events.push(event);
  }
  return events;
}

function toolPhases(events: TurnEvent[], phase: string) {
  return events.flatMap((e) =>
    e.type === 'tool' && 'phase' in e.tool && e.tool.phase === phase ? [e.tool] : [],
  );
}

function doneOf(events: TurnEvent[]): TurnEventOf<'done'> {
  return events.find((e): e is TurnEventOf<'done'> => e.type === 'done') as TurnEventOf<'done'>;
}

Deno.test('an agent tool returns the called agent reply to the caller', async () => {
  const seen: string[] = [];
  const events = await collect(scopeWith(), routedProvider(1, seen));
  assertEquals(seen, ['question 0']);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, { text: 'found: question 0' });
  assertEquals(doneOf(events).stop.kind, 'completed');
});

Deno.test("the caller's done.tokens includes the agent call, which carries its own", async () => {
  const events = await collect(scopeWith(), routedProvider());
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { tokens?: TurnTokens }).tokens?.total, RESEARCHER_TOKENS.total);
  assertEquals(doneOf(events).tokens?.total, CALLER_TOKENS.total * 2 + RESEARCHER_TOKENS.total);
});

Deno.test("the called agent's events stream to the host as the call's progress", async () => {
  const events = await collect(scopeWith(), routedProvider());
  const nested = toolPhases(events, 'progress').map(
    (tool) => (tool as { data: { agent: string; event: TurnEvent } }).data,
  );
  assertEquals(
    nested.every((data) => data.agent === RESEARCHER),
    true,
  );
  assertEquals(
    nested.some((data) => data.event.type === 'text'),
    true,
  );
  assertEquals(
    nested.some((data) => data.event.type === 'done'),
    true,
  );
});

Deno.test('a call past maxCallsPerTurn is declined without running the agent', async () => {
  const seen: string[] = [];
  const events = await collect(scopeWith({ maxCallsPerTurn: 1 }), routedProvider(2, seen));
  assertEquals(seen, ['question 0']);
  const [error] = toolPhases(events, 'error');
  const failure = (error as { failure: { code: string; kind: string } }).failure;
  assertEquals([failure.code, failure.kind], ['call_limit', 'declined']);
});

Deno.test('the host can refuse a call', async () => {
  const seen: string[] = [];
  const events = await collect(scopeWith(), routedProvider(1, seen), () => ({
    refuse: 'Not now.',
  }));
  assertEquals(seen, []);
  const [error] = toolPhases(events, 'error');
  const failure = (error as { failure: { code: string; kind: string; message: string } }).failure;
  assertEquals(
    [failure.code, failure.kind, failure.message],
    ['refused_by_host', 'declined', 'Not now.'],
  );
});

Deno.test('the host can shape the call and sees who made it', async () => {
  const seen: string[] = [];
  const calls: Parameters<AgentCallHook>[0][] = [];
  await collect(scopeWith(), routedProvider(1, seen), (call) => {
    calls.push(call);
    return { input: { text: `${call.input.text}, briefly` } };
  });
  assertEquals(seen, ['question 0, briefly']);
  assertEquals(
    calls.map(({ tool, profile, caller, depth }) => ({ tool, profile, caller, depth })),
    [{ tool: 'ask_researcher', profile: RESEARCHER, caller: CALLER, depth: 1 }],
  );
});

Deno.test("a called agent on another provider needs the host's provider", async () => {
  const scope = createKernelScope();
  scope.profiles.register(
    textProfile(RESEARCHER, RESEARCHER_SYSTEM, [], {
      models: { sonar: HOST_BINDINGS.sonar },
      key: 'slot_a',
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const events = await collect(scope, routedProvider()).catch((err) => [{ thrown: err }]);
  const thrown = (events[0] as { thrown?: unknown }).thrown;
  const errorEvent = (events as TurnEvent[]).find((e) => e.type === 'error') as
    | TurnEventOf<'error'>
    | undefined;
  assertEquals(thrown instanceof TheoremError ? thrown.kind : errorEvent?.errorKind, 'config');
  const seen: string[] = [];
  const ok = await collect(scope, routedProvider(1, seen), () => ({
    provider: routedProvider(0, seen),
  }));
  assertEquals(seen, ['question 0']);
  assertEquals(doneOf(ok).stop.kind, 'completed');
});

Deno.test('the agent call runs nested under its tool span, in the same record', async () => {
  const records: TraceRecord[] = [];
  await collect(scopeWith(), routedProvider(), undefined, records);
  assertEquals(records.length, 1);
  const spans = records[0]?.spans ?? [];
  const tool = spans.find((s) => s.name === 'execute_tool ask_researcher');
  const nested = spans.find((s) => s.name === `invoke_agent ${RESEARCHER}`);
  assertEquals(nested?.parentSpanId, tool?.spanId);
});

Deno.test('a host can invoke an agent tool with its own provider', async () => {
  const scope = scopeWith();
  const seen: string[] = [];
  const events: TurnEvent[] = [];
  for await (const event of scope.invokeTool({
    profile: CALLER,
    name: 'ask_researcher',
    input: { text: 'direct' },
    provider: routedProvider(0, seen),
  })) {
    events.push(event);
  }
  assertEquals(seen, ['direct']);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, { text: 'found: direct' });
});

Deno.test('an agent tool is checked when it is registered', () => {
  const scope = createKernelScope();
  assertThrows(
    () => scope.tools.register(agentTool()),
    TheoremError,
    'must be registered before the tool',
  );
  scope.tools.register({
    type: 'function',
    name: 'confirm_me',
    description: 'Needs a yes.',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: z.object({}),
    output: z.object({}),
    handler: () => ({}),
  });
  scope.profiles.register(textProfile(RESEARCHER, RESEARCHER_SYSTEM, ['confirm_me']));
  assertThrows(
    () => scope.tools.register(agentTool()),
    TheoremError,
    "its tool 'confirm_me' can stop on a gate",
  );
  scope.profiles.register(textProfile('plain_researcher', RESEARCHER_SYSTEM, []));
  assertThrows(
    () => scope.tools.register(agentTool({ profile: 'plain_researcher', maxCallsPerTurn: 0 })),
    TheoremError,
    'maxCallsPerTurn must be a whole number above 0',
  );
});

Deno.test('an agent with no tools of its own is trusted; one with tools taints', () => {
  assertEquals(agentToolOrigin(textProfile('bare', 'x', [])), 'local');
  assertEquals(agentToolOrigin(textProfile('tooled', 'x', ['lookup'])), 'delegated');
});

Deno.test("an image agent's picture comes back as parts", async () => {
  const scope = createKernelScope();
  scope.profiles.register(
    defineProfile({
      id: RESEARCHER,
      type: 'image',
      identity: { handle: 'painter' },
      ...geminiModels('gemini31FlashLiteImage'),
      image: { aspectRatio: '1:1', resolution: '1K', mimeType: 'image/png', includeText: false },
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: null },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (req.image) {
        yield { type: 'media', media: { mimeType: 'image/png', data: 'cGl4' } };
        return;
      }
      yield* routedProvider().complete(req);
    },
  };
  const events = await collect(scope, provider);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, {
    text: '',
    parts: [{ type: 'image', mimeType: 'image/png', data: 'cGl4' }],
  });
});

Deno.test('an agent that does not finish fails the call, with its usage', async () => {
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (isResearcher(req)) {
        yield { type: 'tokens', tokens: RESEARCHER_TOKENS };
        yield { type: 'done', stop: { kind: 'length' } };
        return;
      }
      yield* routedProvider().complete(req);
    },
  };
  const events = await collect(scopeWith(), provider);
  const [error] = toolPhases(events, 'error');
  const { failure, tokens } = error as { failure: { code: string }; tokens?: TurnTokens };
  assertEquals(failure.code, 'agent_failed');
  assertEquals(tokens?.total, RESEARCHER_TOKENS.total);
});

Deno.test("a live profile can't allow an agent tool", () => {
  const scope = scopeWith();
  assertThrows(
    () =>
      scope.profiles.register(
        defineProfile({
          type: 'live',
          id: 'agent_tool_live',
          identity: { handle: 'live' },
          ...geminiModels('gemini31FlashLive'),
          live: { voice: 'Aoede' },
          tools: { allow: ['ask_researcher'] },
        }),
      ),
    TheoremError,
    "a live session can't run an agent tool",
  );
});
