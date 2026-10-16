/**
 * What the builder changed in the studio, as Save needs it: each profile and
 * tool as it compiled when the project opened and as it compiles now. Both
 * sides go through the studio's own compiler, so a default the project never
 * wrote is the same on both and is not a change. A provider is not compiled:
 * it is what it opened as and what it holds now.
 *
 * @module
 */

import { z } from 'zod';
import { jsonSchemaFromZod } from '@theoremjs/agents/kernel';
import { compileWorkspace } from '../compile-workspace.ts';
import { ON_OWN_KEYS } from '../lent-keys.ts';
import type { CompiledStudio } from '../compile.ts';
import { unheldConnection, unheldProblem } from '../held-credentials.ts';
import { withoutStudioFills } from '../policy.ts';
import type { StudioProvider } from '../providers.ts';
import type { NewSubjects } from './save-new.ts';
import type { Removed } from './save-remove.ts';
import type { ToolRegistration } from '../registrations.ts';
import type { StudioWorkspace } from '../workspace.ts';
import { canonical } from '../canonical.ts';
import type { SaveSubject } from './save-plan.ts';
import type { SaveChange } from './save-wire.ts';

/** What the project registers: the ids of its profiles and providers, and the names of its tools. */
export interface ProjectNames {
  profiles: readonly string[];
  tools: readonly string[];
  providers: readonly string[];
}

export type SaveSubjects =
  | { ok: true; subjects: SaveSubject[]; added: NewSubjects; removed: Removed; changes: SaveChange[] }
  | { ok: false; issues: string[] };

interface Compiled {
  /** Each agent after the agents it names. */
  agents: CompiledStudio[];
  profiles: Map<string, CompiledStudio['profile']>;
  /** What each decision profile is asked, by profile id. */
  asked: Map<string, CompiledStudio['questions']>;
  tools: Map<string, ToolRegistration>;
  providers: Map<string, ReturnType<typeof providerSettings>>;
}

/**
 * What Save writes of a provider: its definition, what it connects with and its key slots, as the
 * fields its definition holds them in. Its id is what code and models name it by, so it stays.
 * Every definition holds a connection, so one the page leaves out is written as an empty one.
 */
export function providerSettings(provider: StudioProvider): Omit<StudioProvider, 'id'> {
  const { id: _id, connection = {}, ...settings } = provider;
  return { ...settings, connection };
}

function compiled(workspace: StudioWorkspace): Compiled | string[] {
  // As the project's own: which models the studio's keys may call is a rule for a run, not for a file.
  const result = compileWorkspace(workspace, ON_OWN_KEYS);
  if (!result.ok) return result.issues.map((issue) => issue.message);
  const tools = new Map<string, ToolRegistration>();
  for (const agent of result.agents) for (const tool of agent.customTools) tools.set(tool.name, tool);
  // A file holds the profile without the studio's own fill-ins, so Save never writes them.
  const profiles = new Map(result.agents.map((agent) => [agent.agentId, withoutStudioFills(agent.profile)]));
  const asked = new Map(result.agents.map((agent) => [agent.agentId, agent.questions]));
  const providers = new Map(workspace.providers.map((provider) => [provider.id, providerSettings(provider)]));
  return { agents: result.agents, profiles, asked, tools, providers };
}

/** The names of the project's profiles and tools, from the workspace it opened as. */
export function projectNames(opened: StudioWorkspace): ProjectNames {
  return {
    profiles: opened.agents.map((agent) => agent.identity.agentId),
    tools: opened.toolSpecs.map((tool) => tool.toolName),
    providers: opened.providers.map((provider) => provider.id),
  };
}

/** The workspace as the project opened it: each agent, tool and provider the project has, at its start. */
function atStart(workspace: StudioWorkspace, names: ProjectNames): StudioWorkspace {
  const { starts } = workspace;
  const agents = Object.values(starts.agents).filter((agent) => names.profiles.includes(agent.identity.agentId));
  const toolSpecs = Object.values(starts.tools).filter((tool) => names.tools.includes(tool.toolName));
  const providers = Object.values(starts.providers).filter((provider) => names.providers.includes(provider.id));
  return { ...workspace, agents, toolSpecs, providers };
}

/**
 * The profiles, tools and providers that changed, each before and after, the ones the studio added,
 * and the ones it removed. `changes` holds what Save cannot write at all: a tool the studio added that no
 * agent allows, and an edit to a tool no agent allows.
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
  const added = { profiles: [] as string[], tools: [] as ToolRegistration[], providers: [] as StudioProvider[] };
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
  for (const provider of workspace.providers) {
    // One the project does not have was added here: Save writes its definition.
    if (!names.providers.includes(provider.id)) {
      added.providers.push(provider);
      continue;
    }
    const start = before.providers.get(provider.id);
    if (!start) {
      changes.push({ kind: 'provider', of: provider.id, setting: '', status: 'unfound' });
      continue;
    }
    const after = providerSettings(provider);
    if (canonical(start) === canonical(after)) continue;
    subjects.push({ kind: 'provider', of: provider.id, before: start, after });
  }
  // A mask the page sends that it was not given has no value to run or to save with.
  const unheld = [
    ...workspace.providers.map((provider) => unheldConnection(provider.id, provider.connection)),
    ...subjects.filter((subject) => subject.kind === 'tool').map((subject) =>
      unheldProblem(subject.of, subject.after as ToolRegistration, subject.before as ToolRegistration)
    ),
    ...added.tools.map((tool) => unheldProblem(tool.name, tool)),
  ].filter((problem) => problem !== undefined);
  if (unheld.length) return { ok: false, issues: unheld };
  const removed = {
    profiles: names.profiles.filter((id) => !seen.profile.has(id)),
    tools: names.tools.filter((name) => !seen.tool.has(name)),
    providers: names.providers.filter((id) => !workspace.providers.some((provider) => provider.id === id)),
  };
  return { ok: true, subjects, added: { agents: after.agents, ...added }, removed, changes };
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

/** A load of the project as the studio shows it once these are removed: what is left of it. */
export function withoutRemoved(loaded: StudioWorkspace, removed: Removed): StudioWorkspace {
  return {
    ...loaded,
    agents: loaded.agents.filter((agent) => !removed.profiles.includes(agent.identity.agentId)),
    toolSpecs: loaded.toolSpecs.filter((tool) => !removed.tools.includes(tool.toolName)),
    providers: loaded.providers.filter((provider) => !removed.providers.includes(provider.id)),
  };
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
    // A decision is its profile and what it is asked: the files must hold both as tested.
    const held = same(now.profiles.get(id), wanted.profiles.get(id)) && same(now.asked.get(id), wanted.asked.get(id));
    if (!held) differs.push(id);
  }
  // A file holds a tool's schema as the page does, or as the kernel reads the page's: a tool the
  // studio wrote loads as zod's reading of the JSON the builder tested. A schema Save changed in
  // its Zod holds both, part by part, so the two are the same once zod has read each.
  for (const name of new Set([...now.tools.keys(), ...wanted.tools.keys()])) {
    const [loads, tool] = [now.tools.get(name), wanted.tools.get(name)];
    if (same(loads, tool) || !tool || !loads) {
      if (!same(loads, tool)) differs.push(name);
      continue;
    }
    const read = asKernelReads(tool);
    if (!same(loads, read) && !same(asKernelReads(loads), read)) differs.push(name);
  }
  for (const id of new Set([...now.providers.keys(), ...wanted.providers.keys()])) {
    if (!same(now.providers.get(id), wanted.providers.get(id))) differs.push(id);
  }
  return differs;
}
