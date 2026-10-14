import { assert, assertEquals } from '@std/assert';
import {
  agentDraft,
  compileStudio,
  createDecisionExampleDraft,
  createExampleDraft,
  providerSource,
  readProviderSource,
  readStudioSource,
  setProfileType,
  studioPageTools,
  studioSource,
  withAgentDraft,
  workspaceFromDraft,
} from '../../studio/mod.ts';

/** The file the printer emits, read back, prints as the same file. */
function roundTrip(draft: ReturnType<typeof createExampleDraft>): void {
  const compiled = compileStudio(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  const source = studioSource(compiled);
  const read = readStudioSource(source, draft);
  if (!read.ok) {
    throw new Error(
      read.errors.map((error) => `${error.line}:${error.column} ${error.message}`).join('\n'),
    );
  }
  const again = compileStudio(read.draft);
  assert(again.ok, again.ok ? '' : again.issues.map((issue) => issue.message).join('\n'));
  const printed = studioSource(again);
  if (printed !== source) {
    const left = source.split('\n');
    const right = printed.split('\n');
    const line = left.findIndex((row, index) => row !== right[index]);
    throw new Error(`line ${line + 1}\n- ${left[line] ?? ''}\n+ ${right[line] ?? ''}`);
  }
  assertEquals(printed, source);
}

Deno.test('the concierge file reads back into the same file', () => {
  roundTrip(createExampleDraft());
});

Deno.test('a list label reads back from the file as a line each', () => {
  const draft = createExampleDraft();
  const list = 'when name is Paris: Finding the capital\n+ Finding {name}\nFinding a place';
  const withList = {
    ...draft,
    toolSpecs: draft.toolSpecs.map((tool) =>
      tool.toolName === 'geocode_city' ? { ...tool, activity: list } : tool,
    ),
  };
  roundTrip(withList);
  const compiled = compileStudio(withList);
  assert(compiled.ok);
  const read = readStudioSource(studioSource(compiled), draft);
  assert(read.ok);
  assertEquals(
    read.draft.toolSpecs.find((tool) => tool.toolName === 'geocode_city')?.activity,
    list,
  );
});

Deno.test('the decision example file reads back into the same file', () => {
  roundTrip(createDecisionExampleDraft());
});

Deno.test('both taint settings in the file come back into the draft', () => {
  const draft = createExampleDraft();
  draft.guardrails.taintAfterRemoteRead = 'write';
  draft.guardrails.taintRemoteDestination = 'block';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const read = readStudioSource(studioSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.guardrails.taintAfterRemoteRead, 'write');
  assertEquals(read.draft.guardrails.taintRemoteDestination, 'block');
});

Deno.test('an unknown tool type is marked and does not become the draft', () => {
  const draft = createExampleDraft();
  const compiled = compileStudio(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  const source = studioSource(compiled);
  const broken = source.replace("type: 'http'", "type: 'mc'");
  assert(broken !== source);
  const read = readStudioSource(broken, draft);
  assert(!read.ok);
  const error = read.errors[0];
  assert(error);
  assert(error.line > 1);
  assert(error.message.includes('http'));
  assert((broken.split('\n')[error.line - 1] ?? '').includes("type: 'mc'"));
});

Deno.test('an unknown tool type is an issue, not a throw', () => {
  const draft = createExampleDraft();
  draft.toolSpecs = draft.toolSpecs.map((tool, index) =>
    index === 0 ? { ...tool, toolType: 'mc' as typeof tool.toolType } : tool,
  );
  const compiled = compileStudio(draft);
  assert(!compiled.ok);
  assert(
    compiled.issues.some((issue) => issue.field === 'toolType' && issue.message.includes('mcp')),
  );
});

function exampleFile(): { draft: ReturnType<typeof createExampleDraft>; source: string } {
  const draft = createExampleDraft();
  const compiled = compileStudio(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  return { draft, source: studioSource(compiled) };
}

/** The first `registerTool` call, removed. Its name stays in `tools.allow`. */
function withoutFirstCall(source: string, name: string): string {
  const at = source.indexOf(`name: '${name}'`);
  const start = source.lastIndexOf('registerTool(', at);
  const end = source.indexOf(');\n', at);
  return source.slice(0, start) + source.slice(end + 3);
}

Deno.test('leaving a tool out of tools.allow takes it off this agent', () => {
  const { draft, source } = exampleFile();
  const name = 'geocode_city';
  const allowAt = source.indexOf('allow: [');
  const allowEnd = source.indexOf(']', allowAt);
  const allow = source.slice(allowAt, allowEnd).replace(`'${name}',\n`, '');
  const read = readStudioSource(source.slice(0, allowAt) + allow + source.slice(allowEnd), draft);
  if (!read.ok) throw new Error(read.errors.map((error) => error.message).join('\n'));
  assert(!read.draft.toolSpecs.some((tool) => tool.toolName === name));
  assert(read.registered.some((tool) => tool.toolName === name));
  const workspace = workspaceFromDraft(draft);
  const key = workspace.agents[0]?.key;
  assert(key);
  const written = withAgentDraft(workspace, key, read.draft, read.registered);
  const agent = agentDraft(written, key);
  assert(agent);
  assert(!agent.toolSpecs.some((tool) => tool.toolName === name));
  assert(written.toolSpecs.some((tool) => tool.toolName === name));
});

Deno.test('removing the T2 loader from tools.allow clears the loader and still compiles', () => {
  const { draft, source } = exampleFile();
  const name = 'discover_tools';
  const allowAt = source.indexOf('allow: [');
  const allowEnd = source.indexOf(']', allowAt);
  const allow = source.slice(allowAt, allowEnd).replace(`'${name}',\n`, '');
  const read = readStudioSource(source.slice(0, allowAt) + allow + source.slice(allowEnd), draft);
  if (!read.ok) throw new Error(read.errors.map((error) => error.message).join('\n'));
  assertEquals(read.draft.tools.t2Loader, '');
  const again = compileStudio(read.draft);
  assert(again.ok, again.ok ? '' : again.issues.map((issue) => issue.message).join('\n'));
});

Deno.test('a name in tools.allow with no registerTool is marked on that name', () => {
  const { draft, source } = exampleFile();
  const name = 'geocode_city';
  const next = withoutFirstCall(source, name);
  const read = readStudioSource(next, draft);
  assert(!read.ok);
  const error = read.errors[0];
  assert(error);
  assert(error.message.includes(name));
  assert(error.message.includes('registerTool'));
  const line = next.split('\n')[error.line - 1] ?? '';
  assert(line.includes(`'${name}'`));
  assert(!line.includes('name:'));
});

Deno.test('a structured output with streaming and repair settings reads back', () => {
  const draft = createExampleDraft();
  draft.outputs = {
    ...draft.outputs,
    mode: 'structured',
    schemaId: 'trip_plan',
    schemaJson: JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    }),
    streamThoughts: false,
    validationEnabled: true,
    maxRetries: 2,
    itemRules: { stops: 'fix' },
    repairGuidance: 'Return the plan as JSON.',
  };
  roundTrip(draft);
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const read = readStudioSource(studioSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.outputs.mode, 'structured');
  assertEquals(read.draft.outputs.schemaId, 'trip_plan');
  assertEquals(read.draft.outputs.streamThoughts, false);
  assertEquals(read.draft.outputs.validationEnabled, true);
  assertEquals(read.draft.outputs.maxRetries, 2);
  assertEquals(read.draft.outputs.itemRules, { stops: 'fix' });
  assertEquals(read.draft.outputs.repairGuidance, 'Return the plan as JSON.');
});

Deno.test('a continue list the file leaves out opens as the kernel reads it, not as none', () => {
  const compiled = compileStudio(createExampleDraft());
  assert(compiled.ok);
  const source = studioSource(compiled).replace(/\n\s*allowContinue: \[[^\]]*\],/, '');
  const read = readStudioSource(source, createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.turnBehaviour.allowContinue, [
    'length',
    'stream_incomplete',
    'provider_error',
  ]);
  assertEquals(read.draft.turnBehaviour.resumeEnabled, true);
});

