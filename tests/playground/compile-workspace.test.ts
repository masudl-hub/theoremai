import { assert, assertEquals } from '@std/assert';
import {
  addAgent,
  agentDraft,
  agentNodeId,
  compilePlayground,
  compileWorkspace,
  createBlankDraft,
  createExampleDraft,
  createSpanExampleDraft,
  defaultToolSpec,
  modelBindingNodeId,
  type PlaygroundDraft,
  type PlaygroundIssue,
  type PlaygroundWorkspace,
  playgroundInterface,
  setProfileType,
  type ToolSpecDraft,
  toolSpecNodeId,
  withAgentDraft,
  workspaceFromDraft,
  workspaceRunAgent,
} from '../../playground/mod.ts';
import { playgroundScope } from '../../playground/runtime.ts';

function must<T>(value: T | undefined): T {
  assert(value !== undefined);
  return value;
}

function helperDraft(agentId = 'travel.helper'): PlaygroundDraft {
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
function withTool(workspace: PlaygroundWorkspace, index: number, tool: ToolSpecDraft) {
  const key = must(workspace.agents[index]).key;
  const draft = must(agentDraft(workspace, key));
  return withAgentDraft(workspace, key, { ...draft, toolSpecs: [...draft.toolSpecs, tool] });
}

/** The concierge, then a helper it calls through an agent tool. */
function conciergeCallingHelper(helper = helperDraft()): PlaygroundWorkspace {
  const workspace = addAgent(workspaceFromDraft(createExampleDraft()), helper);
  return withTool(workspace, 0, agentTool(must(workspace.agents[1]).key));
}

function issuesOf(workspace: PlaygroundWorkspace): PlaygroundIssue[] {
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

Deno.test('a run carries the agents its agent needs, and registers them first', () => {
  const result = compileWorkspace(conciergeCallingHelper());
  assert(result.ok);
  const concierge = must(workspaceRunAgent(result, 'travel.concierge'));
  assertEquals(
    concierge.dependencies.map((each) => each.profile.id),
    ['travel.helper'],
  );
  assertEquals(must(workspaceRunAgent(result, 'travel.helper')).dependencies, []);
  assertEquals(workspaceRunAgent(result, 'missing'), undefined);
  const { scope, profile } = playgroundScope(
    concierge.profile,
    concierge.customTools,
    concierge.structured,
    { mode: 'demo' },
    concierge.dependencies,
  );
  assertEquals(profile.id, 'travel.concierge');
  assert(scope.profiles.find('travel.helper'));
  const iface = playgroundInterface(concierge);
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

Deno.test('agents that name each other show the loop on each of them', () => {
  const workspace = conciergeCallingHelper();
  const looped = withTool(
    workspace,
    1,
    agentTool(must(workspace.agents[0]).key, { toolName: 'ask_concierge' }),
  );
  const loops = issuesOf(looped).filter((issue) => issue.message.includes('in a loop'));
  assertEquals(
    loops.map((issue) => issue.nodeId),
    looped.agents.map((agent) => agentNodeId(agent.key)),
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

Deno.test('a single draft names no other agent', () => {
  const result = compilePlayground({ ...helperDraft(), toolSpecs: [agentTool('')] });
  assert(!result.ok);
  assertEquals(must(result.issues[0]).message, 'Pick the agent this tool runs.');
});
