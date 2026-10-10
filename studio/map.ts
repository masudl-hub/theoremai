/**
 * The workspace as a map. Each profile is a card of its sections; what feeds it stands beside it:
 * the providers and models it runs on, the settings the project shares, the tools it may call. A
 * line joins each to the section it feeds. It is read from the workspace and changes nothing; each
 * node and section names the workspace node that opens it.
 */
import { type SharedEntry, sharedNodeId } from './shared-settings.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';
import { type AgentDraft, agentNodeId, type StudioWorkspace, workspaceTree } from './workspace.ts';

export type MapNodeKind = 'provider' | 'shared' | 'model' | 'agent' | 'tool';

/** One section of a profile, on its card. */
export interface MapRow {
  /** The section's workspace node id, which also opens it. */
  id: string;
  label: string;
  /** Beside the label: the models' names, how many tools are allowed, the kind of output. */
  note: string;
  opens: string;
  /** The section, as `FACET_ICON` names it. */
  type: string;
}

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  label: string;
  /** Under the label: a tool's description, a model's provider and id, where a setting is declared. */
  note: string;
  /** The workspace node that opens it; unset for a provider, and for a shared setting nothing here uses. */
  opens?: string;
  /** An agent's profile type, a tool's type, or the section a shared setting fills. */
  type?: string;
  /** A profile's sections, in the tree's order. */
  rows?: MapRow[];
}

/**
 * What joins two nodes, read from `from` to `to`. An end is a node's id, or the id of the profile's
 * section it feeds:
 * - `serves`: a provider serves a model.
 * - `sets`: a shared setting sets a section of a profile, or a tool.
 * - `runs`: a model runs a profile.
 * - `allows`: a profile may call a tool.
 * - `asks`: an agent tool asks its profile.
 * - `summarised`: a profile has another write its summaries.
 */
export type MapLinkKind = 'serves' | 'sets' | 'runs' | 'allows' | 'asks' | 'summarised';

export interface MapLink {
  from: string;
  to: string;
  kind: MapLinkKind;
}

export interface MapGroup {
  label: string;
  nodes: MapNode[];
}

export interface WorkspaceMap {
  /** Left to right: providers, what profiles are set with, the profiles, the tools. A column holds only groups with nodes. */
  columns: MapGroup[][];
  links: MapLink[];
}

/** `nodes` in the order of what each is joined to in the column beside it (`rows`), so the lines cross less; unjoined ones go last. */
function byRows(nodes: MapNode[], links: readonly MapLink[], rows: ReadonlyMap<string, number>): MapNode[] {
  const rank = (node: MapNode) => {
    const joined = links
      .flatMap(({ from, to }) => (from === node.id ? [to] : to === node.id ? [from] : []))
      .flatMap((id) => rows.get(id) ?? []);
    return joined.length === 0 ? Infinity : joined.reduce((sum, row) => sum + row, 0) / joined.length;
  };
  const ranks = new Map(nodes.map((node) => [node.id, rank(node)]));
  const at = (node: MapNode) => ranks.get(node.id) ?? Infinity;
  // Two unjoined nodes compare equal (Infinity less Infinity is not a number); the sort is stable.
  return [...nodes].sort((a, b) => (at(a) === at(b) ? 0 : at(a) - at(b)));
}

/** What a section's row says beside its name, where one line can say it. */
function rowNote(agent: AgentDraft, facet: string, tools: ReadonlyMap<string, string>): string {
  if (facet === 'models') return agent.modelBindings.map((binding) => binding.modelId || 'New model').join(', ');
  if (facet === 'tools') return String(agent.tools.allow.filter((key) => tools.has(key)).length);
  if (facet === 'outputs') return agent.outputs.mode;
  return '';
}

