/**
 * The workspace as a map: its shared settings, models, agents and tools in columns, and what joins
 * them. It is read from the workspace and changes nothing; each node names the workspace node that
 * opens it.
 */
import { type SharedEntry, sharedNodeId } from './shared-settings.ts';
import { modelBindingNodeId, toolSpecNodeId } from './tree.ts';
import { agentNodeId, type StudioWorkspace } from './workspace.ts';

export type MapNodeKind = 'shared' | 'model' | 'agent' | 'tool';

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  label: string;
  /** Under the label: a tool's description, a model's provider and id, where a setting is declared. */
  note: string;
  /** The workspace node that opens it; unset for a shared setting nothing here uses. */
  opens?: string;
  /** An agent's profile type, a tool's type, or the section a shared setting fills. */
  type?: string;
}

/**
 * What joins two nodes, read from `from` to `to`:
 * - `sets`: a shared setting sets part of an agent or a tool.
 * - `runs`: a model runs an agent.
 * - `allows`: an agent may call a tool.
 * - `asks`: an agent tool asks its agent.
 * - `summarised`: an agent has another agent write its summaries.
 */
export type MapLinkKind = 'sets' | 'runs' | 'allows' | 'asks' | 'summarised';

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
  /** Left to right: what agents are set with, the agents, the tools. A column holds only groups with nodes. */
  columns: MapGroup[][];
  links: MapLink[];
}

