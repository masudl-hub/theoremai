/**
 * A change to a value the project's files write once, made on every agent
 * that shares it. The files hold one value, so the workspace does too.
 *
 * @module
 */

import { agentToolInputSchema, compileStudio } from './compile.ts';
import { draftKey, type ModelBindingDraft } from './draft.ts';
import type { SettingSite } from './server/save-wire.ts';
import { type AgentDraft, agentDraft, type StudioWorkspace } from './workspace.ts';

/** Where each profile's shared values are written, by the profile's id in the files. */
export type SharedSites = Record<string, readonly SettingSite[]>;

/** Each agent as it last compiled, by key: its draft then, and the profile that draft compiles to. */
export type SharedSnapshot = Map<string, { draft: AgentDraft; profile: unknown }>;

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
  /**
   * The agents that share the value and were left as they are: one with an issue the studio
   * cannot compile past, or one the change would move in more than this. Save writes the value
   * once they hold it too.
   */
  left: string[];
}

export interface SharedCarry {
  workspace: StudioWorkspace;
  /** What the next change is read against. */
  snapshot: SharedSnapshot;
  /** Set when the change was made somewhere other than where the builder made it. */
  reach?: SharedReach;
}

type Path = readonly string[];

const text = (value: unknown) => JSON.stringify(value);
const same = (a: unknown, b: unknown) => text(a) === text(b);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * One agent's profile, when the agent compiles on its own. With the builder's own keys: which
 * models the studio's keys may call is a rule for a run, and does not change a profile's shape.
 */
function profileOf(workspace: StudioWorkspace, key: string): unknown {
  const draft = agentDraft(workspace, key);
  const idOf = (other: string) => workspace.agents.find((agent) => agent.key === other)?.identity.agentId.trim();
  const inputOf = (other: string) => {
    const called = agentDraft(workspace, other);
    return called && agentToolInputSchema(called);
  };
  const result = draft && compileStudio(draft, 'byok', idOf, inputOf);
  return result?.ok ? result.profile : undefined;
}

/**
 * Each agent of `workspace` as it compiles now. One that does not compile keeps what `before`
 * holds for it, so a change made while it did not is still read once it does.
 */
