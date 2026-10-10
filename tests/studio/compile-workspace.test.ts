import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  agentDraft,
  agentNodeId,
  compileStudio,
  compileWorkspace,
  createBlankDraft,
  createExampleDraft,
  createSpanExampleDraft,
  defaultToolSpec,
  includeFacet,
  modelBindingNodeId,
  removeAgent,
  type StudioDraft,
  type StudioIssue,
  type StudioWorkspace,
  setProfileType,
  studioInterface,
  type ToolSpecDraft,
  toolSpecNodeId,
  withAgentDraft,
  workspaceFromDraft,
  workspaceRunAgent,
  workspaceSource,
} from '../../studio/mod.ts';
import { studioScope } from '../../studio/runtime.ts';

function must<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

function helperDraft(agentId = 'travel.helper'): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'text');
  return { ...draft, identity: { ...draft.identity, agentId, handle: 'helper' } };
}

function agentTool(agentKey: string, partial: Partial<ToolSpecDraft> = {}): ToolSpecDraft {
  return defaultToolSpec({
    toolName: 'ask_helper',
    toolType: 'agent',
    description: 'Asks the helper.',
    agentKey,
    ...partial,
  });
}

/** Gives agent `index` the tool, through its draft as an editor would. */
function withTool(workspace: StudioWorkspace, index: number, tool: ToolSpecDraft) {
  const key = must(workspace.agents[index]).key;
  const draft = must(agentDraft(workspace, key));
  return withAgentDraft(workspace, key, { ...draft, toolSpecs: [...draft.toolSpecs, tool] });
}

/** The concierge, then a helper it calls through an agent tool. */
function conciergeCallingHelper(helper = helperDraft()): StudioWorkspace {
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), helper);
  return withTool(workspace, 0, agentTool(must(workspace.agents[1]).key));
}

function issuesOf(workspace: StudioWorkspace): StudioIssue[] {
  const result = compileWorkspace(workspace);
  assert(!result.ok, 'expected issues');
  return result.issues;
}

Deno.test('an agent is registered after the agent its tool runs, whatever the tree order', () => {
  const result = compileWorkspace(conciergeCallingHelper());
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  assertEquals(
    result.agents.map((agent) => agent.agentId),
    ['travel.helper', 'travel.concierge'],
  );
  const tool = must(must(result.agents[1]).customTools.find((each) => each.name === 'ask_helper'));
  assertEquals(tool.type === 'agent' && tool.profile, 'travel.helper');
  assertEquals(tool.inputSchema.required, ['text']);
});

Deno.test('a run carries the agents its agent needs, and registers them first', async () => {
  const result = compileWorkspace(conciergeCallingHelper());
  assert(result.ok);
  const concierge = must(workspaceRunAgent(result, 'travel.concierge'));
  assertEquals(
    concierge.dependencies.map((each) => each.profile.id),
    ['travel.helper'],
  );
  assertEquals(must(workspaceRunAgent(result, 'travel.helper')).dependencies, []);
  assertEquals(workspaceRunAgent(result, 'missing'), undefined);
  const { scope, profile } = await studioScope(
    concierge.profile,
    concierge.customTools,
    concierge.structured,
    { mode: 'demo' },
    concierge.dependencies,
  );
  assertEquals(profile.id, 'travel.concierge');
  assert(scope.profiles.find('travel.helper'));
  const iface = studioInterface(concierge);
  assert(iface.type === 'text' && iface.tools.allow.includes('ask_helper'));
});

Deno.test('an agent tool naming a removed agent shows on the tool', () => {
  const workspace = withTool(workspaceFromDraft(createExampleDraft()), 0, agentTool('gone'));
  const tool = must(workspace.toolSpecs.at(-1));
  assertEquals(
    issuesOf(workspace).filter((issue) => issue.field === 'agentKey'),
    [
      {
        nodeId: toolSpecNodeId(tool.key),
        message: 'The agent this tool ran is gone. Pick another.',
        field: 'agentKey',
      },
    ],
  );
});

Deno.test('an agent tool runs only a text, image or speech agent', () => {
  const issues = issuesOf(conciergeCallingHelper(createSpanExampleDraft()));
  assert(
    issues.some(
      (issue) =>
        issue.field === 'agentKey' &&
        issue.message.startsWith("'guardrails.tool_call.span' is a decision agent"),
    ),
    JSON.stringify(issues),
  );
});

