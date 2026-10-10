/**
 * A change to a value the project's files write once, made on every agent
 * that shares it. The files hold one value, so the workspace does too.
 *
 * @module
 */

import { compileWorkspace } from './compile-workspace.ts';
import { draftKey, type ModelBindingDraft } from './draft.ts';
import type { SettingSite } from './server/save-wire.ts';
import type { AgentDraft, StudioWorkspace } from './workspace.ts';

/** Where each profile's shared values are written, by the profile's id in the files. */
export type SharedSites = Record<string, readonly SettingSite[]>;

/** A workspace that compiles, and each agent's profile by the agent's key. */
export interface SharedSnapshot {
  workspace: StudioWorkspace;
  profiles: Map<string, unknown>;
}

/** What a change to a shared value reached. */
export interface SharedReach {
  /** Each shared place the change is written in, by its site. */
  sites: number[];
  /** The constant or function that holds the first of them, and where it is. */
  name?: string;
  file: string;
  line: number;
  /** The agent that was edited, and the other agents the change was made on, by key. */
  from: string;
  agents: string[];
}

export interface SharedCarry {
  workspace: StudioWorkspace;
  /** Set when the workspace compiles: what the next change is read against. */
  snapshot?: SharedSnapshot;
  /** Set when the change was made somewhere other than where the builder made it. */
  reach?: SharedReach;
}

type Path = readonly string[];

const text = (value: unknown) => JSON.stringify(value);
const same = (a: unknown, b: unknown) => text(a) === text(b);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `workspace` compiled, when it compiles. */
export function sharedSnapshot(workspace: StudioWorkspace): SharedSnapshot | undefined {
  const compiled = compileWorkspace(workspace);
  if (!compiled.ok) return undefined;
  const byId = new Map(compiled.agents.map((agent) => [agent.agentId, agent.profile as unknown]));
  const profiles = new Map(workspace.agents.map((agent) => [agent.key, byId.get(agent.identity.agentId.trim())]));
  return { workspace, profiles };
}

/** Each setting that differs, as the keys that lead to it: a record key by key, a list of one length item by item. */
function changedPaths(before: unknown, after: unknown, path: Path = []): Path[] {
  if (same(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .flatMap((key) => changedPaths(before[key], after[key], [...path, key]));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((each, index) => changedPaths(each, after[index], [...path, String(index)]));
  }
  return [path];
}

function valueAt(value: unknown, path: Path): unknown {
  let held = value;
  for (const key of path) {
    held = isRecord(held) || Array.isArray(held) ? (held as Record<string, unknown>)[key] : undefined;
  }
  return held;
}

const leads = (prefix: Path, path: Path) =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key);

/** The place that writes `path`: the deepest one that leads to it, and the last of those the files reach. */
function writerOf(sites: readonly SettingSite[], path: Path): SettingSite | undefined {
  let found: SettingSite | undefined;
  for (const site of sites) {
    if (leads(site.path, path) && (!found || site.path.length >= found.path.length)) found = site;
  }
  return found;
}

