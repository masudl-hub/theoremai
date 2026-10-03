/**
 * Compiles every agent of a workspace and orders them so each is registered
 * after the agents it names: the ones its agent tools run and the one that
 * summarises for it. Issues land on the node of the agent or tool at fault.
 */

import { createKernelScope, defineProfile, TheoremError } from '../mod.ts';
import {
  type AgentIdOf,
  type CompiledPlayground,
  compilePlayground,
  type PlaygroundIssue,
} from './compile.ts';
import type { PlaygroundConnectionMode } from './policy.ts';
import type { PlaygroundDependency } from './runtime-scope.ts';
import { registerPlaygroundTools } from './tools.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';
import {
  type AgentDraft,
  agentDraft,
  agentNodeId,
  type PlaygroundWorkspace,
  scopedNodeId,
} from './workspace.ts';

export interface CompiledWorkspace {
  /** Each agent after the agents it names: the order a scope registers them in. */
  agents: CompiledPlayground[];
}

export type WorkspaceCompileResult =
  | ({ ok: true } & CompiledWorkspace)
  | { ok: false; issues: PlaygroundIssue[] };

/** The agents an agent tool can run, and the one type that can summarise. */
const CALLABLE_TYPES = new Set(['text', 'image', 'speech']);

/** A reference from one agent to another, and the node and field that hold it. */
interface Reference {
  from: AgentDraft;
  to: string;
  nodeId: string;
  field: 'agentKey' | 'compactWith';
}

function references(workspace: PlaygroundWorkspace): Reference[] {
  const tools = new Map(workspace.toolSpecs.map((tool) => [tool.key, tool]));
  return workspace.agents.flatMap((agent) => [
    ...agent.tools.allow.flatMap((key): Reference[] => {
      const tool = tools.get(key);
      return tool?.toolType === 'agent' && tool.agentKey
        ? [{ from: agent, to: tool.agentKey, nodeId: toolSpecNodeId(key), field: 'agentKey' }]
        : [];
    }),
    ...agent.modelBindings.flatMap((binding): Reference[] =>
      binding.compactTiming && binding.compactWith
        ? [{
          from: agent,
          to: binding.compactWith,
          nodeId: agentNodeId(agent.key, modelBindingNodeId(binding.key)),
          field: 'compactWith',
        }]
        : []
    ),
  ]);
}

/** Agents in workspace order, each after the agents it names; the rest are in a loop. */
function registrationOrder(
  workspace: PlaygroundWorkspace,
  refs: readonly Reference[],
): { ordered: AgentDraft[]; looped: AgentDraft[] } {
  const named = new Map(workspace.agents.map((agent) => [agent.key, new Set<string>()]));
  for (const ref of refs) if (named.has(ref.to)) named.get(ref.from.key)?.add(ref.to);
  const done = new Set<string>();
  const ordered: AgentDraft[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const agent of workspace.agents) {
      if (done.has(agent.key)) continue;
      if ([...(named.get(agent.key) ?? [])].every((key) => done.has(key))) {
        done.add(agent.key);
        ordered.push(agent);
        progressed = true;
      }
    }
  }
  return { ordered, looped: workspace.agents.filter((agent) => !done.has(agent.key)) };
}

