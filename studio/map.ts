/**
 * The workspace as a map. Each profile is a card of its sections; what feeds it stands beside it:
 * the providers and models it runs on, the settings the project shares, the tools it may call. A
 * line joins each to the section it feeds. It is read from the workspace and changes nothing; each
 * node and section names the workspace node that opens it.
 */
import { type MapPlace, mapCurve, mapRail } from './map-line.ts';
import { type SharedEntry, sharedOpens } from './shared-settings.ts';
import { modelBindingNodeId, providerNodeId, toolSpecNodeId } from './tree.ts';
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
  /** The workspace node that opens it; unset for a shared setting nothing here uses. */
  opens?: string;
  /** A model: every workspace node it stands for, one for each profile that runs it. */
  holds?: string[];
  /** A model whose label another model has too: its label with what tells the two apart. */
  long?: string;
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
  /**
   * Left to right: providers, what profiles are set with, the profiles, the tools. A column holds
   * only groups with nodes.
   */
  columns: MapGroup[][];
  links: MapLink[];
}

/**
 * `nodes` in the order of what each is joined to in the column beside it (`rows`), so the lines
 * cross less; unjoined ones go last.
 */
function byRows(
  nodes: MapNode[],
  links: readonly MapLink[],
  rows: ReadonlyMap<string, number>,
): MapNode[] {
  const rank = (node: MapNode) => {
    const joined = links
      .flatMap(({ from, to }) => (from === node.id ? [to] : to === node.id ? [from] : []))
      .flatMap((id) => rows.get(id) ?? []);
    return joined.length === 0
      ? Infinity
      : joined.reduce((sum, row) => sum + row, 0) / joined.length;
  };
  const ranks = new Map(nodes.map((node) => [node.id, rank(node)]));
  const at = (node: MapNode) => ranks.get(node.id) ?? Infinity;
  // Two unjoined nodes compare equal (Infinity less Infinity is not a number); the sort is stable.
  return [...nodes].sort((a, b) => (at(a) === at(b) ? 0 : at(a) - at(b)));
}

/** What a section's row says beside its name, where one line can say it. */
function rowNote(agent: AgentDraft, facet: string, tools: ReadonlyMap<string, string>): string {
  if (facet === 'models')
    return agent.modelBindings.map((binding) => binding.modelId || 'New model').join(', ');
  if (facet === 'tools') return String(agent.tools.allow.filter((key) => tools.has(key)).length);
  if (facet === 'outputs') return agent.outputs.mode;
  return '';
}

