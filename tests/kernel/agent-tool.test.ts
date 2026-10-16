import { createTestKernelScope as createKernelScope } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions, runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import type { ErrorKind } from '../../src/guardrails/theorem-error.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import type { ProfileTurnResumptionSpec } from '../../src/kernel/stop.ts';
import { agentToolOrigin } from '../../src/kernel/tools/agent.ts';
import type { AgentCall, AgentCallHook, AgentToolDef } from '../../src/kernel/tools/types.ts';
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
  resumption?: ProfileTurnResumptionSpec,
) {
  return defineProfile({
    type: 'text',
    identity: { handle: id, system },
    id,
    ...models,
    maxSteps: 4,
    tools: { allow },
    ...(resumption ? { turnBehaviour: { resumption } } : {}),
    inputs: { text: true },
  });
}

/** A scope where the caller can ask the researcher, which has `researcherTools`. */
function scopeWith(
  tool: Partial<AgentToolDef> = {},
  researcherTools: string[] = [],
  researcherResumption?: ProfileTurnResumptionSpec,
  onLookup?: (host: unknown) => void,
): KernelScope {
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
    handler: (_input, ctx) => {
      onLookup?.(ctx.host);
      return { found: 'fact' };
    },
  });
  scope.profiles.register(
    textProfile(RESEARCHER, RESEARCHER_SYSTEM, researcherTools, undefined, researcherResumption),
  );
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
  for await (const event of runScopedTurn(
    scope,
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

Deno.test('a structured reply comes back once, as the object and not also as its text', async () => {
  const scope = createKernelScope();
  scope.schemas.register('agent_tool_reply', {
    jsonSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  });
  scope.profiles.register(
    defineProfile({
      ...textProfile(RESEARCHER, RESEARCHER_SYSTEM, []),
      outputs: { structured: 'agent_tool_reply' },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const read: string[] = [];
  const caller = routedProvider();
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (isResearcher(req)) {
        yield { type: 'text', text: '{"summary":"water less"}' };
        yield { type: 'structured', structured: { summary: 'water less' } };
        return;
      }
      const last = req.history?.at(-1);
      if (last?.role === 'tool' && typeof last.content === 'string') read.push(last.content);
      yield* caller.complete(req);
    },
  };
  const events = await collect(scope, provider);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, {
    structured: { summary: 'water less' },
  });
  assertEquals(read, ['{"structured":{"summary":"water less"}}']);
});

Deno.test("the caller's done.tokens includes the agent call, which carries its own", async () => {
  const events = await collect(scopeWith(), routedProvider());
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { tokens?: TurnTokens }).tokens?.total, RESEARCHER_TOKENS.total);
  assertEquals(doneOf(events).tokens?.total, CALLER_TOKENS.total * 2 + RESEARCHER_TOKENS.total);
});

