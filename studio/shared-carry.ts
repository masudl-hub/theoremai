/**
 * A change to a value the project's files write once, made on every agent or
 * tool that shares it. The files hold one value, so the workspace does too.
 * The same stop names the other code that reads the value, when some does.
 *
 * @module
 */

import { agentToolInputSchema, compileStudio } from './compile.ts';
import { draftKey, type ModelBindingDraft, type ToolSpecDraft } from './draft.ts';
import type { SettingSite, SourcePlace } from './server/save-wire.ts';
import { type AgentDraft, agentDraft, type StudioWorkspace } from './workspace.ts';

/** Where each profile's or tool's shared values are written, by the id or name the files know it by. */
export type SharedSites = Record<string, readonly SettingSite[]>;

/** Each agent as it last compiled, by key: its draft then, and the profile that draft compiles to. */
export type SharedSnapshot = Map<string, { draft: AgentDraft; profile: unknown }>;

/** Each tool as it last compiled, by key: its draft then, and what that draft registers. */
export type ToolSnapshot = Map<string, { draft: ToolSpecDraft; tool: unknown }>;

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
  /** Set for a tool's value: the other tools the change was made on, and the ones left as they are, by key. */
  amongTools?: { made: string[]; left: string[] };
  /** Set when other code reads the value too: each line that reads it. None when the studio cannot name one. */
  readBy?: SourcePlace[];
}

/** A change to tools of the library that other agents allow too: a tool is one thing for all of them. */
export interface ToolReach {
  /** The tools changed or removed, by key, and by name as they were. */
  tools: string[];
  names: string[];
  /** The agent the change was made in, and the other agents that allow one of the tools, by key. */
  from: string;
  agents: string[];
}

export interface SharedCarry {
  workspace: StudioWorkspace;
  /** What the next change is read against. */
  snapshot: SharedSnapshot;
  /** The same for the tools, when the project's tools share values. */
  tools?: ToolSnapshot;
  /** Set when the change reaches past where the builder made it: other agents or tools, or other code. */
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
  const result = compiledOf(workspace, key);
  return result?.ok ? result.profile : undefined;
}

type Compiled = ReturnType<typeof compileStudio>;

/** A workspace does not change, so each of its agents compiles once. */
const COMPILED = new WeakMap<StudioWorkspace, Map<string, Compiled | undefined>>();