/** The map of `workspace`, with the settings its project shares. */
export function workspaceMap(
  workspace: StudioWorkspace,
  shared: readonly SharedEntry[] = [],
): WorkspaceMap {
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
  const defined = new Set(workspace.providers.map((provider) => provider.id));
  const models = new Map<string, MapNode>();
  for (const agent of workspace.agents) {
    const to = at(agent.key, 'models');
    for (const binding of agent.modelBindings) {
      // Two agents share a model's node when they name it alike and reach the same model.
      const id = `model:${binding.provider}:${binding.apiId}:${binding.modelId}`;
      const provider = providerNodeId(binding.provider);
      if (!providers.has(provider)) {
        // A provider the workspace does not define opens the first model it serves.
        providers.set(provider, {
          id: provider,
          kind: 'provider',
          label: binding.provider,
          note: '',
          opens: defined.has(binding.provider)
            ? provider
            : agentNodeId(agent.key, modelBindingNodeId(binding.key)),
        });
      }
      const opens = agentNodeId(agent.key, modelBindingNodeId(binding.key));
      const model = models.get(id);
      if (model) model.holds?.push(opens);
      else {
        models.set(id, {
          id,
          kind: 'model',
          label: binding.modelId || 'New model',
          note: binding.apiId,
          opens,
          holds: [opens],
        });
        links.push({ from: provider, to: id, kind: 'serves' });
      }
      if (!links.some((link) => link.from === id && link.to === to))
        links.push({ from: id, to, kind: 'runs' });
      const writer = binding.compactWith ? agentIds.get(binding.compactWith) : undefined;
      const summarised = links.some((link) => link.kind === 'summarised' && link.from === to);
      if (writer && writer !== agentNodeId(agent.key) && !summarised) {
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
    for (const key of users)
      links.push({ from: id, to: facet ? at(key, facet) : agentNodeId(key), kind: 'sets' });
    for (const to of used) links.push({ from: id, to, kind: 'sets' });
    return {
      id,
      kind: 'shared',
      label: setting.label,
      note: `${setting.name} · ${setting.file}:${String(setting.line)}`,
      // It opens where it is changed: the field the files set from it.
      opens: sharedOpens(entry) ?? used[0],
      type: facet,
    };
  });

  // Each agent and its sections by the agent's place; then each model by its own, for the providers.
  const rows = new Map(
    agents.flatMap((agent, row) =>
      [agent.id, ...(agent.rows ?? []).map((each) => each.id)].map((id) => [id, row] as const),
    ),
  );
  for (const model of models.values()) {
    const twin = [...models.values()].some(
      (other) => other !== model && other.label === model.label,
    );
    if (twin && model.note) model.long = `${model.label} · ${model.note}`;
  }
  const ordered = byRows([...models.values()], links, rows);
  const modelRows = new Map(ordered.map((model, row) => [model.id, row]));
  const groups = (...all: MapGroup[]) => all.filter((group) => group.nodes.length > 0);
  const columns = [
    groups({ label: 'Providers', nodes: byRows([...providers.values()], links, modelRows) }),
    groups(
      { label: 'Shared settings', nodes: byRows(settings, links, rows) },
      { label: 'Models', nodes: ordered },
    ),
    groups({ label: 'Profiles', nodes: agents }),
    groups({ label: 'Tools', nodes: byRows(tools, links, rows) }),
  ].filter((column) => column.length > 0);
  return { columns, links };
}

/** Every node and every section, by id, under the node that holds it. */
function owners(map: WorkspaceMap): Map<string, MapNode> {
  const nodes = map.columns.flat().flatMap((group) => group.nodes);
  return new Map(
    nodes.flatMap((node) =>
      [node.id, ...(node.rows ?? []).map((row) => row.id)].map((id) => [id, node]),
    ),
  );
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
  return new Set([
    id,
    ...mapLinkEnds(map).flatMap(({ from, to }) => (from === id ? [to] : to === id ? [from] : [])),
  ]);
}

/** The nodes whose name or note holds `query`, whatever its case: their ids. None for an empty query. */
export function mapFound(map: WorkspaceMap, query: string): string[] {
  const asked = query.trim().toLowerCase();
  if (asked === '') return [];
  return map.columns
    .flat()
    .flatMap((group) => group.nodes)
    .filter((node) =>
      [node.label, node.long ?? '', node.note].some((text) => text.toLowerCase().includes(asked)),
    )
    .map((node) => node.id);
}

/**
 * `id`'s family: the node, everything that feeds it, and everything it feeds, however many links
 * away, with the links between them. Empty when the map has no such node. Several ids give their
 * families together.
 */
export function mapFamily(map: WorkspaceMap, id: string | readonly string[]): WorkspaceMap {
  const ids = typeof id === 'string' ? [id] : id;
  const ends = mapLinkEnds(map);
  const reached = (near: 'from' | 'to', far: 'from' | 'to') => {
    const seen = new Set(ids);
    const queue = [...ids];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const end of ends) {
        if (end[near] !== next || seen.has(end[far])) continue;
        seen.add(end[far]);
        queue.push(end[far]);
      }
    }
    return seen;
  };
  const family = new Set([...reached('to', 'from'), ...reached('from', 'to')]);
  const columns = map.columns
    .map((column) =>
      column
        .map((group) => ({ ...group, nodes: group.nodes.filter((node) => family.has(node.id)) }))
        .filter((group) => group.nodes.length > 0),
    )
    .filter((column) => column.length > 0);
  const kept = new Set(
    ends.filter(({ from, to }) => family.has(from) && family.has(to)).map(({ link }) => link),
  );
  return { columns, links: map.links.filter((link) => kept.has(link)) };
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
  /** A node's slot in its column. Its height is a token's, or with detail a node whose note runs to two lines. */
  node: { width: number; height: number };
  /**
   * With detail, a node with sections: its head, each section's row, and the room under the last.
   * A node with a one-line note is a head alone.
   */
  card: { head: number; row: number; foot: number };
  /** Between columns, and between a column's nodes. */
  columnGap: number;
  rowGap: number;
  /** A group's heading, and the room between one group and the next. */
  heading: number;
  groupGap: number;
  /** Around the whole map. */
  padding: number;
  /** Between a node's side and the line that leaves or arrives there. */
  lineGap: number;
}