/** `nodes` in the order of the agents each is joined to, so the lines cross less; unjoined ones go last. */
function byAgents(nodes: MapNode[], links: readonly MapLink[], rows: ReadonlyMap<string, number>): MapNode[] {
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

/** The map of `workspace`, with the settings its project shares. */
export function workspaceMap(workspace: StudioWorkspace, shared: readonly SharedEntry[] = []): WorkspaceMap {
  const links: MapLink[] = [];
  const agentIds = new Map(workspace.agents.map((agent) => [agent.key, agentNodeId(agent.key)]));
  const toolIds = new Map(workspace.toolSpecs.map((tool) => [tool.key, toolSpecNodeId(tool.key)]));

  const agents = workspace.agents.map((agent): MapNode => {
    const { agentId, profileType, handle } = agent.identity;
    const type = profileType || 'text';
    return {
      id: agentNodeId(agent.key),
      kind: 'agent',
      label: agentId || 'New agent',
      note: handle ? `${type} · ${handle}` : type,
      opens: agentNodeId(agent.key),
      type,
    };
  });

  const models = new Map<string, MapNode>();
  for (const agent of workspace.agents) {
    const to = agentNodeId(agent.key);
    for (const binding of agent.modelBindings) {
      // Two agents share a model's node when they name it alike and reach the same model.
      const id = `model:${binding.provider}:${binding.apiId}:${binding.modelId}`;
      if (!models.has(id)) {
        models.set(id, {
          id,
          kind: 'model',
          label: binding.modelId || 'New model',
          note: [binding.provider, binding.apiId || binding.protocol].join(' · '),
          opens: agentNodeId(agent.key, modelBindingNodeId(binding.key)),
        });
      }
      if (!links.some((link) => link.from === id && link.to === to)) links.push({ from: id, to, kind: 'runs' });
      const writer = binding.compactWith ? agentIds.get(binding.compactWith) : undefined;
      if (writer && writer !== to && !links.some((link) => link.kind === 'summarised' && link.from === to)) {
        links.push({ from: to, to: writer, kind: 'summarised' });
      }
    }
    for (const key of agent.tools.allow) {
      const tool = toolIds.get(key);
      if (tool) links.push({ from: to, to: tool, kind: 'allows' });
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
    for (const key of users) links.push({ from: id, to: agentNodeId(key), kind: 'sets' });
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

  const rows = new Map(agents.map((agent, row) => [agent.id, row]));
  const groups = (...all: MapGroup[]) => all.filter((group) => group.nodes.length > 0);
  const columns = [
    groups(
      { label: 'Shared settings', nodes: byAgents(settings, links, rows) },
      { label: 'Models', nodes: byAgents([...models.values()], links, rows) },
    ),
    groups({ label: 'Agents', nodes: agents }),
    groups({ label: 'Tools', nodes: byAgents(tools, links, rows) }),
  ].filter((column) => column.length > 0);
  return { columns, links };
}

/** `id` and every node a link joins it to. */
export function mapNeighbours(map: WorkspaceMap, id: string): Set<string> {
  return new Set([id, ...map.links.flatMap(({ from, to }) => (from === id ? [to] : to === id ? [from] : []))]);
}

/** A link in words from each end: `[from's side, to's side]`, each before the other node's label. */
const LINK_WORDS = {
  sets: ['Sets', 'Set by'],
  runs: ['Runs', 'Runs on'],
  allows: ['Allows', 'Allowed by'],
  asks: ['Asks', 'Asked by'],
  summarised: ['Summarised by', 'Summarises for'],
} as const satisfies Record<MapLinkKind, readonly [string, string]>;

/** What joins a node to the rest, in words: "Runs on gemini-2.5-flash. Allows get_weather, find_plant." */
export function mapLinkWords(map: WorkspaceMap, id: string): string {
  const labels = new Map(map.columns.flat().flatMap((group) => group.nodes).map((node) => [node.id, node.label]));
  const said = new Map<string, string[]>();
  for (const { from, to, kind } of map.links) {
    if (from !== id && to !== id) continue;
    const words = LINK_WORDS[kind][from === id ? 0 : 1];
    const other = labels.get(from === id ? to : from);
    if (other !== undefined) said.set(words, [...(said.get(words) ?? []), other]);
  }
  return [...said].map(([words, others]) => `${words} ${others.join(', ')}.`).join(' ');
}

/** The sizes a map is laid out with, in pixels. */
export interface MapSizes {
  node: { width: number; height: number };
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
  /** Each node's top left corner, by id. */
  nodes: Record<string, MapPlace>;
  /** Each group's heading: its top left corner. */
  headings: (MapPlace & { label: string })[];
  /** Each link's line as an SVG path, from `link.from` to `link.to`. */
  lines: { link: MapLink; d: string }[];
}

/**
 * Where everything on the map goes: the columns side by side from the top, each group under its
 * heading. A line leaves the side of a node that faces the other; between two nodes of one column
 * it bows out to the right.
 */
export function mapLayout(map: WorkspaceMap, sizes: MapSizes): MapLayout {
  const { node, columnGap, rowGap, heading, groupGap, padding } = sizes;
  const nodes: Record<string, MapPlace> = {};
  const headings: MapLayout['headings'] = [];
  let bottom = padding;
  map.columns.forEach((column, index) => {
    const x = padding + index * (node.width + columnGap);
    let y = padding;
    column.forEach((group, at) => {
      if (at > 0) y += groupGap;
      headings.push({ label: group.label, x, y });
      y += heading;
      for (const each of group.nodes) {
        nodes[each.id] = { x, y };
        y += node.height + rowGap;
      }
      y -= rowGap;
    });
    bottom = Math.max(bottom, y);
  });

  const lines = map.links.flatMap((link) => {
    const a = nodes[link.from];
    const b = nodes[link.to];
    if (!a || !b) return [];
    const ay = a.y + node.height / 2;
    const by = b.y + node.height / 2;
    if (a.x === b.x) {
      const x = a.x + node.width;
      const bow = x + columnGap / 2;
      return [{ link, d: `M ${x} ${ay} C ${bow} ${ay}, ${bow} ${by}, ${x} ${by}` }];
    }
    const ax = a.x < b.x ? a.x + node.width : a.x;
    const bx = a.x < b.x ? b.x : b.x + node.width;
    const mid = (ax + bx) / 2;
    return [{ link, d: `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}` }];
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