Deno.test('agents that run each other show the circle on each tool, saying how to break it', () => {
  const workspace = conciergeCallingHelper();
  const [concierge] = workspace.agents;
  const looped = withTool(
    workspace,
    1,
    agentTool(must(concierge).key, { toolName: 'ask_concierge' }),
  );
  const circles = issuesOf(looped).filter((issue) => issue.message.includes('in a circle'));
  const toolKey = (name: string) =>
    must(looped.toolSpecs.find((tool) => tool.toolName === name)).key;
  assertEquals(
    circles.map((issue) => [issue.nodeId, issue.field]),
    [
      [toolSpecNodeId(toolKey('ask_helper')), 'agentKey'],
      [toolSpecNodeId(toolKey('ask_concierge')), 'agentKey'],
    ],
  );
  assertEquals(
    circles[0]?.message,
    "'travel.concierge' has this tool on, and it runs 'travel.helper', which leads back to 'travel.concierge' (travel.concierge → travel.helper → travel.concierge). Agents can't run each other in a circle: turn this tool off for 'travel.concierge', or remove the way back.",
  );
});

Deno.test('an agent with a tool that runs itself is told to pick another agent or turn the tool off', () => {
  const workspace = conciergeCallingHelper();
  const concierge = must(workspace.agents[0]);
  const self = withTool(workspace, 0, agentTool(concierge.key, { toolName: 'ask_myself' }));
  const issue = must(issuesOf(self).find((each) => each.field === 'agentKey'));
  assertEquals(
    issue.message,
    "'travel.concierge' has this tool on, and the tool runs 'travel.concierge' itself. Choose another agent for it to run, or turn it off for 'travel.concierge'.",
  );
});

Deno.test('compaction can name another text agent, which registers first', () => {
  const base = addAgent(
    workspaceFromDraft(helperDraft('travel.chat')),
    helperDraft('travel.summariser'),
  );
  const [chat, summariser] = base.agents.map((agent) => agent.key);
  const draft = must(agentDraft(base, must(chat)));
  const binding = must(draft.modelBindings[0]);
  const compacting = (compactWith: string) =>
    withAgentDraft(base, must(chat), {
      ...draft,
      modelBindings: [
        {
          ...binding,
          compactTiming: 'before',
          compactMaxTokens: 32_000,
          compactAt: 0.75,
          compactKeep: 4,
          compactWith,
        },
      ],
    });
  const result = compileWorkspace(compacting(must(summariser)));
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
  assertEquals(
    result.agents.map((agent) => agent.agentId),
    ['travel.summariser', 'travel.chat'],
  );
  const models = must(result.agents[1]).profile;
  assert('models' in models);
  assertEquals(Object.values(models.models)[0]?.compaction?.profile, 'travel.summariser');
  assertEquals(must(workspaceRunAgent(result, 'travel.chat')).dependencies.length, 1);

  assertEquals(
    issuesOf(compacting('gone')).find((issue) => issue.field === 'compactWith')?.nodeId,
    agentNodeId(must(chat), modelBindingNodeId(binding.key)),
  );
});

Deno.test('agent ids and library tool names are unique across the workspace', () => {
  const added = addAgent(workspaceFromDraft(helperDraft()), helperDraft('travel.other'));
  const second = must(added.agents[1]).key;
  const workspace = withAgentDraft(added, second, helperDraft());
  const issues = issuesOf(
    withTool(withTool(workspace, 0, defaultToolSpec()), 1, defaultToolSpec()),
  );
  assert(issues.some((issue) => issue.message === "Another agent has the id 'travel.helper'."));
  assert(issues.some((issue) => issue.message === "Tool name 'my_tool' is used twice."));
});

Deno.test("the kernel's rule shows on the calling agent: the agent it runs can't gate", () => {
  const gated = withTool(
    addAgent(workspaceFromDraft(createExampleDraft()), helperDraft()),
    1,
    defaultToolSpec({ toolName: 'confirm_me', permission: 'always_confirm' }),
  );
  const workspace = withTool(gated, 0, agentTool(must(gated.agents[1]).key));
  const issues = issuesOf(workspace);
  assertEquals(issues.length, 1, JSON.stringify(issues));
  assertEquals(must(issues[0]).nodeId, agentNodeId(must(workspace.agents[0]).key));
  assert(must(issues[0]).message.includes("its tool 'confirm_me' can stop on a gate"));
});

