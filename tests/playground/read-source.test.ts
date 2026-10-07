import { assert, assertEquals } from '@std/assert';
import {
  agentDraft,
  compilePlayground,
  createDecisionExampleDraft,
  createExampleDraft,
  playgroundSource,
  readPlaygroundSource,
  setProfileType,
  withAgentDraft,
  workspaceFromDraft,
} from '../../playground/mod.ts';

/** The file the printer emits, read back, prints as the same file. */
function roundTrip(draft: ReturnType<typeof createExampleDraft>): void {
  const compiled = compilePlayground(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  const source = playgroundSource(compiled);
  const read = readPlaygroundSource(source, draft);
  if (!read.ok) {
    throw new Error(
      read.errors.map((error) => `${error.line}:${error.column} ${error.message}`).join('\n'),
    );
  }
  const again = compilePlayground(read.draft);
  assert(again.ok, again.ok ? '' : again.issues.map((issue) => issue.message).join('\n'));
  const printed = playgroundSource(again);
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

Deno.test('the decision example file reads back into the same file', () => {
  roundTrip(createDecisionExampleDraft());
});

Deno.test('both taint settings in the file come back into the draft', () => {
  const draft = createExampleDraft();
  draft.guardrails.taintAfterRemoteRead = 'write';
  draft.guardrails.taintRemoteDestination = 'block';
  const compiled = compilePlayground(draft);
  assert(compiled.ok);
  const read = readPlaygroundSource(playgroundSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.guardrails.taintAfterRemoteRead, 'write');
  assertEquals(read.draft.guardrails.taintRemoteDestination, 'block');
});

Deno.test('an unknown tool type is marked and does not become the draft', () => {
  const draft = createExampleDraft();
  const compiled = compilePlayground(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  const source = playgroundSource(compiled);
  const broken = source.replace("type: 'http'", "type: 'mc'");
  assert(broken !== source);
  const read = readPlaygroundSource(broken, draft);
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
  const compiled = compilePlayground(draft);
  assert(!compiled.ok);
  assert(
    compiled.issues.some((issue) => issue.field === 'toolType' && issue.message.includes('mcp')),
  );
});

function exampleFile(): { draft: ReturnType<typeof createExampleDraft>; source: string } {
  const draft = createExampleDraft();
  const compiled = compilePlayground(draft);
  assert(compiled.ok, compiled.ok ? '' : compiled.issues.map((issue) => issue.message).join('\n'));
  return { draft, source: playgroundSource(compiled) };
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
  const read = readPlaygroundSource(
    source.slice(0, allowAt) + allow + source.slice(allowEnd),
    draft,
  );
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
  const read = readPlaygroundSource(
    source.slice(0, allowAt) + allow + source.slice(allowEnd),
    draft,
  );
  if (!read.ok) throw new Error(read.errors.map((error) => error.message).join('\n'));
  assertEquals(read.draft.tools.t2Loader, '');
  const again = compilePlayground(read.draft);
  assert(again.ok, again.ok ? '' : again.issues.map((issue) => issue.message).join('\n'));
});

Deno.test('a name in tools.allow with no registerTool is marked on that name', () => {
  const { draft, source } = exampleFile();
  const name = 'geocode_city';
  const next = withoutFirstCall(source, name);
  const read = readPlaygroundSource(next, draft);
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
    repairGuidance: 'Return the plan as JSON.',
  };
  roundTrip(draft);
  const compiled = compilePlayground(draft);
  assert(compiled.ok);
  const read = readPlaygroundSource(playgroundSource(compiled), createExampleDraft());
  assert(read.ok);
  assertEquals(read.draft.outputs.mode, 'structured');
  assertEquals(read.draft.outputs.schemaId, 'trip_plan');
  assertEquals(read.draft.outputs.streamThoughts, false);
  assertEquals(read.draft.outputs.validationEnabled, true);
  assertEquals(read.draft.outputs.maxRetries, 2);
  assertEquals(read.draft.outputs.repairGuidance, 'Return the plan as JSON.');
});

Deno.test('a live profile’s session settings read back', () => {
  const draft = setProfileType(createExampleDraft(), 'live');
  draft.live = {
    ...draft.live,
    ingressVideo: !draft.live.ingressVideo,
    sessionResumption: true,
    contextCompression: true,
    compressionTriggerTokens: 20_000,
    compressionTargetTokens: 8_000,
    transcriptionInput: true,
    transcriptionOutput: true,
    vadPrefixPaddingMs: 200,
    vadSilenceDurationMs: 600,
  };
  roundTrip(draft);
  const compiled = compilePlayground(draft);
  assert(compiled.ok);
  const read = readPlaygroundSource(playgroundSource(compiled), draft);
  assert(read.ok);
  assertEquals(read.draft.live, draft.live);
});