Deno.test('a live profile’s session settings read back', () => {
  const draft = setProfileType(createExampleDraft(), 'live');
  draft.live = {
    ...draft.live,
    ingressVideo: !draft.live.ingressVideo,
    sessionResumption: true,
    greeting: 'Greet the visitor.',
    resumedPrompt: 'Say you are back.',
    resumedAfterMs: 5000,
    contextCompression: true,
    compressionTriggerTokens: 20_000,
    compressionTargetTokens: 8_000,
    transcriptionInput: true,
    transcriptionOutput: true,
    vadPrefixPaddingMs: 200,
    vadSilenceDurationMs: 600,
  };
  roundTrip(draft);
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const read = readStudioSource(studioSource(compiled), draft);
  assert(read.ok);
  assertEquals(read.draft.live, draft.live);
});

Deno.test('context and a tool the page answers read back', () => {
  const draft = createExampleDraft();
  draft.inputs = { ...draft.inputs, contextFrom: ['client', 'server'], contextMaxChars: 4000 };
  const at = draft.toolSpecs.findIndex((tool) => tool.toolType === 'function');
  const first = draft.toolSpecs[at];
  assert(first);
  draft.toolSpecs = draft.toolSpecs.map((tool, index) =>
    index === at ? { ...tool, answeredBy: 'page' as const, stubOutputJson: '{"ok":true}' } : tool,
  );
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  const source = studioSource(compiled);
  const read = readStudioSource(source, draft);
  assert(read.ok);
  assertEquals(read.draft.inputs, draft.inputs);
  assertEquals(read.draft.toolSpecs[at]?.answeredBy, 'page');
  assertEquals(read.draft.toolSpecs[at]?.stubOutputJson, '{"ok":true}');
  // The studio's page answers that tool with its stub.
  const pageTools = studioPageTools(compiled);
  assertEquals(Object.keys(pageTools), [first.toolName]);
  assertEquals(pageTools[first.toolName]?.({}, { callId: 'call-1', operationId: 'operation-1' }), {
    output: { ok: true },
  });
});