export function sharedSnapshot(workspace: StudioWorkspace, before?: SharedSnapshot): SharedSnapshot {
  const snapshot: SharedSnapshot = new Map();
  for (const draft of workspace.agents) {
    const profile = profileOf(workspace, draft.key);
    const held = profile === undefined ? before?.get(draft.key) : { draft, profile };
    if (held) snapshot.set(draft.key, held);
  }
  return snapshot;
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
  const now = new Map(made.agents.map((agent) => [agent.key, profileOf(made, agent.key)]));
  const fileId = (key: string) => made.starts.agents[key]?.identity.agentId.trim();
  const sitesOf = (key: string) => sites[fileId(key) ?? ''] ?? [];
  const edited = new Map(made.agents.map((agent) => [agent.key, agent]));
  const plain = (): SharedSnapshot => sharedSnapshot(made, good);

  const owed = new Map<string, Owed | null>();
  const left = new Set<string>();
  for (const agent of made.agents) {
    const [before, after] = [good.get(agent.key)?.profile, now.get(agent.key)];
    if (before === undefined || after === undefined) continue;
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
          const held = now.get(other.key);
          if (held !== undefined && same(valueAt(held, target), value)) continue;
          const id = text([other.key, target]);
          const mine = { key: other.key, path: target, from: agent.key, fromPath: path, value, site };
          const known = owed.get(id);
          // Two agents changed one value two ways: neither is carried.
          if (known === undefined) owed.set(id, mine);
          else if (known && !same(known.value, value)) owed.set(id, null);
        }
      }
    }
  }
  const all = [...owed.values()].filter((each): each is Owed => each !== null);
  const [first] = all;
  if (!first) return { workspace: made, snapshot: plain() };

  const drafts = new Map(edited);
  for (const each of all) {
    const [old, held, agent] = [good.get(each.from)?.draft, edited.get(each.from), drafts.get(each.key)];
    // An agent that does not compile cannot show that it holds the value: it is left.
    if (old && held && agent && now.get(each.key) !== undefined) drafts.set(each.key, withOwed(agent, each, old, held));
  }
  const next = { ...made, agents: made.agents.map((agent) => drafts.get(agent.key) ?? agent) };

  // Each agent has to hold what it is owed, and nothing else new.
  const kept = new Map<string, unknown>();
  for (const key of new Set(all.map((each) => each.key))) {
    const mine = all.filter((each) => each.key === key);
    const [before, held] = [now.get(key), drafts.get(key) === edited.get(key) ? undefined : profileOf(next, key)];
    const holds = before !== undefined && held !== undefined &&
      same(changedPaths(before, held).map(text).sort(), mine.map((each) => text(each.path)).sort()) &&
      mine.every((each) => same(valueAt(held, each.path), each.value));
    if (holds) kept.set(key, held);
    else left.add(key);
  }
  const agents = made.agents.map((agent) => (kept.has(agent.key) ? drafts.get(agent.key) ?? agent : agent));
  const workspace = kept.size ? { ...made, agents } : made;
  const snapshot = plain();
  for (const agent of agents) {
    if (kept.has(agent.key)) snapshot.set(agent.key, { draft: agent, profile: kept.get(agent.key) });
  }
  const done = all.filter((each) => kept.has(each.key) || left.has(each.key));
  return {
    workspace,
    snapshot,
    reach: {
      sites: [...new Set(done.map((each) => each.site.site))],
      ...(first.site.name ? { name: first.site.name } : {}),
      file: first.site.file,
      line: first.site.line,
      from: first.from,
      agents: [...kept.keys()].filter((key) => key !== first.from),
      left: [...left].filter((key) => key !== first.from),
    },
  };
}

/** The most names the question lists before it counts the rest. */
const NAMED = 4;

/** `ids` as a sentence names them: the first few, then a count of the rest. */
function listed(ids: readonly string[]): string {
  const rest = ids.length - NAMED;
  const shown = rest > 0 ? [...ids.slice(0, NAMED), `${String(rest)} more`] : ids;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}` : shown[0] ?? '';
}

/** What the builder is asked before a change to a shared value is made: the question, then its cause and effect. */
export function sharedAsk(reach: SharedReach, workspace: StudioWorkspace): { title: string; line: string } {
  const idsOf = (keys: readonly string[]) =>
    keys.map((key) => workspace.agents.find((agent) => agent.key === key)?.identity.agentId.trim())
      .filter((id): id is string => Boolean(id));
  const [ids, left] = [idsOf(reach.agents), idsOf(reach.left)];
  const place = `${reach.name ? `${reach.name} · ` : ''}${reach.file}:${String(reach.line)}`;
  if (!ids.length && !left.length) {
    return {
      title: 'Change it everywhere this profile uses it?',
      line: `${place} sets this once, and this profile uses it in more than one place. Each of them changes.`,
    };
  }
  const changes = ids.length
    ? ` ${listed(ids)} ${ids.length === 1 ? 'uses' : 'use'} it too, and will change with it.`
    : '';
  // The cause, the effect, and the way out.
  const waits = left.length
    ? ` ${listed(left)} ${left.length === 1 ? 'uses' : 'use'} it too, but ${left.length === 1 ? 'has' : 'have'} ` +
      `issues and ${left.length === 1 ? 'stays as it is' : 'stay as they are'}. ` +
      'Fix them, then set this there too: Save writes it once every profile agrees.'
    : '';
  // The title says what agreeing does: a profile that is left as it is does not count.
  const title = ids.length
    ? `Change it for ${String(ids.length)} other ${ids.length === 1 ? 'profile' : 'profiles'}?`
    : 'Change it for this profile only?';
  return { title, line: `${place} sets this once.${changes}${waits}` };
}
