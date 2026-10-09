/**
 * What the builder changed in the studio, as Save needs it: each profile and
 * tool as it compiled when the project opened and as it compiles now. Both
 * sides go through the studio's own compiler, so a default the project never
 * wrote is the same on both and is not a change.
 *
 * @module
 */

import { z } from 'zod';
import { jsonSchemaFromZod } from '../../src/kernel/tools/schema.ts';
import { compileWorkspace } from '../compile-workspace.ts';
import type { CompiledStudio } from '../compile.ts';
import type { NewSubjects } from './save-new.ts';
import type { ToolRegistration } from '../registrations.ts';
import type { StudioWorkspace } from '../workspace.ts';
import { canonical, type SaveSubject } from './save-plan.ts';
import type { SaveChange } from './save-wire.ts';

/** What the project registers: the ids of its profiles and the names of its tools. */
export interface ProjectNames {
  profiles: readonly string[];
  tools: readonly string[];
}

export type SaveSubjects =
  | { ok: true; subjects: SaveSubject[]; added: NewSubjects; changes: SaveChange[] }
  | { ok: false; issues: string[] };

interface Compiled {
  /** Each agent after the agents it names. */
  agents: CompiledStudio[];
  profiles: Map<string, CompiledStudio['profile']>;
  tools: Map<string, ToolRegistration>;
}

function compiled(workspace: StudioWorkspace): Compiled | string[] {
  const result = compileWorkspace(workspace);
  if (!result.ok) return result.issues.map((issue) => issue.message);
  const tools = new Map<string, ToolRegistration>();
  for (const agent of result.agents) for (const tool of agent.customTools) tools.set(tool.name, tool);
  const profiles = new Map(result.agents.map((agent) => [agent.agentId, agent.profile]));
  return { agents: result.agents, profiles, tools };
}

/** The names of the project's profiles and tools, from the workspace it opened as. */
export function projectNames(opened: StudioWorkspace): ProjectNames {
  return {
    profiles: opened.agents.map((agent) => agent.identity.agentId),
    tools: opened.toolSpecs.map((tool) => tool.toolName),
  };
}

/** The workspace as the project opened it: each agent and tool the project has, at its start. */
function atStart(workspace: StudioWorkspace, names: ProjectNames): StudioWorkspace {
  const { starts } = workspace;
  const agents = Object.values(starts.agents).filter((agent) => names.profiles.includes(agent.identity.agentId));
  const toolSpecs = Object.values(starts.tools).filter((tool) => names.tools.includes(tool.toolName));
  return { ...workspace, agents, toolSpecs };
}

/**
 * The profiles and tools that changed, each before and after, and the ones the studio added.
 * `changes` holds what Save cannot write at all: a profile or tool the studio removed, and a tool
 * it added that no agent allows.
 */
export function saveSubjects(workspace: StudioWorkspace, names: ProjectNames): SaveSubjects {
  const before = compiled(atStart(workspace, names));
  if (Array.isArray(before)) {
    return { ok: false, issues: ['The studio cannot read the project as it opened.', ...before] };
  }
  const after = compiled(workspace);
  if (Array.isArray(after)) return { ok: false, issues: after };

  const subjects: SaveSubject[] = [];
  const changes: SaveChange[] = [];
  const added = { profiles: [] as string[], tools: [] as ToolRegistration[] };
  const seen = { profile: new Set<string>(), tool: new Set<string>() };
  const add = (
    kind: 'profile' | 'tool',
    started: string | undefined,
    now: string,
    known: readonly string[],
    edited: boolean,
  ) => {
    if (started === undefined || !known.includes(started)) {
      const tool = kind === 'tool' ? after.tools.get(now) : undefined;
      if (kind === 'profile') added.profiles.push(now);
      else if (tool) added.tools.push(tool);
      // A tool no agent allows is not compiled, so no run tested it and there is nothing to write.
      else changes.push({ kind, of: now, setting: '', status: 'unused' });
      return;
    }
    seen[kind].add(started);
    const [was, is] = kind === 'profile'
      ? [before.profiles.get(started), after.profiles.get(now)]
      : [before.tools.get(started), after.tools.get(now)];
    // A tool no profile allows on one side is not compiled there, so an edit to it has nothing to compare.
    if (was === undefined || is === undefined) {
      if (edited) changes.push({ kind, of: started, setting: '', status: 'unfound' });
      return;
    }
    subjects.push({ kind, of: started, before: was, after: is });
  };
  for (const agent of workspace.agents) {
    const start = workspace.starts.agents[agent.key];
    add('profile', start?.identity.agentId, agent.identity.agentId.trim(), names.profiles, true);
  }
  for (const tool of workspace.toolSpecs) {
    const start = workspace.starts.tools[tool.key];
    add('tool', start?.toolName, tool.toolName, names.tools, canonical(start) !== canonical(tool));
  }
  for (const id of names.profiles) {
    if (!seen.profile.has(id)) changes.push({ kind: 'profile', of: id, setting: '', status: 'removed' });
  }
  for (const name of names.tools) {
    if (!seen.tool.has(name)) changes.push({ kind: 'tool', of: name, setting: '', status: 'removed' });
  }
  return { ok: true, subjects, added: { agents: after.agents, ...added }, changes };
}

/** A tool with its schemas as the kernel reads them from the file Save writes: zod's reading of the same JSON. */
function asKernelReads(tool: ToolRegistration): ToolRegistration {
  if (tool.type === 'agent') return tool;
  try {
    return {
      ...tool,
      inputSchema: jsonSchemaFromZod(z.fromJSONSchema(tool.inputSchema), 'input'),
      outputSchema: jsonSchemaFromZod(z.fromJSONSchema(tool.outputSchema), 'output'),
    };
  } catch {
    // A schema zod cannot read does not load either: the tool is left to differ.
    return tool;
  }
}

/**
 * What differs between the project as it loads now and the workspace the builder tested: the ids
 * and names that are not the same on both sides. Empty when the file holds what was tested.
 */
export function projectDiffers(loaded: StudioWorkspace, tested: StudioWorkspace): string[] {
  const now = compiled(loaded);
  const wanted = compiled(tested);
  if (Array.isArray(now)) return now;
  if (Array.isArray(wanted)) return wanted;
  const differs: string[] = [];
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const id of new Set([...now.profiles.keys(), ...wanted.profiles.keys()])) {
    if (!same(now.profiles.get(id), wanted.profiles.get(id))) differs.push(id);
  }
  // A file holds a tool's schema as the page does, or as the kernel reads the page's: a tool the
  // studio wrote loads as zod's reading of the JSON the builder tested.
  for (const name of new Set([...now.tools.keys(), ...wanted.tools.keys()])) {
    const [loads, tool] = [now.tools.get(name), wanted.tools.get(name)];
    if (!same(loads, tool) && !(tool && same(loads, asKernelReads(tool)))) differs.push(name);
  }
  return differs;
}