Deno.test('saved-state mismatch policy survives a Studio source round trip', () => {
  const draft = createExampleDraft();
  draft.models.providerStateMismatch = 'error';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  assert(compiled.profile.type === 'text');
  assertEquals(compiled.profile.providerContinuation, { onMismatch: 'error' });
  const read = readStudioSource(studioSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.models.providerStateMismatch, 'error');
  roundTrip(draft);
});

Deno.test('who holds the conversation survives a Studio source round trip', () => {
  const draft = createExampleDraft();
  draft.models.providerHistory = 'provider';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  assert(compiled.profile.type === 'text');
  assertEquals(compiled.profile.providerContinuation, {
    onMismatch: 'rebuild',
    history: 'provider',
  });
  const read = readStudioSource(studioSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.models.providerHistory, 'provider');
  roundTrip(draft);
});

Deno.test('a stateless profile survives a Studio source round trip', () => {
  const draft = createExampleDraft();
  draft.models.providerHistory = 'stateless';
  const compiled = compileStudio(draft);
  assert(compiled.ok);
  assert(compiled.profile.type === 'text');
  assertEquals(compiled.profile.providerContinuation, {
    onMismatch: 'rebuild',
    history: 'stateless',
  });
  const read = readStudioSource(studioSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.models.providerHistory, 'stateless');
  roundTrip(draft);
});

Deno.test("a provider's file reads back as the provider, and an edit to it is what the provider becomes", () => {
  const house = {
    id: 'house',
    adapter: 'openai-chat',
    connection: { baseURL: 'https://one.example/v1' },
    keySlot: 'team',
  };
  const source = providerSource(house);
  const read = readProviderSource(source, house);
  assert(read.ok);
  assertEquals(read.provider, house);

  const moved = readProviderSource(
    source.replaceAll('openAIChat', 'openRouterAdapter').replace("  keySlot: 'team',\n", ''),
    house,
  );
  assert(moved.ok);
  assertEquals(moved.provider, {
    id: 'house',
    adapter: 'openrouter',
    connection: house.connection,
  });

  // One that opened with no connection reads back with none.
  const bare = { id: 'bare', adapter: 'google', keySlot: 'gemini' };
  const again = readProviderSource(providerSource(bare), bare);
  assert(again.ok);
  assertEquals(again.provider, bare);
});

Deno.test("a provider's file keeps its id, a kernel adapter and only what a provider holds", () => {
  const house = { id: 'house', adapter: 'openrouter', connection: {} };
  const source = providerSource(house);
  const errors = (text: string) => {
    const read = readProviderSource(text, house);
    return read.ok ? [] : read.errors.map((error) => `${String(error.line)}: ${error.message}`);
  };
  assertEquals(errors(source.replace("id: 'house'", "id: 'home'")), [
    "4: The id stays 'house': models and code name the provider by it.",
  ]);
  assertEquals(errors(source.replace('openRouterAdapter()', 'houseAdapter()')), [
    "6: 'houseAdapter' isn't part of a provider's file.",
  ]);
  assertEquals(errors(source.replace('connection: {}', "connection: {}, model: 'x'")), [
    "5: 'model' isn't a provider setting the studio holds.",
  ]);
  assertEquals(errors(`${source}registerProvider(house);\n`), [
    "8: 'registerProvider' isn't part of a provider's file.",
  ]);
  // An agent's file still names no provider of its own.
  const draft = createExampleDraft();
  assertEquals(readStudioSource(source, draft).ok, false);
});