function compiledOf(workspace: StudioWorkspace, key: string): Compiled | undefined {
  const known = COMPILED.get(workspace) ?? new Map<string, Compiled | undefined>();
  COMPILED.set(workspace, known);
  if (known.has(key)) return known.get(key);
  const draft = agentDraft(workspace, key);
  const idOf = (other: string) => workspace.agents.find((agent) => agent.key === other)?.identity.agentId.trim();
  const inputOf = (other: string) => {
    const called = agentDraft(workspace, other);
    return called && agentToolInputSchema(called);
  };
  const result = draft && compileStudio(draft, 'byok', idOf, inputOf);
  known.set(key, result);
  return result;
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

/** The agents or the tools a change is carried among, and how each is read and changed. */
interface CarryAmong<D extends { key: string }> {
  /** Each of them as edited. */
  made: readonly D[];
  /** One's draft when it last compiled, and what it compiled to. */
  goodOf(key: string): { draft: D; value: unknown } | undefined;
  /** What each compiles to now. Nothing for one that does not compile. */
  now: ReadonlyMap<string, unknown>;
  /** Where the files write one's settings. */
  sitesOf(key: string): readonly SettingSite[];
  /** `draft` with one owed change, as the edited one made it. Undefined when it cannot take it. */
  withOwed(draft: D, owed: Owed, was: D, now: D): D | undefined;
  /** What each compiles to with `drafts` in place of the edited ones. */
  compiledWith(drafts: readonly D[]): (key: string) => unknown;
}

/** One change to a shared value: the place that writes it, the path below that place, and who made it. */
interface SharedEdit {
  site: SettingSite;
  rest: Path;
  value: unknown;
  from: string;
  fromPath: Path;
}

/** Each place `other` holds the value `edit` changed and does not hold the change yet. */
function owedOn<D extends { key: string }>(among: CarryAmong<D>, other: D, edit: SharedEdit): Owed[] {
  const sites = among.sitesOf(other.key);
  const held = among.now.get(other.key);
  return sites
    .filter((place) => place.site === edit.site.site)
    .map((place) => [...place.path, ...edit.rest])
    // What the other sets apart inside the shared value is its own.
    .filter((target) => writerOf(sites, target)?.site === edit.site.site)
    .filter((target) => held === undefined || !same(valueAt(held, target), edit.value))
    .map((path) => ({ key: other.key, path, from: edit.from, fromPath: edit.fromPath, value: edit.value, site: edit.site }));
}

/** Each change one of them made since it last compiled, with the place in the files that writes it. */
function editsOf<D extends { key: string }>(among: CarryAmong<D>, draft: D): Array<{ path: Path; site?: SettingSite; value: unknown }> {
  const [before, after] = [among.goodOf(draft.key)?.value, among.now.get(draft.key)];
  if (before === undefined || after === undefined) return [];
  const sites = among.sitesOf(draft.key);
  return changedPaths(before, after).map((path) => {
    const site = writerOf(sites, path);
    return { path, ...(site ? { site } : {}), value: valueAt(after, path) };
  });
}

/**
 * What each change to a shared value is owed on, and each place a change is written that other
 * code reads too, with who made it.
 */
function owedAmong<D extends { key: string }>(among: CarryAmong<D>) {
  const owed = new Map<string, Owed | null>();
  const read: Array<{ site: SettingSite; from: string }> = [];
  for (const draft of among.made) {
    for (const { path, site, value } of editsOf(among, draft)) {
      if (site?.readBy) read.push({ site, from: draft.key });
      if (!site?.shared) continue;
      const edit = { site, rest: path.slice(site.path.length), value, from: draft.key, fromPath: path };
      for (const mine of among.made.flatMap((other) => owedOn(among, other, edit))) {
        const id = text([mine.key, mine.path]);
        const known = owed.get(id);
        // Two changed one value two ways: neither is carried.
        if (known === undefined) owed.set(id, mine);
        else if (known && !same(known.value, value)) owed.set(id, null);
      }
    }
  }
  return { all: [...owed.values()].filter((each): each is Owed => each !== null), read };
}

/** Whether what one compiles to now holds each change it is owed, and nothing else new. */
function holdsOwed(before: unknown, held: unknown, mine: readonly Owed[]): boolean {
  return same(changedPaths(before, held).map(text).sort(), mine.map((each) => text(each.path)).sort()) &&
    mine.every((each) => same(valueAt(held, each.path), each.value));
}

/** What a carry did: the drafts with what was carried, what each of those compiles to, and the ones left. */
interface Carried<D> {
  drafts: D[];
  kept: Map<string, unknown>;
  left: Set<string>;
  /** Set when the change reaches past where it was made: where it is written, and who made it. */
  place?: ReturnType<typeof placeOf> & { from: string };
}

/**
 * Each change to a shared value made on every one that shares it. A change is carried only when
 * the one it is owed on then compiles to that value there and to nothing else new: otherwise it
 * is left as it is, and Save names it.
 */
function carriedAmong<D extends { key: string }>(among: CarryAmong<D>): Carried<D> {
  const { all, read } = owedAmong(among);
  const kept = new Map<string, unknown>();
  const left = new Set<string>();
  const from = all[0]?.from ?? read[0]?.from;
  if (from === undefined) return { drafts: [...among.made], kept, left };
  const place = { ...placeOf([...all, ...read].map((each) => each.site)), from };

  const edited = new Map(among.made.map((draft) => [draft.key, draft]));
  const drafts = new Map(edited);
  for (const each of all) {
    const [old, held, draft] = [among.goodOf(each.from)?.draft, edited.get(each.from), drafts.get(each.key)];
    // One that does not compile cannot show that it holds the value: it is left.
    const able = old && held && draft && among.now.get(each.key) !== undefined;
    const next = able ? among.withOwed(draft, each, old, held) : undefined;
    if (next) drafts.set(each.key, next);
    else left.add(each.key);
  }
  const compiled = among.compiledWith(among.made.map((draft) => drafts.get(draft.key) ?? draft));
  for (const key of new Set(all.map((each) => each.key))) {
    const before = among.now.get(key);
    const held = left.has(key) || drafts.get(key) === edited.get(key) ? undefined : compiled(key);
    const mine = all.filter((each) => each.key === key);
    if (before !== undefined && held !== undefined && holdsOwed(before, held, mine)) kept.set(key, held);
    else left.add(key);
  }
  return { drafts: among.made.map((draft) => (kept.has(draft.key) ? drafts.get(draft.key) ?? draft : draft)), kept, left, place };
}

/**
 * `made`, with each change since `good` to a shared value made on every agent that shares it.
 * A change is carried only when the agent then compiles to that value there and to nothing else
 * new: otherwise the agent is left as it is, and Save names it.
 */
export function withSharedCarry(good: SharedSnapshot, made: StudioWorkspace, sites: SharedSites): SharedCarry {
  const { drafts, kept, left, place } = carriedAmong<AgentDraft>({
    made: made.agents,
    goodOf: (key) => {
      const held = good.get(key);
      return held && { draft: held.draft, value: held.profile };
    },
    now: new Map(made.agents.map((agent) => [agent.key, profileOf(made, agent.key)])),
    sitesOf: (key) => sites[made.starts.agents[key]?.identity.agentId.trim() ?? ''] ?? [],
    withOwed,
    compiledWith: (agents) => {
      const next = { ...made, agents: [...agents] };
      return (key) => profileOf(next, key);
    },
  });
  const snapshot = sharedSnapshot(made, good);
  for (const agent of drafts) {
    if (kept.has(agent.key)) snapshot.set(agent.key, { draft: agent, profile: kept.get(agent.key) });
  }
  const others = (keys: Iterable<string>) => [...keys].filter((key) => key !== place?.from);
  return {
    workspace: kept.size ? { ...made, agents: drafts } : made,
    snapshot,
    ...(place ? { reach: { ...place, agents: others(kept.keys()), left: others(left) } } : {}),
  };
}

/** What a reach says of the places a change is written: each one, where the first is, and the code that reads them. */
function placeOf(sites: readonly SettingSite[]): Pick<SharedReach, 'sites' | 'name' | 'file' | 'line' | 'readBy'> {
  const [first] = sites;
  const lines = new Map(
    sites.flatMap((site) => site.readBy ?? []).map((each) => [`${each.file}:${String(each.line)}`, each]),
  );
  return {
    sites: [...new Set(sites.map((site) => site.site))],
    ...(first?.name ? { name: first.name } : {}),
    file: first?.file ?? '',
    line: first?.line ?? 0,
    ...(sites.some((site) => site.readBy) ? { readBy: [...lines.values()] } : {}),
  };
}

/** Each tool an agent that compiles allows, by key, as that agent registers it. */
function toolsOf(workspace: StudioWorkspace): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const agent of workspace.agents) {
    const result = compiledOf(workspace, agent.key);
    if (result?.ok) for (const tool of result.customTools) byName.set(tool.name, tool);
  }
  const held = new Map<string, unknown>();
  for (const tool of workspace.toolSpecs) {
    const registered = byName.get(tool.toolName.trim());
    if (registered !== undefined) held.set(tool.key, registered);
  }
  return held;
}