export type { MapPlace };

export interface MapView {
  /** Where nodes were put, by id. */
  moved?: Readonly<Record<string, MapPlace>>;
  /** How wide each node is drawn, by id, when narrower than its slot. */
  widths?: Readonly<Record<string, number>>;
  /** Each profile as a card of its sections and a line to the section it joins; else every node is one token. */
  detail?: boolean;
}

/** A link's line as an SVG path from `link.from` to `link.to`, and the nodes it joins. */
export interface MapLine {
  link: MapLink;
  from: string;
  to: string;
  d: string;
}

export interface MapLayout {
  width: number;
  height: number;
  /** Each node's top left corner and height, by id. */
  nodes: Record<string, MapPlace & { height: number }>;
  /** Each group's heading: its top left corner. */
  headings: (MapPlace & { label: string })[];
  lines: MapLine[];
}

/** How many lines of its note a node shows: a tool's description and a shared setting's source run to two. */
export function mapNoteLines(node: MapNode): 1 | 2 {
  return node.kind === 'tool' || node.kind === 'shared' ? 2 : 1;
}

/** How finely a line is walked to see what it crosses, and how far apart lines going round keep. */
const CURVE_STEPS = 24;
const LANE_GAP = 8;
/** How far a rail keeps from the column it is beside, and from the next rail. */
const TURN_GAP = 2 * LANE_GAP;

/** A line between two columns: which way it runs, and the end more lines share, which keeps the rail. */
interface MapSpan {
  link: MapLink;
  way: 1 | -1;
  leaves: boolean;
  hub: string;
}

/** Each link whose ends stand `apart` or more from each other by `at`, as its span. */
function mapSpans(
  map: WorkspaceMap,
  at: (id: string) => number | undefined,
  apart: number,
): MapSpan[] {
  const fans = new Map<string, number>();
  const fan = (id: string, way: number) => `${id}:${String(way)}`;
  const across = mapLinkEnds(map).flatMap(({ link }) => {
    const [a, b] = [at(link.from), at(link.to)];
    if (a === undefined || b === undefined || Math.abs(a - b) < apart) return [];
    const way = a < b ? 1 : -1;
    for (const key of [fan(link.from, way), fan(link.to, -way)])
      fans.set(key, (fans.get(key) ?? 0) + 1);
    return [{ link, way } as const];
  });
  return across.map(({ link, way }) => {
    const [out, into] = [fan(link.from, way), fan(link.to, -way)];
    const leaves = (fans.get(out) ?? 0) >= (fans.get(into) ?? 0);
    return { link, way, leaves, hub: leaves ? out : into };
  });
}

interface Box extends MapPlace {
  id: string;
  width: number;
  height: number;
}

interface Port {
  left: number;
  right: number;
  y: number;
}