Deno.test('an agent whose reply follows a schema compiles, with the schema beside it', () => {
  const helper = includeFacet(helperDraft(), 'outputs');
  const result = compileWorkspace(
    workspaceFromDraft({
      ...helper,
      outputs: {
        ...helper.outputs,
        mode: 'structured',
        schemaId: 'helper.reply',
        schemaJson:
          '{"type":"object","properties":{"reply":{"type":"string"}},"required":["reply"]}',
      },
    }),
  );
  assert(result.ok, result.ok ? '' : must(result.issues[0]).message);
  assertEquals(must(result.agents[0]).structured?.id, 'helper.reply');
});

Deno.test('a single draft names no other agent', () => {
  const result = compileStudio({ ...helperDraft(), toolSpecs: [agentTool('')] });
  assert(!result.ok);
  assertEquals(must(result.issues[0]).message, 'Pick the agent this tool runs.');
});

Deno.test('removing an agent leaves nothing pointing at it', () => {
  const calling = conciergeCallingHelper();
  const [concierge, helper] = calling.agents.map((agent) => must(agent).key);
  const draft = must(agentDraft(calling, must(concierge)));
  const binding = must(draft.modelBindings[0]);
  const workspace = withAgentDraft(calling, must(concierge), {
    ...draft,
    modelBindings: [
      {
        ...binding,
        compactTiming: 'before',
        compactMaxTokens: 32_000,
        compactAt: 0.75,
        compactKeep: 4,
        compactWith: must(helper),
      },
      ...draft.modelBindings.slice(1),
    ],
  });
  const removed = removeAgent(workspace, must(helper));
  assert(!removed.toolSpecs.some((tool) => tool.toolName === 'ask_helper'));
  assertEquals(must(removed.agents[0]).modelBindings[0]?.compactWith, undefined);
  const result = compileWorkspace(removed);
  assert(result.ok, JSON.stringify(!result.ok && result.issues));
});

Deno.test('a workspace exports as tools.ts, a module per agent, and theorem.ts in registration order', () => {
  const result = compileWorkspace(conciergeCallingHelper());
  assert(result.ok);
  const files = workspaceSource(result);
  assertEquals(
    files.map((file) => file.path),
    ['tools.ts', 'agents/travel.helper.ts', 'agents/travel.concierge.ts', 'theorem.ts'],
  );
  const code = (path: string) => must(files.find((file) => file.path === path)).code;
  // The agent tool needs its agent: it is registered in theorem.ts, between the two.
  assert(!code('tools.ts').includes("name: 'ask_helper'"));
  const theorem = code('theorem.ts');
  const at = (text: string) => {
    const index = theorem.indexOf(text);
    assert(index >= 0, text);
    return index;
  };
  assert(at('registerToolLibrary();') < at('registerProfile(travelHelper.profile);'));
  assert(at('registerProfile(travelHelper.profile);') < at("name: 'ask_helper'"));
  assert(at("name: 'ask_helper'") < at('registerProfile(travelConcierge.profile);'));
  assert(!code('agents/travel.concierge.ts').includes('register'));
});

Deno.test('an exported workspace type-checks and registers when theorem.ts runs', async () => {
  const result = compileWorkspace(conciergeCallingHelper());
  assert(result.ok);
  const root = new URL('../../', import.meta.url);
  const dir = await Deno.makeTempDir();
  try {
    for (const file of workspaceSource(result)) {
      const path = `${dir}/${file.path}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      // The package as the export names it, resolved to this checkout.
      const local = file.code.replaceAll(
        "'@theoremjs/agents'",
        `'${new URL('mod.ts', root).href}'`,
      );
      await Deno.writeTextFile(path, local);
    }
    await Deno.writeTextFile(
      `${dir}/main.ts`,
      "import './theorem';\nimport { getProfile } from '" +
        new URL('mod.ts', root).href +
        "';\nconsole.log(getProfile('travel.concierge').id);\n",
    );
    const config = new URL('deno.json', root).pathname;
    const flags = ['--config', config, '--unstable-sloppy-imports', '--quiet'];
    const check = await new Deno.Command(Deno.execPath(), {
      args: ['check', ...flags, `${dir}/main.ts`],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(check.success, new TextDecoder().decode(check.stderr));
    const run = await new Deno.Command(Deno.execPath(), {
      args: ['run', '-A', ...flags, `${dir}/main.ts`],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assert(run.success, new TextDecoder().decode(run.stderr));
    assertEquals(new TextDecoder().decode(run.stdout).trim(), 'travel.concierge');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