Deno.test("the called agent's reply streams as the call's drafts, its other events as its progress", async () => {
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
    false,
  );
  assertEquals(
    toolPhases(events, 'draft')
      .map((tool) => (tool as { text: string }).text)
      .join(''),
    'found: question 0',
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

Deno.test('a called agent resolves its own registered provider', async () => {
  const scope = createKernelScope();
  scope.profiles.register(
    textProfile(RESEARCHER, RESEARCHER_SYSTEM, [], {
      models: { sonar: HOST_BINDINGS.sonar },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const events = await collect(scope, routedProvider());
  assertEquals(
    events.some((event) => event.type === 'error'),
    false,
  );
  const seen: string[] = [];
  const ok = await collect(scope, routedProvider(1, seen), () => ({
    provider: fixtureHostOptions(routedProvider(0, seen), scope),
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
    provider: fixtureHostOptions(routedProvider(0, seen), scope),
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

Deno.test("a speech agent's audio comes back as parts", async () => {
  const scope = createKernelScope();
  scope.profiles.register(
    defineProfile({
      id: RESEARCHER,
      type: 'speech',
      identity: { handle: 'narrator' },
      ...geminiModels('gemini31FlashTts'),
      speech: { voice: 'Kore', format: 'pcm' },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const caller = routedProvider();
  let spoken = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (req.speech) {
        spoken += 1;
        yield { type: 'media', media: { mimeType: 'audio/pcm', data: 'c291bmQ=' } };
        return;
      }
      yield* caller.complete(req);
    },
  };
  const events = await collect(scope, provider);
  assertEquals(spoken, 1);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, {
    text: '',
    parts: [{ type: 'audio', mimeType: 'audio/pcm', data: 'c291bmQ=' }],
  });
});

/** The caller sends the tool `args` in its first step; the called agent's requests land in `seen`. */
function sendingProvider(args: Record<string, unknown>, seen: ProviderCompleteRequest[]) {
  let callerStep = 0;
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (!req.system.includes('You help.')) {
        seen.push(req);
        if (req.speech) {
          yield { type: 'media', media: { mimeType: 'audio/pcm', data: 'c291bmQ=' } };
          return;
        }
        yield { type: 'text', text: 'seen' };
        return;
      }
      callerStep += 1;
      if (callerStep === 1) {
        yield { type: 'tool', tool: { name: 'ask_researcher', arguments: args, callId: 'call_0' } };
        return;
      }
      seen.push(req);
      yield { type: 'text', text: 'Done.' };
    },
  };
  return provider;
}

/** A scope whose called agent takes pictures and one slot beside its text. */
function pictureScope(): KernelScope {
  const scope = createKernelScope();
  scope.profiles.register(
    defineProfile({
      type: 'text',
      identity: { handle: 'annotator', system: 'You annotate.' },
      id: RESEARCHER,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: [] },
      inputs: {
        text: true,
        attachments: { accept: ['image/png'] },
        maxFiles: 2,
        maxBytes: 1_000_000,
        maxTurnBytes: 2_000_000,
        slots: { depth: ['quick', 'careful'] },
      },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  return scope;
}

function speechScope(): KernelScope {
  const scope = createKernelScope();
  scope.profiles.register(
    defineProfile({
      id: RESEARCHER,
      type: 'speech',
      identity: { handle: 'narrator' },
      ...geminiModels('gemini31FlashTts'),
      speech: { voice: 'Kore', format: 'pcm' },
    }),
  );
  scope.tools.register(agentTool());
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  return scope;
}

const PICTURE = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };

Deno.test("an agent tool's input is what the called profile takes", () => {
  const properties = (scope: KernelScope) => {
    const tool = scope.tools.get('ask_researcher');
    const schema = tool && 'inputSchema' in tool ? tool.inputSchema : {};
    return Object.keys(schema.properties as object);
  };
  assertEquals(properties(scopeWith()), ['text']);
  assertEquals(properties(pictureScope()), ['text', 'attachments', 'slots']);
  assertEquals(properties(speechScope()), ['text', 'speech']);
});

Deno.test('the calling model sends a picture and a slot, and the agent gets both', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const calls: Parameters<AgentCallHook>[0][] = [];
  const sent = { text: 'What is this?', attachments: [PICTURE], slots: { depth: 'careful' } };
  const events = await collect(pictureScope(), sendingProvider(sent, seen), (call) => {
    calls.push(call);
    return undefined;
  });
  assertEquals(toolPhases(events, 'error'), []);
  assertEquals(calls[0]?.input, sent);
  assertEquals(
    seen[0]?.history?.at(-1)?.parts?.some((part) => part.type === 'image'),
    true,
  );
});

Deno.test('a call that sends what the profile does not take is refused, not dropped', async () => {
  const seen: ProviderCompleteRequest[] = [];
  const sent = { text: 'What is this?', attachments: [PICTURE] };
  const events = await collect(scopeWith(), sendingProvider(sent, seen));
  const [error] = toolPhases(events, 'error');
  const failure = (error as { failure: { code: string; kind: string } }).failure;
  assertEquals([failure.code, failure.kind], ['invalid_input', 'bad_response']);
  assertEquals(seen.length, 1);
});

Deno.test('bytes that are not base64, or a text of only spaces, fail the call and not the turn', async () => {
  for (const [scope, sent] of [
    [
      pictureScope(),
      { text: 'What?', attachments: [{ mimeType: 'image/png', data: 'not base64!' }] },
    ],
    [speechScope(), { text: '   ' }],
  ] as const) {
    const seen: ProviderCompleteRequest[] = [];
    const events = await collect(scope, sendingProvider(sent, seen));
    const [error] = toolPhases(events, 'error');
    assertEquals((error as { failure: { code: string } }).failure.code, 'invalid_input');
    assertEquals(doneOf(events).stop.kind, 'completed');
  }
});

Deno.test("a picture the profile does not accept fails the call with the agent's reason", async () => {
  const seen: ProviderCompleteRequest[] = [];
  const sent = {
    text: 'What is this?',
    attachments: [{ mimeType: 'image/gif', data: 'R0lG', name: 'leaf.gif' }],
  };
  const events = await collect(pictureScope(), sendingProvider(sent, seen));
  const [error] = toolPhases(events, 'error');
  assertEquals((error as { failure: unknown }).failure, {
    code: 'agent_failed',
    kind: 'input',
    message:
      "Tool 'ask_researcher' didn't get a reply from its agent\nSorry, leaf.gif is a file type that can't be used here.",
    details: {
      agent: RESEARCHER,
      reasons: [
        {
          key: 'attachments.mime_not_allowed',
          params: { mimeType: 'image/gif', channel: 'attachment', fileName: 'leaf.gif' },
        },
      ],
    },
    error: "Sorry, that file can't be used here.",
  });
  assertEquals(doneOf(events).stop.kind, 'completed');
});

Deno.test('the calling model sets how a speech agent speaks; the host can overrule it', async () => {
  const bySpeaker = async (onAgentCall?: AgentCallHook) => {
    const seen: ProviderCompleteRequest[] = [];
    const sent = { text: 'Hello there', speech: { voice: 'Puck', style: 'warmly' } };
    await collect(speechScope(), sendingProvider(sent, seen), onAgentCall);
    return seen[0]?.speech;
  };
  assertEquals(await bySpeaker(), { voice: 'Puck', format: 'pcm', style: 'warmly' });
  assertEquals(await bySpeaker(() => ({ speech: { voice: 'Aoede' } })), {
    voice: 'Aoede',
    format: 'pcm',
  });
});

Deno.test("a stage after the call can replace the agent's reply before the caller reads it", async () => {
  const seen: ProviderCompleteRequest[] = [];
  const events: TurnEvent[] = [];
  for await (const event of runScopedTurn(
    speechScope(),
    {
      profile: CALLER,
      input: { text: 'Help' },
      onStage: (ctx) =>
        ctx.stage === 'post_tool' ? { mutate: { output: { text: 'kept as note 7' } } } : undefined,
    },
    sendingProvider({ text: 'Hello there' }, seen),
  )) {
    events.push(event);
  }
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, { text: 'kept as note 7' });
  assertEquals(seen.at(-1)?.history?.at(-1)?.content, '{"text":"kept as note 7"}');
});

Deno.test("what the called agent cited comes back, and the caller's turn cites it", async () => {
  const source = { title: 'Kew', uri: 'https://kew.org/monstera', type: 'web' as const };
  const caller = routedProvider();
  const provider: ModelProvider = {
    async *complete(req) {
      await Promise.resolve();
      if (isResearcher(req)) {
        yield { type: 'text', text: 'found' };
        yield { type: 'citation', sources: [source] };
        return;
      }
      yield* caller.complete(req);
    },
  };
  const events = await collect(scopeWith(), provider);
  const [complete] = toolPhases(events, 'complete');
  assertEquals((complete as { output: unknown }).output, { text: 'found', sources: [source] });
  assertEquals(
    events.flatMap((e) => (e.type === 'citation' ? [e] : [])),
    [{ type: 'citation', sources: [source], callId: 'call_0' }],
  );
});

Deno.test("the called agent's canary is kept out of the caller's record", async () => {
  const canaries: string[] = [];
  const routed = routedProvider();
  const provider: ModelProvider = {
    async *complete(req) {
      const canary = /Your canary token is (\S+)\./.exec(req.system ?? '')?.[1];
      if (canary && isResearcher(req)) canaries.push(canary);
      yield* routed.complete(req);
    },
  };
  const records: TraceRecord[] = [];
  await collect(scopeWith(), provider, undefined, records);
  assertEquals(canaries.length, 1);
  const stored = JSON.stringify(records);
  assertEquals(stored.includes(RESEARCHER_SYSTEM), true);
  assertEquals(stored.includes(canaries[0] as string), false);
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

/** The researcher looks something up, then its model is busy `busy` times, then it answers. */
function busyResearcher(busy: number, errorKind: ErrorKind = 'unavailable'): ModelProvider {
  let researcherStep = 0;
  return {
    async *complete(req) {
      await Promise.resolve();
      if (!isResearcher(req)) {
        yield* routedProvider().complete(req);
        return;
      }
      researcherStep += 1;
      if (researcherStep === 1) {
        yield { type: 'tool', tool: { name: 'lookup', arguments: {}, callId: 'lookup_1' } };
        return;
      }
      if (researcherStep <= 1 + busy) {
        yield { type: 'error', errorKind, errorInternal: 'HTTP 503: busy' };
        return;
      }
      const looked = (req.history ?? []).filter((message) => message.role === 'tool').length;
      yield { type: 'text', text: `answered after ${looked} lookup` };
    },
  };
}

const KEEPS_GOING: ProfileTurnResumptionSpec = {
  autoContinue: ['provider_error'],
  maxContinues: 1,
};

Deno.test('a called agent whose model fails mid-work picks up where it stopped', async () => {
  const records: TraceRecord[] = [];
  const events = await collect(
    scopeWith({}, ['lookup'], KEEPS_GOING),
    busyResearcher(1),
    undefined,
    records,
  );
  const [done] = toolPhases(events, 'complete');
  assertEquals((done as { output?: unknown }).output, { text: 'answered after 1 lookup' });
  assertEquals(toolPhases(events, 'error'), []);
  const resumed = (records[0]?.spans ?? []).flatMap((span) =>
    (span.events ?? []).filter((event) => event.name === 'theorem.step.resume'),
  );
  assertEquals(
    resumed.map((event) => event.attributes),
    [{ step: 2, resume: 1, stop: 'provider_error', error: 'HTTP 503: busy' }],
  );
});

Deno.test('a called agent still failing after its re-sends fails the call with the reason', async () => {
  const events = await collect(scopeWith({}, ['lookup'], KEEPS_GOING), busyResearcher(2));
  const [error] = toolPhases(events, 'error');
  const { failure } = error as { failure: { code: string; kind: string; message: string } };
  assertEquals(failure.code, 'agent_failed');
  assertEquals(failure.kind, 'unavailable');
  assertEquals(
    failure.message,
    "Tool 'ask_researcher' didn't get a reply from its agent\nSorry, the model isn't available at the moment. Please try again shortly.",
  );
});

Deno.test('a called agent whose model refuses the request is not sent it again', async () => {
  const records: TraceRecord[] = [];
  const events = await collect(
    scopeWith({}, ['lookup'], KEEPS_GOING),
    busyResearcher(1, 'unsupported'),
    undefined,
    records,
  );
  const [error] = toolPhases(events, 'error');
  assertEquals((error as { failure: { kind: string } }).failure.kind, 'unsupported');
  const resumed = (records[0]?.spans ?? []).flatMap((span) =>
    (span.events ?? []).filter((event) => event.name === 'theorem.step.resume'),
  );
  assertEquals(resumed, []);
});

Deno.test('a turn sent again still remembers the outside content it read before the failure', async () => {
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
  scope.tools.register({
    type: 'function',
    name: 'save_note',
    description: 'Save a note.',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ saved: z.boolean() }),
    handler: () => ({ saved: true }),
  });
  scope.profiles.register(textProfile(RESEARCHER, RESEARCHER_SYSTEM, ['lookup']));
  scope.tools.register(agentTool());
  scope.profiles.register(
    textProfile(CALLER, 'You help.', ['ask_researcher', 'save_note'], undefined, KEEPS_GOING),
  );
  const rulesAfter = async (busy: number): Promise<(string | undefined)[]> => {
    let callerStep = 0;
    const provider: ModelProvider = {
      async *complete(req) {
        await Promise.resolve();
        if (isResearcher(req)) {
          yield { type: 'text', text: 'found it' };
          return;
        }
        callerStep += 1;
        if (callerStep === 1) {
          yield {
            type: 'tool',
            tool: { name: 'ask_researcher', arguments: { text: 'q' }, callId: 'ask_1' },
          };
        } else if (callerStep <= 1 + busy) {
          yield { type: 'error', errorKind: 'unavailable', errorInternal: 'HTTP 503: busy' };
        } else if (callerStep === 2 + busy) {
          yield { type: 'tool', tool: { name: 'save_note', arguments: {}, callId: 'save_1' } };
        } else {
          yield { type: 'text', text: 'Done.' };
        }
      },
    };
    const events = await collect(scope, provider);
    assertEquals(doneOf(events).stop.kind, 'completed');
    return events.flatMap((e) =>
      e.type === 'guardrail' && e.guardrail.stage === 'tool_call'
        ? e.guardrail.hits.map((hit) => hit.rule)
        : [],
    );
  };
  assertEquals(await rulesAfter(0), ['tool_call.tainted-turn']);
  assertEquals(await rulesAfter(1), ['tool_call.tainted-turn']);
});

Deno.test('fieldText puts the host line on an input field, and refuses a field the profile does not take', () => {
  const scope = scopeWith({ fieldText: { text: 'The question, whole.' } });
  const tool = scope.tools.get('ask_researcher');
  assertEquals(tool?.type === 'agent' ? tool.inputSchema.properties : undefined, {
    text: { type: 'string', pattern: '\\S', description: 'The question, whole.' },
  });
  assertThrows(
    () => scopeWith({ fieldText: { voice: 'Speech.' } }),
    TheoremError,
    "describes 'voice', which its profile does not take",
  );
});

Deno.test('a host field reaches the hook and never the called agent', async () => {
  const scope = scopeWith({ hostFields: { media: z.string().describe('A stored file.') } });
  const tool = scope.tools.get('ask_researcher');
  assertEquals(tool?.type === 'agent' ? tool.inputSchema.properties : undefined, {
    text: { type: 'string', pattern: '\\S' },
    media: { type: 'string', description: 'A stored file.' },
  });
  const calls: AgentCall[] = [];
  const seen: string[] = [];
  const caller = routedProvider(1, seen);
  const provider: ModelProvider = {
    async *complete(req) {
      for await (const event of caller.complete(req)) {
        yield event.type === 'tool'
          ? { ...event, tool: { ...event.tool, arguments: { text: 'question 0', media: 'm1' } } }
          : event;
      }
    },
  };
  const events = await collect(scope, provider, (call) => {
    calls.push(call);
    return { input: { text: `${call.input.text} with ${String(call.hostInput?.media)}` } };
  });
  assertEquals(calls[0]?.input, { text: 'question 0' });
  assertEquals(calls[0]?.hostInput, { media: 'm1' });
  assertEquals(seen, ['question 0 with m1']);
  assertEquals(doneOf(events).stop.kind, 'completed');
});

Deno.test('a tool with host fields needs the hook, and a host field takes no input field name', async () => {
  const scope = scopeWith({ hostFields: { media: z.string().optional() } });
  await assertRejects(
    () => collect(scope, routedProvider()),
    TheoremError,
    "declares host fields, which need the request's onAgentCall",
  );
  assertThrows(
    () => scopeWith({ hostFields: { attachments: z.string() } }),
    TheoremError,
    "declares the host field 'attachments'",
  );
});

Deno.test('a host-only channel is out of the model input, and the hook still sends it', async () => {
  const scope = createKernelScope();
  scope.profiles.register(
    defineProfile({
      ...textProfile(RESEARCHER, RESEARCHER_SYSTEM, []),
      inputs: {
        text: true,
        attachments: { accept: ['image/png'] },
        maxFiles: 1,
        maxBytes: 1024,
        maxTurnBytes: 1024,
      },
    }),
  );
  scope.tools.register(agentTool({ hostOnly: ['attachments'] }));
  scope.profiles.register(textProfile(CALLER, 'You help.', ['ask_researcher']));
  const tool = scope.tools.get('ask_researcher');
  assertEquals(tool?.type === 'agent' ? Object.keys(tool.inputSchema.properties ?? {}) : [], [
    'text',
  ]);
  const files: number[] = [];
  const caller = routedProvider();
  const provider: ModelProvider = {
    async *complete(req) {
      if (isResearcher(req)) {
        const parts = req.history?.at(-1)?.parts ?? [];
        files.push(parts.filter((part) => part.type === 'image').length);
      }
      yield* caller.complete(req);
    },
  };
  await collect(scope, provider, (call) => ({
    input: { text: call.input.text, attachments: [{ mimeType: 'image/png', data: 'aGk=' }] },
  }));
  assertEquals(files, [1]);
  assertThrows(
    () => scopeWith({ hostOnly: ['voice'] }),
    TheoremError,
    "keeps 'voice' for the host, which its profile does not take",
  );
});

Deno.test("a hook that throws ends the caller's turn with its error", async () => {
  await assertRejects(
    () =>
      collect(scopeWith(), routedProvider(), () => {
        throw new Error('storage read failed');
      }),
    Error,
    'storage read failed',
  );
});

/** What the researcher's `lookup` read as `ctx.host`, on a turn whose own host is set. */
async function hostSeenByAgentTools(onAgentCall?: AgentCallHook): Promise<unknown[]> {
  const seen: unknown[] = [];
  const scope = scopeWith({}, ['lookup'], undefined, (host) => seen.push(host));
  const req = {
    profile: CALLER,
    input: { text: 'Help' },
    host: 'the caller host',
    ...(onAgentCall ? { onAgentCall } : {}),
  };
  for await (const _ of runScopedTurn(scope, req, busyResearcher(0))) {
    // why: The turn runs to its end; only what the tool read is checked.
  }
  return seen;
}

Deno.test("a called agent's tools read the host the hook gives", async () => {
  assertEquals(await hostSeenByAgentTools(() => ({ host: 'the agent host' })), ['the agent host']);
});

Deno.test("a called agent's tools read no host when the hook gives none", async () => {
  assertEquals(await hostSeenByAgentTools(), [undefined]);
  assertEquals(await hostSeenByAgentTools(() => ({})), [undefined]);
});