/**
 * Each tool of `workspace` as it registers now. One that does not compile keeps what `before`
 * holds for it, so a change made while it did not is still read once it does.
 */
export function toolSnapshot(workspace: StudioWorkspace, before?: ToolSnapshot): ToolSnapshot {
  const now = toolsOf(workspace);
  const snapshot: ToolSnapshot = new Map();
  for (const draft of workspace.toolSpecs) {
    const tool = now.get(draft.key);
    const held = tool === undefined ? before?.get(draft.key) : { draft, tool };
    if (held) snapshot.set(draft.key, held);
  }
  return snapshot;
}

/** A tool's schema as the draft holds it, by the key the tool is registered with. */
const SCHEMA_FIELDS: Record<string, 'inputJson' | 'outputJson'> = { inputSchema: 'inputJson', outputSchema: 'outputJson' };

/** `value` with `to` at `path`. Nothing at the path takes the key away. */
function putAt(value: unknown, path: Path, to: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return to;
  if (Array.isArray(value)) return value.map((each, index) => (String(index) === key ? putAt(each, rest, to) : each));
  const next: Record<string, unknown> = { ...(isRecord(value) ? value : {}) };
  const inner = putAt(next[key], rest, to);
  if (inner === undefined) delete next[key];
  else next[key] = inner;
  return next;
}