/** The map of `workspace`, with the settings its project shares. */
export function workspaceMap(workspace: StudioWorkspace, shared: readonly SharedEntry[] = []): WorkspaceMap {
  const links: MapLink[] = [];
  const agentIds = new Map(workspace.agents.map((agent) => [agent.key, agentNodeId(agent.key)]));
  const toolIds = new Map(workspace.toolSpecs.map((tool) => [tool.key, toolSpecNodeId(tool.key)]));
  const tree = workspaceTree(workspace);

  const agents = workspace.agents.map((agent, index): MapNode => {
    const { agentId, profileType, handle } = agent.identity;
    const type = profileType || 'text';
    return {
      id: agentNodeId(agent.key),
      kind: 'agent',
      label: agentId || 'New agent',
      note: handle ? `${type} · ${handle}` : type,
      opens: agentNodeId(agent.key),
      type,
      rows: (tree.agents[index]?.children ?? []).map((section) => ({
        id: section.id,
        label: section.label,
        note: rowNote(agent, section.ref.facet, toolIds),
        opens: section.id,
        type: section.ref.facet,
      })),
    };
  });
  const sections = new Set(agents.flatMap((agent) => agent.rows ?? []).map((row) => row.id));
  /** An agent's section when its profile has it, else the agent itself. */
  const at = (key: string, facet: string) => {
    const row = agentNodeId(key, facet);
    return sections.has(row) ? row : agentNodeId(key);
  };

  const providers = new Map<string, MapNode>();
  const models = new Map<string, MapNode>();
  for (const agent of workspace.agents) {
    const to = at(agent.key, 'models');
    for (const binding of agent.modelBindings) {
      // Two agents share a model's node when they name it alike and reach the same model.
      const id = `model:${binding.provider}:${binding.apiId}:${binding.modelId}`;
      const provider = `provider:${binding.provider}`;
      if (!providers.has(provider)) {
        providers.set(provider, { id: provider, kind: 'provider', label: binding.provider, note: '' });
      }
      if (!models.has(id)) {
        models.set(id, {
          id,
          kind: 'model',
          label: binding.modelId || 'New model',
          note: binding.apiId || binding.protocol,
          opens: agentNodeId(agent.key, modelBindingNodeId(binding.key)),
        });
        links.push({ from: provider, to: id, kind: 'serves' });
      }
      if (!links.some((link) => link.from === id && link.to === to)) links.push({ from: id, to, kind: 'runs' });
      const writer = binding.compactWith ? agentIds.get(binding.compactWith) : undefined;
      if (writer && writer !== agentNodeId(agent.key) && !links.some((link) => link.kind === 'summarised' && link.from === to)) {
        links.push({ from: to, to: writer, kind: 'summarised' });
      }
    }
    for (const key of agent.tools.allow) {
      const tool = toolIds.get(key);
      if (tool) links.push({ from: at(agent.key, 'tools'), to: tool, kind: 'allows' });
    }
  }

  const tools = workspace.toolSpecs.map((tool): MapNode => {
    const id = toolSpecNodeId(tool.key);
    const asked = tool.toolType === 'agent' ? agentIds.get(tool.agentKey ?? '') : undefined;
    if (asked) links.push({ from: id, to: asked, kind: 'asks' });
    return {
      id,
      kind: 'tool',
      label: tool.toolName || 'New tool',
      note: tool.description,
      opens: id,
      type: tool.toolType,
    };
  });

  const settings = shared.map((entry): MapNode => {
    const { setting, facet } = entry;
    const id = `shared:${setting.file}:${setting.name}`;
    const users = entry.agents.filter((key) => agentIds.has(key));
    const used = setting.tools.flatMap((name) => {
      const tool = workspace.toolSpecs.find((spec) => spec.toolName === name);
      return tool ? [toolSpecNodeId(tool.key)] : [];
    });
    for (const key of users) links.push({ from: id, to: facet ? at(key, facet) : agentNodeId(key), kind: 'sets' });
    for (const to of used) links.push({ from: id, to, kind: 'sets' });
    return {
      id,
      kind: 'shared',
      label: setting.label,
      note: `${setting.name} · ${setting.file}:${String(setting.line)}`,
      opens: users[0] ? sharedNodeId(entry, users[0]) : used[0],
      type: facet,
    };
  });

  // Each agent and its sections by the agent's place; then each model by its own, for the providers.
  const rows = new Map(agents.flatMap((agent, row) => [agent.id, ...(agent.rows ?? []).map((each) => each.id)].map((id) => [id, row])));
  const ordered = byRows([...models.values()], links, rows);
  const modelRows = new Map(ordered.map((model, row) => [model.id, row]));
  const groups = (...all: MapGroup[]) => all.filter((group) => group.nodes.length > 0);
  const columns = [
    groups({ label: 'Providers', nodes: byRows([...providers.values()], links, modelRows) }),
    groups({ label: 'Shared settings', nodes: byRows(settings, links, rows) }, { label: 'Models', nodes: ordered }),
    groups({ label: 'Profiles', nodes: agents }),
    groups({ label: 'Tools', nodes: byRows(tools, links, rows) }),
  ].filter((column) => column.length > 0);
  return { columns, links };
}

/** Every node and every section, by id, under the node that holds it. */
function owners(map: WorkspaceMap): Map<string, MapNode> {
  const nodes = map.columns.flat().flatMap((group) => group.nodes);
  return new Map(nodes.flatMap((node) => [node.id, ...(node.rows ?? []).map((row) => row.id)].map((id) => [id, node])));
}

/** The nodes a link joins: a link to a profile's section joins the profile. */
export function mapLinkEnds(map: WorkspaceMap): { link: MapLink; from: string; to: string }[] {
  const held = owners(map);
  return map.links.flatMap((link) => {
    const from = held.get(link.from)?.id;
    const to = held.get(link.to)?.id;
    return from !== undefined && to !== undefined ? [{ link, from, to }] : [];
  });
}