/** Every issue across the workspace is reported, each once. */
export function compileWorkspace(
  workspace: PlaygroundWorkspace,
  mode: PlaygroundConnectionMode = 'demo',
): WorkspaceCompileResult {
  const issues = new Map<string, PlaygroundIssue>();
  const report = (issue: PlaygroundIssue) => {
    issues.set(JSON.stringify([issue.nodeId, issue.field, issue.index, issue.message]), issue);
  };
  const byKey = new Map(workspace.agents.map((agent) => [agent.key, agent]));
  const agentIdOf: AgentIdOf = (key) => byKey.get(key)?.identity.agentId.trim();

  const ids = new Set<string>();
  for (const agent of workspace.agents) {
    const id = agent.identity.agentId.trim();
    if (id && ids.has(id)) {
      report({
        nodeId: agentNodeId(agent.key),
        message: `Another agent has the id '${id}'.`,
        field: 'agentId',
      });
    }
    ids.add(id);
  }
  const names = new Set<string>();
  for (const tool of workspace.toolSpecs) {
    const name = tool.toolName.trim();
    if (name && names.has(name)) {
      report({
        nodeId: toolSpecNodeId(tool.key),
        message: `Tool name '${name}' is used twice.`,
        field: 'toolName',
      });
    }
    names.add(name);
  }

  const refs = references(workspace);
  for (const ref of refs) {
    const target = byKey.get(ref.to);
    const type = target?.identity.profileType;
    if (!target || !type) continue;
    const id = target.identity.agentId.trim();
    if (ref.field === 'agentKey' && !CALLABLE_TYPES.has(type)) {
      report({
        nodeId: ref.nodeId,
        message: `'${id}' is a ${type} agent. An agent tool runs a text, image or speech agent.`,
        field: ref.field,
      });
    }
    if (ref.field === 'compactWith' && type !== 'text') {
      report({
        nodeId: ref.nodeId,
        message: `'${id}' is a ${type} agent. Only a text agent summarises.`,
        field: ref.field,
      });
    }
  }
  const { ordered, looped } = registrationOrder(workspace, refs);
  for (const agent of looped) {
    report({
      nodeId: agentNodeId(agent.key),
      message: `These agents name each other in a loop: ${
        looped.map((each) => `'${each.identity.agentId.trim()}'`).join(', ')
      }. An agent can only name agents that don't name it back.`,
    });
  }

  const compiled: { key: string; agent: CompiledPlayground }[] = [];
  for (const agent of [...ordered, ...looped]) {
    const draft = agentDraft(workspace, agent.key);
    const result = draft && compilePlayground(draft, mode, agentIdOf);
    if (!result) continue;
    if (result.ok) {
      const { ok: _ok, ...rest } = result;
      compiled.push({ key: agent.key, agent: rest });
      continue;
    }
    for (const issue of result.issues) {
      report({ ...issue, nodeId: scopedNodeId(agent.key, issue.nodeId) });
    }
  }
  if (issues.size) return { ok: false, issues: [...issues.values()] };

  // The kernel's own rules across agents, such as an agent tool's agent that can stop on a gate.
  const scope = createKernelScope();
  for (const { key, agent } of compiled) {
    try {
      registerPlaygroundTools(scope.tools, agent.customTools);
      scope.profiles.register(defineProfile(agent.profile));
    } catch (err) {
      if (!(err instanceof TheoremError)) throw err;
      return { ok: false, issues: [{ nodeId: agentNodeId(key), message: err.message }] };
    }
  }
  return { ok: true, agents: compiled.map(({ agent }) => agent) };
}

/**
 * The agent `agentId`, with the agents it needs as its dependencies, each after
 * the ones it names: what a run registers. `undefined` when no compiled agent has that id.
 */
export function workspaceRunAgent(
  compiled: CompiledWorkspace,
  agentId: string,
): (CompiledPlayground & { dependencies: PlaygroundDependency[] }) | undefined {
  const byId = new Map(compiled.agents.map((agent) => [agent.agentId, agent]));
  const chatted = byId.get(agentId);
  if (!chatted) return undefined;
  const needed = new Set<string>();
  const visit = (id: string) => {
    const agent = byId.get(id);
    if (!agent || needed.has(id)) return;
    needed.add(id);
    for (const named of namedAgents(agent)) visit(named);
  };
  for (const named of namedAgents(chatted)) visit(named);
  needed.delete(agentId);
  const dependencies = compiled.agents
    .filter((agent) => needed.has(agent.agentId))
    .map(({ profile, customTools, structured }) => ({
      profile,
      customTools,
      ...(structured ? { structured } : {}),
    }));
  return { ...chatted, dependencies };
}

/** The agent ids a compiled agent names: its agent tools' and its compaction's. */
function namedAgents(agent: CompiledPlayground): string[] {
  const tools = agent.customTools.flatMap((tool) => (tool.type === 'agent' ? [tool.profile] : []));
  const models = 'models' in agent.profile ? Object.values(agent.profile.models) : [];
  const compactors = models.flatMap((binding) =>
    binding.compaction?.profile ? [binding.compaction.profile] : []
  );
  return [...tools, ...compactors];
}