/** `onto` with what changed from `before` to `after`: a record field by field, anything else whole. */
function carried(before: unknown, after: unknown, onto: unknown): unknown {
  if (same(before, after)) return onto;
  if (!isRecord(before) || !isRecord(after) || !isRecord(onto)) return after;
  const next = { ...onto };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = carried(before[key], after[key], onto[key]);
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** One setting a change is owed on: the agent, the path there, and the edited agent's path and value. */
interface Owed {
  key: string;
  path: Path;
  from: string;
  fromPath: Path;
  value: unknown;
  site: SettingSite;
}

const modelOf = (path: Path) => (path[0] === 'models' && path.length > 1 ? path[1] : undefined);
const bindingOf = (agent: AgentDraft | undefined, model: string) =>
  agent?.modelBindings.find((binding) => binding.modelId.trim() === model);

/** `agent` with what `owed` names changed as the edited agent changed it. A model is matched by its name. */
function withOwed(agent: AgentDraft, owed: Owed, was: AgentDraft, now: AgentDraft): AgentDraft {
  const [model, fromModel] = [modelOf(owed.path), modelOf(owed.fromPath)];
  if (model === undefined || fromModel === undefined) {
    const next = { ...agent } as Record<string, unknown>;
    for (const field of Object.keys(now) as (keyof AgentDraft)[]) {
      if (field !== 'key' && field !== 'modelBindings') next[field] = carried(was[field], now[field], agent[field]);
    }
    return next as unknown as AgentDraft;
  }
  const [old, held, mine] = [bindingOf(was, fromModel), bindingOf(now, fromModel), bindingOf(agent, model)];
  let modelBindings = agent.modelBindings;
  if (old && held && mine) {
    const next = { ...carried(old, held, mine) as ModelBindingDraft, key: mine.key, modelId: mine.modelId };
    modelBindings = modelBindings.map((binding) => (binding === mine ? next : binding));
  } else if (!old && held && !mine) {
    modelBindings = [...modelBindings, { ...held, key: draftKey('model'), modelId: model }];
  } else if (old && !held && mine) modelBindings = modelBindings.filter((binding) => binding !== mine);
  return modelBindings === agent.modelBindings ? agent : { ...agent, modelBindings };
}

/**
 * `made`, with each change since `good` to a shared value made on every agent that shares it.
 * A change is carried only when the agent then compiles to that value there and to nothing else
 * new: otherwise the agent is left as it is, and Save names it.
 */
export function withSharedCarry(good: SharedSnapshot, made: StudioWorkspace, sites: SharedSites): SharedCarry {
  const now = sharedSnapshot(made);
  if (!now) return { workspace: made };
  const fileId = (key: string) => made.starts.agents[key]?.identity.agentId.trim();
  const sitesOf = (key: string) => sites[fileId(key) ?? ''] ?? [];
  const was = new Map(good.workspace.agents.map((agent) => [agent.key, agent]));

  const owed = new Map<string, Owed | null>();
  for (const agent of made.agents) {
    if (!was.has(agent.key) || !good.profiles.has(agent.key)) continue;
    const [before, after] = [good.profiles.get(agent.key), now.profiles.get(agent.key)];
    for (const path of changedPaths(before, after)) {
      const site = writerOf(sitesOf(agent.key), path);
      if (!site?.shared) continue;
      const rest = path.slice(site.path.length);
      const value = valueAt(after, path);
      for (const other of made.agents) {
        for (const place of sitesOf(other.key)) {
          if (place.site !== site.site) continue;
          const target = [...place.path, ...rest];
          // What the other sets apart inside the shared value is its own.
          if (writerOf(sitesOf(other.key), target)?.site !== site.site) continue;
          if (same(valueAt(now.profiles.get(other.key), target), value)) continue;
          const id = text([other.key, target]);
          const held = owed.get(id);
          // Two agents changed one value two ways: neither is carried.
          const mine = { key: other.key, path: target, from: agent.key, fromPath: path, value, site };
          if (held === undefined) owed.set(id, mine);
          else if (held && !same(held.value, value)) owed.set(id, null);
        }
      }
    }
  }
  const all = [...owed.values()].filter((each): each is Owed => each !== null);
  if (!all.length) return { workspace: made, snapshot: now };

  const edited = new Map(made.agents.map((agent) => [agent.key, agent]));
  const drafts = new Map(edited);
  for (const each of all) {
    const [old, held, agent] = [was.get(each.from), edited.get(each.from), drafts.get(each.key)];
    if (old && held && agent) drafts.set(each.key, withOwed(agent, each, old, held));
  }
  const next = { ...made, agents: made.agents.map((agent) => drafts.get(agent.key) ?? agent) };
  const after = sharedSnapshot(next);
  if (!after) return { workspace: made, snapshot: now };

  // Each agent has to hold what it is owed, and nothing else new.
  const kept = new Set<string>();
  for (const agent of made.agents) {
    const mine = all.filter((each) => each.key === agent.key);
    if (!mine.length) continue;
    const [before, held] = [now.profiles.get(agent.key), after.profiles.get(agent.key)];
    const changed = changedPaths(before, held).map(text).sort();
    const holds = same(changed, mine.map((each) => text(each.path)).sort()) &&
      mine.every((each) => same(valueAt(held, each.path), each.value));
    if (holds) kept.add(agent.key);
  }
  if (!kept.size) return { workspace: made, snapshot: now };
  const agents = made.agents.map((agent) => (kept.has(agent.key) ? drafts.get(agent.key) ?? agent : agent));
  const workspace = { ...made, agents };
  const profiles = new Map(made.agents.map((agent) => [
    agent.key,
    (kept.has(agent.key) ? after : now).profiles.get(agent.key),
  ]));
  const done = all.filter((each) => kept.has(each.key));
  const [first] = done;
  if (!first) return { workspace: made, snapshot: now };
  return {
    workspace,
    snapshot: { workspace, profiles },
    reach: {
      sites: [...new Set(done.map((each) => each.site.site))],
      ...(first.site.name ? { name: first.site.name } : {}),
      file: first.site.file,
      line: first.site.line,
      from: first.from,
      agents: [...kept].filter((key) => key !== first.from),
    },
  };
}

/** The most names the question lists before it counts the rest. */
const NAMED = 4;

/** What the builder is asked before a change to a shared value is made: the question, then its cause and effect. */
export function sharedAsk(reach: SharedReach, workspace: StudioWorkspace): { title: string; line: string } {
  const ids = reach.agents
    .map((key) => workspace.agents.find((agent) => agent.key === key)?.identity.agentId.trim())
    .filter((id): id is string => Boolean(id));
  const place = `${reach.name ? `${reach.name} · ` : ''}${reach.file}:${String(reach.line)}`;
  if (!ids.length) {
    return {
      title: 'Change it everywhere this profile uses it?',
      line: `${place} sets this once, and this profile uses it in more than one place. Each of them changes.`,
    };
  }
  const rest = ids.length - NAMED;
  const shown = rest > 0 ? [...ids.slice(0, NAMED), `${String(rest)} more`] : ids;
  const names = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}` : shown[0] ?? '';
  return {
    title: `Change it for ${String(ids.length)} other ${ids.length === 1 ? 'profile' : 'profiles'}?`,
    line: `${place} sets this once. ${names} ${ids.length === 1 ? 'uses' : 'use'} it too, and will change with it.`,
  };
}