/**
 * Where everything on the map goes: the columns side by side from the top, each group under its
 * heading, except a node in `moved`, which goes where it was put. A line leaves the side of a node
 * that faces the other; between two nodes one above the other it bows out to the right, past what
 * stands between them. Between two columns the lines that share an end run as one, and part beside
 * the end fewer lines share, each end's lines along a rail of their own: two columns stand far enough
 * apart for the rails between them. A line that would pass behind a node or a heading goes over or under only
 * what is in its way, whichever is nearer. The map is large enough for every line.
 */
export function mapLayout(map: WorkspaceMap, sizes: MapSizes, view: MapView = {}): MapLayout {
  const { node, card, columnGap, rowGap, heading, groupGap, padding, lineGap } = sizes;
  const { moved = {}, widths = {}, detail = false } = view;
  /** The column each node and section stands in, unless it was moved out of it. */
  const columnOf = new Map<string, number>();
  map.columns.forEach((column, index) => {
    for (const group of column)
      for (const each of group.nodes)
        if (!Object.hasOwn(moved, each.id))
          for (const id of [each.id, ...(each.rows ?? []).map((row) => row.id)])
            columnOf.set(id, index);
  });
  const put = (lefts: number[]) => {
    const nodes: MapLayout['nodes'] = {};
    const headings: MapLayout['headings'] = [];
    const boxes: Box[] = [];
    /** Where a line meets each node or section: the node's two sides and the height it joins at. */
    const ports = new Map<string, Port>();
    let right = 0;
    let bottom = 0;
    map.columns.forEach((column, index) => {
      const x = lefts[index] ?? padding;
      let y = padding;
      column.forEach((group, at) => {
        if (at > 0) y += groupGap;
        headings.push({ label: group.label, x, y });
        boxes.push({ id: `heading:${index}:${at}`, x, y, width: node.width, height: heading });
        y += heading;
        for (const each of group.nodes) {
          const rows = detail ? (each.rows ?? []) : [];
          // With detail a node's name is one row, as a token is; one with no note is that row alone.
          const noted = rows.length > 0 || each.note !== '';
          const full =
            detail && (rows.length > 0 || mapNoteLines(each) === 1) ? card.head : node.height;
          const head = detail && !noted ? card.row : full;
          const height = rows.length > 0 ? card.head + rows.length * card.row + card.foot : head;
          const width = Math.min(widths[each.id] ?? node.width, node.width);
          const put = Object.hasOwn(moved, each.id) ? moved[each.id] : undefined;
          const place = put ? { x: Math.max(put.x, 0), y: Math.max(put.y, 0) } : { x, y };
          nodes[each.id] = { ...place, height };
          boxes.push({ id: each.id, ...place, width, height });
          const port = {
            left: place.x,
            right: place.x + width,
            y: place.y + (detail ? card.row : head) / 2,
          };
          ports.set(each.id, port);
          for (const [line, row] of (each.rows ?? []).entries())
            ports.set(
              row.id,
              detail ? { ...port, y: place.y + card.head + line * card.row + card.row / 2 } : port,
            );
          right = Math.max(right, place.x + node.width);
          bottom = Math.max(bottom, place.y + height);
          // A moved node leaves its place in the column open, so the rest hold still.
          y += height + rowGap;
        }
        y -= rowGap;
      });
    });
    return { nodes, headings, boxes, ports, right, bottom };
  };

  /** Where a line between two columns starts and ends, and the side its rails are counted from, and which way. */
  const reach = (span: MapSpan, a: Port, b: Port) => {
    const { way, leaves } = span;
    const start = { x: way > 0 ? a.right + lineGap : a.left - lineGap, y: a.y };
    const end = { x: way > 0 ? b.left - lineGap : b.right + lineGap, y: b.y };
    const fromSide = way > 0 ? Math.max(a.left + node.width, a.right) + lineGap : start.x;
    const toSide = way > 0 ? end.x : Math.max(b.left + node.width, b.right) + lineGap;
    const side = leaves ? toSide : fromSide;
    const into = leaves ? -way : way;
    return {
      start,
      end,
      side,
      into,
      room: Math.abs(toSide - fromSide),
      strip: `${String(side)}:${String(into)}`,
    };
  };
  /**
   * The rail each end's lines part on, counted from the side of the column they part beside, and how
   * many rails each side holds. Two ends share a rail where neither's lines reach the other's.
   */
  const railed = (ports: Map<string, Port>) => {
    const spans = new Map(
      mapSpans(map, (id) => ports.get(id)?.left, node.width).map((span) => [span.link, span]),
    );
    const strips = new Map<string, Map<string, { y: number; joins: number[]; beside: string }>>();
    for (const span of spans.values()) {
      const a = ports.get(span.link.from);
      const b = ports.get(span.link.to);
      if (!a || !b || a.y === b.y) continue;
      const { strip } = reach(span, a, b);
      const ends =
        strips.get(strip) ?? new Map<string, { y: number; joins: number[]; beside: string }>();
      const beside = span.leaves ? span.link.to : span.link.from;
      const end = ends.get(span.hub) ?? { y: span.leaves ? a.y : b.y, joins: [], beside };
      end.joins.push(span.leaves ? b.y : a.y);
      strips.set(strip, ends.set(span.hub, end));
    }
    const rails = new Map<string, number>();
    const held = new Map<string, { count: number; beside: string; into: number }>();
    for (const [strip, ends] of strips) {
      const mean = (all: number[]) => all.reduce((sum, y) => sum + y, 0) / all.length;
      const all = [...ends.values()];
      const down = mean(all.flatMap((end) => end.joins)) >= mean(all.map((end) => end.y));
      const taken: { low: number; high: number }[][] = [];
      // The end nearest what the strip joins takes the first rail, so its trunk crosses the fewest.
      for (const [hub, end] of [...ends].sort(([, one], [, other]) =>
        down ? one.y - other.y : other.y - one.y,
      )) {
        const low = Math.min(end.y, ...end.joins) - LANE_GAP;
        const high = Math.max(end.y, ...end.joins) + LANE_GAP;
        const free = taken.findIndex((spansOf) =>
          spansOf.every((each) => high < each.low || low > each.high),
        );
        const rail = free < 0 ? taken.length : free;
        taken[rail] = [...(taken[rail] ?? []), { low, high }];
        rails.set(`${strip}:${hub}`, rail);
      }
      const [first] = all;
      if (first)
        held.set(strip, {
          count: taken.length,
          beside: first.beside,
          into: Number(strip.split(':')[1]),
        });
    }
    return { spans, rails, held };
  };

  // Heights do not turn on where the columns stand: lay them out once to count each side's rails, then
  // give each pair of columns the room for both sides' rails.
  const even = map.columns.map((_, index) => padding + index * (node.width + columnGap));
  const rooms = map.columns.map(() => 0);
  for (const { count, beside, into } of railed(put(even).ports).held.values()) {
    const column = columnOf.get(beside);
    if (column === undefined) continue;
    const after = into > 0 ? column : column - 1;
    if (after >= 0 && after < rooms.length) rooms[after] = (rooms[after] ?? 0) + count + 1;
  }
  const lefts = [padding];
  for (const [index, held] of rooms.entries())
    lefts.push((lefts[index] ?? padding) + node.width + Math.max(columnGap, held * TURN_GAP));
  const laidOut = put(lefts);
  const { nodes, headings, boxes, ports } = laidOut;
  let { right, bottom } = laidOut;
  const { spans, rails } = railed(ports);

  const gap = columnGap / 2;
  /** How far a line going round keeps from what it goes round. */
  const clear = Math.max(rowGap / 2, lineGap);
  /** The lanes lines already go round in: the next one keeps `LANE_GAP` clear of each. */
  const laid: Box[] = [];
  /** The lane the lines of one end take round a column: they go round as one. */
  const lanes = new Map<string, number>();
  const widest = Math.max(columnGap, ...rooms.map((held) => held * TURN_GAP));

  const lines = mapLinkEnds(map).flatMap(({ link, from, to }): MapLine[] => {
    const a = ports.get(link.from);
    const b = ports.get(link.to);
    if (!a || !b) return [];
    const others = boxes.filter((box) => box.id !== from && box.id !== to);

    if (Math.abs(a.left - b.left) < node.width) {
      const ax = a.right + lineGap;
      const bx = b.right + lineGap;
      const beside = others.filter(
        (box) =>
          box.y < Math.max(a.y, b.y) &&
          box.y + box.height > Math.min(a.y, b.y) &&
          box.x < Math.max(ax, bx) + gap &&
          box.x + box.width > Math.min(a.left, b.left),
      );
      const bow = Math.max(ax, bx, ...beside.map((box) => box.x + box.width)) + gap;
      right = Math.max(right, bow);
      return [{ link, from, to, d: mapCurve({ x: ax, y: a.y }, { x: bx, y: b.y }, bow).d }];
    }

    const span = spans.get(link);
    if (!span) return [];
    const { way, leaves, hub } = span;
    const { start, end, side, into, room, strip } = reach(span, a, b);
    // The lines of one end part on a rail beside the end fewer lines share.
    const step = Math.min(
      (1 + (rails.get(`${strip}:${hub}`) ?? 0)) * TURN_GAP,
      Math.max(room - TURN_GAP, 0),
    );
    const rail = side + into * step;
    const curve = room < 2 * TURN_GAP ? mapCurve(start, end) : mapRail(start, end, rail, LANE_GAP);
    const near = (box: Box, y: number) => y > box.y - clear && y < box.y + box.height + clear;
    const crossed =
      Math.abs(end.x - start.x) < widest + columnGap
        ? []
        : others.filter((box) =>
            Array.from({ length: CURVE_STEPS - 1 }, (_, step) =>
              curve.at((step + 1) / CURVE_STEPS),
            ).some((point) => point.x > box.x && point.x < box.x + box.width && near(box, point.y)),
          );
    if (crossed.length === 0) return [{ link, from, to, d: curve.d }];

    const [low, high] = [Math.min(start.x, end.x), Math.max(start.x, end.x)];
    /** The lane on one side of what the line crossed, and of whatever stands in that lane's way. */
    const lane = (side: 1 | -1): number => {
      const around = [...crossed];
      for (;;) {
        const y =
          side < 0
            ? Math.min(...around.map((box) => box.y)) - clear
            : Math.max(...around.map((box) => box.y + box.height)) + clear;
        const more = [...others, ...laid].filter(
          (box) => !around.includes(box) && box.x < high && box.x + box.width > low && near(box, y),
        );
        if (more.length === 0) return y;
        around.push(...more);
      }
    };
    const far = (y: number) => Math.abs(a.y - y) + Math.abs(b.y - y);
    const shared = `${hub}:${strip}`;
    const pick = () => {
      const [over, under] = [lane(-1), lane(1)];
      const y = over >= 0 && far(over) <= far(under) ? over : under;
      laid.push({
        id: '',
        x: low,
        y: y - LANE_GAP + clear,
        width: high - low,
        height: 2 * (LANE_GAP - clear),
      });
      lanes.set(shared, y);
      return y;
    };
    const y = lanes.get(shared) ?? pick();
    bottom = Math.max(bottom, y);
    // Round a column on rails too: out beside its own end, back in beside the other.
    const out = leaves ? start.x + way * TURN_GAP : rail;
    const back = leaves ? rail : end.x - way * TURN_GAP;
    const mid = { x: (out + back) / 2, y };
    const d =
      mapRail(start, mid, out, LANE_GAP).d +
      mapRail(mid, end, back, LANE_GAP).d.replace(/^M \S+ \S+/, '');
    return [{ link, from, to, d }];
  });

  return {
    width:
      Math.max((lefts[Math.max(map.columns.length - 1, 0)] ?? padding) + node.width, right) +
      padding,
    height: Math.max(bottom, padding) + padding,
    nodes,
    headings,
    lines,
  };
}