/** `id` and every node a link joins it to. */
export function mapNeighbours(map: WorkspaceMap, id: string): Set<string> {
  return new Set([id, ...mapLinkEnds(map).flatMap(({ from, to }) => (from === id ? [to] : to === id ? [from] : []))]);
}

/** A link in words from each end: `[from's side, to's side]`, each before the other node's label. */
const LINK_WORDS = {
  serves: ['Serves', 'Served by'],
  sets: ['Sets', 'Set by'],
  runs: ['Runs', 'Runs on'],
  allows: ['Allows', 'Allowed by'],
  asks: ['Asks', 'Asked by'],
  summarised: ['Summarised by', 'Summarises for'],
} as const satisfies Record<MapLinkKind, readonly [string, string]>;

/** What joins a node to the rest, in words: "Runs on gemini-2.5-flash. Allows get_weather, find_plant." */
export function mapLinkWords(map: WorkspaceMap, id: string): string {
  const held = owners(map);
  const said = new Map<string, string[]>();
  for (const { link, from, to } of mapLinkEnds(map)) {
    if (from !== id && to !== id) continue;
    const words = LINK_WORDS[link.kind][from === id ? 0 : 1];
    const other = held.get(from === id ? to : from)?.label;
    if (other !== undefined) said.set(words, [...(said.get(words) ?? []), other]);
  }
  return [...said].map(([words, others]) => `${words} ${others.join(', ')}.`).join(' ');
}

/** The sizes a map is laid out with, in pixels. */
export interface MapSizes {
  node: { width: number; height: number };
  /** A node with sections: its head, each section's row, and the room under the last. */
  card: { head: number; row: number; foot: number };
  /** Between columns, and between a column's nodes. */
  columnGap: number;
  rowGap: number;
  /** A group's heading, and the room between one group and the next. */
  heading: number;
  groupGap: number;
  /** Around the whole map. */
  padding: number;
}

export interface MapPlace {
  x: number;
  y: number;
}

export interface MapLayout {
  width: number;
  height: number;
  /** Each node's top left corner and height, by id. */
  nodes: Record<string, MapPlace & { height: number }>;
  /** Each group's heading: its top left corner. */
  headings: (MapPlace & { label: string })[];
  /** Each link's line as an SVG path from `link.from` to `link.to`, and the nodes it joins. */
  lines: { link: MapLink; from: string; to: string; d: string }[];
}

/**
 * Where everything on the map goes: the columns side by side from the top, each group under its
 * heading. A line leaves the side of a node that faces the other, level with the section it joins
 * or else with the node's head; between two nodes of one column it bows out to the right.
 */
export function mapLayout(map: WorkspaceMap, sizes: MapSizes): MapLayout {
  const { node, card, columnGap, rowGap, heading, groupGap, padding } = sizes;
  const nodes: MapLayout['nodes'] = {};
  const headings: MapLayout['headings'] = [];
  /** Where a line meets each node or section: the node's left edge and the height it joins at. */
  const ports = new Map<string, MapPlace>();
  let bottom = padding;
  map.columns.forEach((column, index) => {
    const x = padding + index * (node.width + columnGap);
    let y = padding;
    column.forEach((group, at) => {
      if (at > 0) y += groupGap;
      headings.push({ label: group.label, x, y });
      y += heading;
      for (const each of group.nodes) {
        const rows = each.rows ?? [];
        const head = rows.length > 0 ? card.head : node.height;
        const height = rows.length > 0 ? card.head + rows.length * card.row + card.foot : node.height;
        nodes[each.id] = { x, y, height };
        ports.set(each.id, { x, y: y + head / 2 });
        rows.forEach((row, line) => ports.set(row.id, { x, y: y + card.head + line * card.row + card.row / 2 }));
        y += height + rowGap;
      }
      y -= rowGap;
    });
    bottom = Math.max(bottom, y);
  });

  const lines = mapLinkEnds(map).flatMap(({ link, from, to }) => {
    const a = ports.get(link.from);
    const b = ports.get(link.to);
    if (!a || !b) return [];
    if (a.x === b.x) {
      const x = a.x + node.width;
      const bow = x + columnGap / 2;
      return [{ link, from, to, d: `M ${x} ${a.y} C ${bow} ${a.y}, ${bow} ${b.y}, ${x} ${b.y}` }];
    }
    const ax = a.x < b.x ? a.x + node.width : a.x;
    const bx = a.x < b.x ? b.x : b.x + node.width;
    const mid = (ax + bx) / 2;
    return [{ link, from, to, d: `M ${ax} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${bx} ${b.y}` }];
  });

  const columns = Math.max(map.columns.length, 1);
  return {
    width: padding * 2 + columns * node.width + (columns - 1) * columnGap,
    height: bottom + padding,
    nodes,
    headings,
    lines,
  };
}