/** `tool` with what `owed` names changed as the edited tool changed it. Undefined when its schema does not read. */
function toolWithOwed(tool: ToolSpecDraft, owed: Owed, was: ToolSpecDraft, now: ToolSpecDraft): ToolSpecDraft | undefined {
  const [head, ...rest] = owed.path;
  const schema = SCHEMA_FIELDS[head ?? ''];
  if (schema) {
    try {
      return { ...tool, [schema]: JSON.stringify(putAt(JSON.parse(tool[schema]), rest, owed.value), null, 2) };
    } catch {
      return undefined;
    }
  }
  const next = { ...tool } as Record<string, unknown>;
  for (const field of Object.keys(now) as (keyof ToolSpecDraft)[]) {
    if (field === 'key' || field === 'toolName' || field === 'inputJson' || field === 'outputJson') continue;
    next[field] = carried(was[field], now[field], tool[field]);
  }
  return next as unknown as ToolSpecDraft;
}

/**
 * `made`, with each change since `good` to a value tools share made on every tool that shares it:
 * a schema several tools take, a list they all name. A change is carried only when the tool then
 * registers with that value there and nothing else new: otherwise the tool is left as it is, and
 * Save names it. A tool no agent allows is not registered here, so it is not read.
 */
export function withToolCarry(
  good: ToolSnapshot,
  made: StudioWorkspace,
  sites: SharedSites,
): { workspace: StudioWorkspace; snapshot: ToolSnapshot; reach?: SharedReach } {
  const { drafts, kept, left, place } = carriedAmong<ToolSpecDraft>({
    made: made.toolSpecs,
    goodOf: (key) => {
      const held = good.get(key);
      return held && { draft: held.draft, value: held.tool };
    },
    now: toolsOf(made),
    sitesOf: (key) => sites[made.starts.tools[key]?.toolName ?? ''] ?? [],
    withOwed: toolWithOwed,
    compiledWith: (toolSpecs) => {
      const after = toolsOf({ ...made, toolSpecs: [...toolSpecs] });
      return (key) => after.get(key);
    },
  });
  const snapshot = toolSnapshot(made, good);
  for (const tool of drafts) {
    if (kept.has(tool.key)) snapshot.set(tool.key, { draft: tool, tool: kept.get(tool.key) });
  }
  const others = (keys: Iterable<string>) => [...keys].filter((key) => key !== place?.from);
  const amongTools = { made: others(kept.keys()), left: others(left) };
  return {
    workspace: kept.size ? { ...made, toolSpecs: drafts } : made,
    snapshot,
    ...(place ? { reach: { ...place, agents: [], left: [], amongTools } } : {}),
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

/** What a change from `before` to `made`, made in the agent `from`, does to tools other agents allow. */
export function toolReach(before: StudioWorkspace, made: StudioWorkspace, from: string): ToolReach | undefined {
  const now = new Map(made.toolSpecs.map((tool) => [tool.key, tool]));
  const changed = before.toolSpecs.filter((tool) => !same(now.get(tool.key), tool));
  const keys = new Set(changed.map((tool) => tool.key));
  const agents = before.agents
    .filter((agent) => agent.key !== from && agent.tools.allow.some((key) => keys.has(key)))
    .map((agent) => agent.key);
  if (!agents.length) return undefined;
  const used = changed.filter((tool) =>
    before.agents.some((agent) => agent.key !== from && agent.tools.allow.includes(tool.key))
  );
  return { tools: used.map((tool) => tool.key), names: used.map((tool) => tool.toolName), from, agents };
}

export interface Ask {
  title: string;
  line: string;
}

/** The ids of agents, by key, as the builder knows them. */
const idsOf = (workspace: StudioWorkspace, keys: readonly string[]) =>
  keys.map((key) => workspace.agents.find((agent) => agent.key === key)?.identity.agentId.trim())
    .filter((id): id is string => Boolean(id));

/** The names of tools, by key. */
const toolNames = (workspace: StudioWorkspace, keys: readonly string[]) =>
  keys.map((key) => workspace.toolSpecs.find((tool) => tool.key === key)?.toolName.trim())
    .filter((name): name is string => Boolean(name));

/** The question for a tool of the library that other agents allow too. */
function libraryAsk(reach: ToolReach, workspace: StudioWorkspace): Ask {
  const [ids, one] = [idsOf(workspace, reach.agents), reach.names.length === 1];
  return {
    title: `Change it for ${String(ids.length)} other ${ids.length === 1 ? 'profile' : 'profiles'}?`,
    line: `${listed(reach.names)} ${one ? 'is one tool' : 'are tools'} in the library. ` +
      `${listed(ids)} ${ids.length === 1 ? 'uses' : 'use'} ${one ? 'it' : 'them'} too, ` +
      `and will change with ${one ? 'it' : 'them'}.`,
  };
}

/** What the builder is asked before a change to a shared value is made: the question, then its cause and effect. */
export function sharedAsk(reach: SharedReach | ToolReach, workspace: StudioWorkspace): Ask {
  if ('tools' in reach) return libraryAsk(reach, workspace);
  const among = reach.amongTools;
  const [ids, left] = among
    ? [toolNames(workspace, among.made), toolNames(workspace, among.left)]
    : [idsOf(workspace, reach.agents), idsOf(workspace, reach.left)];
  const [one, many] = among ? ['tool', 'tools'] : ['profile', 'profiles'];
  const place = `${reach.name ? `${reach.name} · ` : ''}${reach.file}:${String(reach.line)}`;
  // The other code that reads it, by line when the studio can name one.
  const lines = reach.readBy?.map((each) => `${each.file}:${String(each.line)}`) ?? [];
  const code = reach.readBy ? ` Other code in your project reads it too${lines.length ? ` (${listed(lines)})` : ''}.` : '';
  if (!ids.length && !left.length) {
    if (reach.readBy) {
      return {
        title: 'Change it for your other code too?',
        line: `${place} sets this once.${code} That code runs on the new value once you save.`,
      };
    }
    return {
      title: `Change it everywhere this ${one} uses it?`,
      line: `${place} sets this once, and this ${one} uses it in more than one place. Each of them changes.`,
    };
  }
  const changes = ids.length
    ? ` ${listed(ids)} ${ids.length === 1 ? 'uses' : 'use'} it too, and will change with it.`
    : '';
  // The cause, the effect, and the way out.
  const waits = left.length
    ? ` ${listed(left)} ${left.length === 1 ? 'uses' : 'use'} it too, but ${left.length === 1 ? 'has' : 'have'} ` +
      `issues and ${left.length === 1 ? 'stays as it is' : 'stay as they are'}. ` +
      `Fix them, then set this there too: Save writes it once every ${one} agrees.`
    : '';
  // The title says what agreeing does: one that is left as it is does not count.
  const title = ids.length
    ? `Change it for ${String(ids.length)} other ${ids.length === 1 ? one : many}?`
    : `Change it for this ${one} only?`;
  return { title, line: `${place} sets this once.${changes}${waits}${code}` };
}

/** Whether agreeing to a change makes it on others too: other agents, other tools. */
export function reachesOthers(reach: SharedReach | ToolReach): boolean {
  return reach.agents.length > 0 || ('amongTools' in reach && (reach.amongTools?.made.length ?? 0) > 0);
}
