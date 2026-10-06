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
  uncompiled,
} from './compile.ts';
import type { PlaygroundConnectionMode } from './policy.ts';
import { type PlaygroundDependency, registerDefined } from './runtime-scope.ts';
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

/** Each agent's key, to the keys of the agents it names. */
function namedBy(workspace: PlaygroundWorkspace, refs: readonly Reference[]): Map<string, Set<string>> {
  const named = new Map(workspace.agents.map((agent) => [agent.key, new Set<string>()]));
  for (const ref of refs) if (named.has(ref.to)) named.get(ref.from.key)?.add(ref.to);
  return named;
}

/** The agents from `start` to `end`, each naming the next; undefined when `start` never reaches `end`. */
function chain(named: Map<string, Set<string>>, start: string, end: string): string[] | undefined {
  // Each agent reached, to the one it was reached from.
  const via = new Map<string, string | undefined>([[start, undefined]]);
  const queue = [start];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (key === end) {
      const path: string[] = [];
      for (let at: string | undefined = key; at !== undefined; at = via.get(at)) path.unshift(at);
      return path;
    }
    for (const next of named.get(key) ?? []) {
      if (!via.has(next)) {
        via.set(next, key);
        queue.push(next);
      }
    }
  }
  return undefined;
}

/**
 * Where a reference closes a circle, what it is and how to break it. Each agent
 * must be set up after the agents it names, so a circle has no first one.
 */
function circleMessage(ref: Reference, path: readonly string[], idOf: AgentIdOf): string {
  const from = `'${idOf(ref.from.key) ?? ''}'`;
  const to = `'${idOf(ref.to) ?? ''}'`;
  if (ref.from.key === ref.to) {
    return ref.field === 'agentKey'
      ? `${from} has this tool on, and the tool runs ${from} itself. Choose another agent for it to run, or turn it off for ${from}.`
      : `${from} can't summarise its own conversation. Choose another text agent.`;
  }
  const circle = [ref.from.key, ...path].map((key) => idOf(key) ?? '').join(' → ');
  return ref.field === 'agentKey'
    ? `${from} has this tool on, and it runs ${to}, which leads back to ${from} (${circle}). Agents can't run each other in a circle: turn this tool off for ${from}, or remove the way back.`
    : `${to} summarises for ${from}, and ${to} leads back to ${from} (${circle}). Agents can't run each other in a circle: choose another agent to summarise, or remove the way back.`;
}

/** Agents in workspace order, each after the agents it names; the rest are in a loop. */
function registrationOrder(
  workspace: PlaygroundWorkspace,
  named: Map<string, Set<string>>,
): { ordered: AgentDraft[]; looped: AgentDraft[] } {
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

type Report = (issue: PlaygroundIssue) => void;

/** An id two agents share, or a tool name two tools share, is an issue on each after the first. */
function reportDuplicates(workspace: PlaygroundWorkspace, report: Report): void {
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
}

/** Why the agent a reference names can't do its job; undefined when it can, or isn't set up. */
function wrongTypeMessage(ref: Reference, target: AgentDraft | undefined): string | undefined {
  const type = target?.identity.profileType;
  if (!target || !type) return undefined;
  const id = target.identity.agentId.trim();
  if (ref.field === 'agentKey' && !CALLABLE_TYPES.has(type)) {
    return `'${id}' is a ${type} agent. An agent tool runs a text, image or speech agent.`;
  }
  if (ref.field === 'compactWith' && type !== 'text') {
    return `'${id}' is a ${type} agent. Only a text agent summarises.`;
  }
  return undefined;
}

/** Each agent's own compile, in registration order; an agent's issues land under its node. */
function compileAgents(
  workspace: PlaygroundWorkspace,
  agents: readonly AgentDraft[],
  mode: PlaygroundConnectionMode,
  agentIdOf: AgentIdOf,
  report: Report,
): { key: string; agent: CompiledPlayground }[] {
  const compiled: { key: string; agent: CompiledPlayground }[] = [];
  for (const agent of agents) {
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
  return compiled;
}

/**
 * The kernel's own rules across agents, such as an agent tool's agent that can stop on a gate:
 * the first agent a scope refuses, as an issue on that agent.
 */
function kernelIssue(
  compiled: readonly { key: string; agent: CompiledPlayground }[],
): PlaygroundIssue | undefined {
  const scope = createKernelScope();
  for (const { key, agent } of compiled) {
    try {
      registerDefined(
        scope,
        defineProfile(uncompiled(agent.profile)),
        agent.customTools,
        agent.structured,
      );
    } catch (err) {
      if (!(err instanceof TheoremError)) throw err;
      return { nodeId: agentNodeId(key), message: err.message };
    }
  }
  return undefined;
}

/** Every issue across the workspace is reported, each once. */
export function compileWorkspace(
  workspace: PlaygroundWorkspace,
  mode: PlaygroundConnectionMode = 'demo',
): WorkspaceCompileResult {
  const issues = new Map<string, PlaygroundIssue>();
  const report: Report = (issue) => {
    issues.set(JSON.stringify([issue.nodeId, issue.field, issue.index, issue.message]), issue);
  };
  const byKey = new Map(workspace.agents.map((agent) => [agent.key, agent]));
  const agentIdOf: AgentIdOf = (key) => byKey.get(key)?.identity.agentId.trim();

  reportDuplicates(workspace, report);
  const refs = references(workspace);
  for (const ref of refs) {
    const message = wrongTypeMessage(ref, byKey.get(ref.to));
    if (message) report({ nodeId: ref.nodeId, message, field: ref.field });
  }
  const named = namedBy(workspace, refs);
  const { ordered, looped } = registrationOrder(workspace, named);
  // Each reference that closes a circle is an issue on the field that holds it.
  for (const ref of refs) {
    const path = chain(named, ref.to, ref.from.key);
    if (path) report({ nodeId: ref.nodeId, field: ref.field, message: circleMessage(ref, path, agentIdOf) });
  }

  const compiled = compileAgents(workspace, [...ordered, ...looped], mode, agentIdOf, report);
  if (issues.size) return { ok: false, issues: [...issues.values()] };
  const refused = kernelIssue(compiled);
  if (refused) return { ok: false, issues: [refused] };
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
