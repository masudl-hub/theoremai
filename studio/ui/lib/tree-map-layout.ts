/**
 * Where each node of the tree map stands, closed and grown, and how far each node growing adds has
 * drawn: the part of `tree-map.tsx` that is not drawing, so its motion can be checked without a page.
 *
 * invariant: Grown, every node keeps its place in its column's order and every gap stays a row or
 * more, so no node passes through another on the way; a node growing adds shows only once nothing
 * stands where it is.
 */
import { type StudioTreeNode, type StudioWorkspace, workspaceTree } from '../../mod.ts';

/** A row's height closed; grown, the least and the most it stretches to, to fill the box it fits. */
const ROW = 32;
const GROWN_ROW = 28;
const TALLEST_ROW = 40;
/** How far in each level of the tree starts. */
export const INDENT = 28;
/** A token's half height. */
export const HALF = 11;
export const PAD = 16;
/** Closed, between the tree's widest row and the feeds; grown, the least and most between columns. */
const GAP = 72;
const LEAST_GAP = 56;
const MOST_GAP = 160;
/** The least room between two lanes. */
const LANE = 9;
/** The tools beside a Tools row: the first of each type. */
const TOOL_TYPES = ['function', 'http', 'mcp', 'agent'];
/** The tools a remote call reaches the network for. */
const REMOTE_TYPES = ['http', 'mcp'];
/** By how far grown every node has reached its zone; the rest is for drawing in. */
export const MOVE_TO = 0.7;
/** Over what stretch of growing the added nodes draw, and how long each takes of it. */
const DRAW_FROM = 0.2;
const DRAW_TO = 0.95;
const DRAW_SPAN = 0.1;
/** How finely growing is walked to find where an added node first stands clear. */
const SAMPLES = 100;
/** Space kept clear round a token. */
const CLEAR = 2;

export const RUNNER = 'runner';
export const TOOL_RUNNER = 'tool-runner';
export const TRACE_DESTINATIONS = 'trace-destinations';

export interface Place {
  x: number;
  y: number;
}

export interface Row extends Place {
  node: StudioTreeNode;
  agent: string;
  /** The row above it in the tree, by its token id. */
  parent?: string;
}

export type FeedKind =
  | 'runner'
  | 'step'
  | 'provider'
  | 'protocol'
  | 'tool'
  | 'branch'
  | 'subagent'
  | 'tool-runner'
  | 'check'
  | 'destinations';

/** What feeds the tree: a tool, the runner, a provider, the tool runner, or one of their own nested under them. */
export interface Feed {
  id: string;
  label: string;
  kind: FeedKind;
  /** A tool's type, a subagent's profile type, or a step's or a check's id: what its icon is. */
  of?: string;
  /** What it has a line from: tree rows, and feeds in a column left of it. */
  from: string[];
  /** Tree rows it has a line from that draw in with the first feed under it. */
  late?: string[];
  /** The feed it is one of, a level in under it. */
  under?: string;
  /** Until it draws, its lines run to the feed it is under, and move to it as it draws. */
  closedUnder?: boolean;
  /** The column it stands in beside the tree: the tools, the runner, or what they share underneath. */
  column: 1 | 2 | 3;
  /** Feeds that stand together, with a gap before the next group. */
  group: string;
}

/**
 * What the runner does in a turn, in order: the steps of the kernel contract's turn lifecycle
 * (docs/contracts/kernel.md, "Turn lifecycle") that do work, and the profile sections each reads.
 * why: The canary bind runs only while a canary detector is on, and pre_turn, before_end and
 * post_turn are hooks for the host's stages, so the map leaves those four out.
 */
export const TURN_STEPS: readonly { id: string; label: string; reads: readonly string[] }[] = [
  { id: 'resolve', label: 'Setup', reads: ['inputs', 'models'] },
  { id: 'sanitize', label: 'Sanitize', reads: ['guardrails'] },
  { id: 'stream', label: 'Provider stream', reads: [] },
  { id: 'tools', label: 'Tool loop', reads: ['tools'] },
  { id: 'validation', label: 'Validation', reads: ['outputs'] },
  { id: 'egress', label: 'Egress', reads: ['guardrails'] },
  { id: 'trace', label: 'Telemetry', reads: ['observability'] },
];

/** The profile sections the runner reads whole, not at one step. */
const RUNNER_READS = ['turnBehaviour', 'decision', 'labels'];

/**
 * What the tool runner does with every call, in order (`executeRegisteredTool`): its permission,
 * its sign-in, the network a remote call reaches, the MCP session an MCP call runs in, and the
 * guard on its result.
 */
export const TOOL_CHECKS: readonly { id: string; label: string }[] = [
  { id: 'permission', label: 'Permission gate' },
  { id: 'sign-in', label: 'Sign-in' },
  { id: 'network', label: 'Network check' },
  { id: 'sessions', label: 'MCP sessions' },
  { id: 'result', label: 'Result guard' },
];

/** Closed, the map shows only these heads beside the tree, in this order. */
const CLOSED: readonly FeedKind[] = ['provider', 'tool', 'runner'];

/** A row's token id: the tree's ids repeat from one agent to the next. */
export function rowId(row: Row): string {
  return `${row.agent}/${row.node.id}`;
}

function rowsOf(workspace: StudioWorkspace, only?: readonly string[]): Row[] {
  const rows: Row[] = [];
  const walk = (node: StudioTreeNode, agent: string, depth: number, parent?: Row) => {
    const row: Row = {
      node,
      agent,
      x: PAD + depth * INDENT,
      y: PAD + HALF + rows.length * ROW,
      ...(parent ? { parent: rowId(parent) } : {}),
    };
    rows.push(row);
    for (const child of node.children) walk(child, agent, depth + 1, row);
  };
  workspaceTree(workspace).agents.forEach((root, index) => {
    const key = workspace.agents[index]?.key ?? '';
    if (only === undefined || only.includes(key)) walk(root, key, 0);
  });
  return rows;
}

/**
 * Beside the tree, shared by every agent drawn, three columns. First, the first tool of each type
 * the agents allow, with a line from each Tools row that allows it, and an agent tool's agent under
 * it. Then the one runner, with a line from each agent but a host (whose calls the tool runner
 * runs), from an agent tool's agent and from the sections it reads whole; its steps one list under
 * it, each with a line from the sections it reads. Last, what they share underneath: each provider
 * with a line from the provider stream, the protocols its models speak under it, each with a line
 * from those models; the tool runner, with a line from the tool loop and each tool, what it does
 * with each call under it; and the trace's destinations.
 */
function feedsOf(workspace: StudioWorkspace, rows: Row[]): Feed[] {
  const drawn = workspace.agents.filter((agent) => rows.some((row) => row.agent === agent.key));
  const rowOf = (agent: string, facet: string, key?: string) =>
    rows.find(
      (row) =>
        row.agent === agent &&
        row.node.ref.facet === facet &&
        (key === undefined || ('key' in row.node.ref && row.node.ref.key === key)),
    );
  const sections = (facets: readonly string[]) =>
    rows.filter((row) => facets.includes(row.node.ref.facet)).map(rowId);
  const feeds: Feed[] = [];

  const allowing = (key: string) =>
    drawn.flatMap((agent) => {
      const row = agent.tools.allow.includes(key) ? rowOf(agent.key, 'tools') : undefined;
      return row ? [rowId(row)] : [];
    });
  const tools: { id: string; spec: StudioWorkspace['toolSpecs'][number] }[] = [];
  const subagents: string[] = [];
  for (const type of TOOL_TYPES) {
    const spec = workspace.toolSpecs.find(
      (each) => each.toolType === type && allowing(each.key).length > 0,
    );
    if (!spec) continue;
    const id = `tool:${spec.key}`;
    tools.push({ id, spec });
    const from = allowing(spec.key);
    feeds.push({
      id,
      label: spec.toolName,
      kind: 'tool',
      of: type,
      from,
      column: 1,
      group: 'tools',
    });
    const agent = workspace.agents.find((each) => each.key === spec.agentKey);
    if (type === 'agent' && agent) {
      const label = agent.identity.agentId || agent.identity.handle;
      subagents.push(`${id}/agent`);
      feeds.push({
        id: `${id}/agent`,
        label,
        kind: 'subagent',
        of: agent.identity.profileType,
        from: [],
        under: id,
        column: 1,
        group: 'tools',
      });
    }
  }

  const runs = drawn.flatMap((agent) => {
    const row = agent.identity.profileType === 'host' ? undefined : rowOf(agent.key, 'identity');
    return row ? [rowId(row)] : [];
  });
  feeds.push({
    id: RUNNER,
    label: 'Runner',
    kind: 'runner',
    from: [...runs, ...subagents],
    late: sections(RUNNER_READS),
    column: 2,
    group: 'runner',
  });
  for (const step of TURN_STEPS) {
    feeds.push({
      id: `${RUNNER}/${step.id}`,
      label: step.label,
      kind: 'step',
      of: step.id,
      from: sections(step.reads),
      under: RUNNER,
      column: 2,
      group: 'runner',
    });
  }

  const providers = new Map<string, Map<string, string[]>>();
  for (const agent of drawn) {
    for (const binding of agent.modelBindings) {
      const row = rowOf(agent.key, 'modelBinding', binding.key);
      if (!row) continue;
      const protocols = providers.get(binding.provider) ?? new Map<string, string[]>();
      protocols.set(binding.protocol, [...(protocols.get(binding.protocol) ?? []), rowId(row)]);
      providers.set(binding.provider, protocols);
    }
  }
  for (const [provider, protocols] of providers) {
    const id = `provider:${provider}`;
    const stream = `${RUNNER}/stream`;
    feeds.push({
      id,
      label: provider,
      kind: 'provider',
      from: [stream],
      column: 3,
      group: 'providers',
    });
    for (const [protocol, models] of protocols) {
      feeds.push({
        id: `${id}/${protocol}`,
        label: protocol,
        kind: 'protocol',
        from: models,
        under: id,
        closedUnder: true,
        column: 3,
        group: 'providers',
      });
    }
  }

  const toolsOf = (types: readonly string[]) =>
    tools.filter(({ spec }) => types.includes(spec.toolType)).map(({ id }) => id);
  const guardrails = sections(['guardrails']);
  const checkFrom: Record<string, string[]> = {
    'sign-in': tools.filter(({ spec }) => (spec.authType ?? 'none') !== 'none').map(({ id }) => id),
    network: [...toolsOf(REMOTE_TYPES), ...guardrails],
    sessions: toolsOf(['mcp']),
    result: guardrails,
  };
  feeds.push({
    id: TOOL_RUNNER,
    label: 'Tool runner',
    kind: 'tool-runner',
    from: [`${RUNNER}/tools`, ...tools.map(({ id }) => id)],
    column: 3,
    group: 'tool-runner',
  });
  for (const check of TOOL_CHECKS) {
    feeds.push({
      id: `${TOOL_RUNNER}/${check.id}`,
      label: check.label,
      kind: check.id === 'sessions' ? 'branch' : 'check',
      of: check.id,
      from: checkFrom[check.id] ?? [],
      under: TOOL_RUNNER,
      column: 3,
      group: 'tool-runner',
    });
  }
  feeds.push({
    id: TRACE_DESTINATIONS,
    label: 'Trace destinations',
    kind: 'destinations',
    from: [`${RUNNER}/trace`],
    column: 3,
    group: 'trace',
  });
  return feeds;
}

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
const between = (from: number, to: number, at: number) => from + (to - from) * at;

/** Where a node under a feed sits from it: across, and rows down. */
export interface Slot {
  holder: string;
  across: number;
  down: number;
}

/** A node under a feed a level in, a row down for each before it. */
function slotsOf(feeds: Feed[]): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const counts = new Map<string, number>();
  for (const feed of feeds) {
    if (feed.under === undefined) continue;
    const index = counts.get(feed.under) ?? 0;
    counts.set(feed.under, index + 1);
    // why: Tools stand as one straight list, so a tool under a tool is not set in from it.
    const across = feed.column === 1 ? 0 : INDENT;
    slots.set(feed.id, { holder: feed.under, across, down: index + 1 });
  }
  return slots;
}

/** A run of nodes down one column: so many rows, in groups with a gap between. */
interface Stack {
  ids: string[][];
  rows: number;
}

/** Each column's groups of heads, and how many rows each group holds with what is under its heads. */
function stacksOf(rows: Row[], feeds: Feed[], slots: Map<string, Slot>) {
  const held = new Map<string, number>();
  for (const slot of slots.values()) {
    held.set(slot.holder, Math.max(held.get(slot.holder) ?? 0, slot.down));
  }
  const stack = (groups: Map<string, string[]>): Stack => {
    const ids = [...groups.values()];
    const count = ids.flat().reduce((sum, id) => sum + 1 + (held.get(id) ?? 0), 0);
    return { ids, rows: count };
  };
  const tree = new Map<string, string[]>();
  for (const row of rows) tree.set(row.agent, [...(tree.get(row.agent) ?? []), rowId(row)]);
  const columns = ([1, 2, 3] as const).map((column) => {
    const groups = new Map<string, string[]>();
    for (const feed of feeds) {
      if (feed.column !== column || feed.under !== undefined) continue;
      groups.set(feed.group, [...(groups.get(feed.group) ?? []), feed.id]);
    }
    return stack(groups);
  });
  return { held, columns: [stack(tree), ...columns] };
}

/** The box the map fills grown: its width and height. */
export interface Box {
  width: number;
  height: number;
}

/**
 * The map grown: the tree, each agent a zone of its own; beside it the tools, then the runner, then
 * what they share underneath. Rows stretch, up to a most, and the gaps between columns and
 * between groups widen, so the map fills `box`; without one, rows and gaps are at their least.
 */
function grownPlaces(
  rows: Row[],
  feeds: Feed[],
  slots: Map<string, Slot>,
  width: (id: string) => number,
  box: Box | undefined,
) {
  const { held, columns } = stacksOf(rows, feeds, slots);
  // In rows, from the top node's middle to the bottom one's, each gap at its least of a row.
  const span = Math.max(...columns.map((each) => each.rows + each.ids.length - 2));
  const room = box ? box.height - 2 * (PAD + HALF) : 0;
  const row = Math.min(Math.max(room / Math.max(span, 1), GROWN_ROW), TALLEST_ROW);
  const height = Math.max(room, span * row);

  const right = (id: string, x: number) => x + width(id);
  const treeRight = Math.max(0, ...rows.map((each) => right(rowId(each), each.x)));
  const columnWidth = (column: 1 | 2 | 3) =>
    Math.max(
      0,
      ...feeds
        .filter((feed) => feed.column === column)
        .map((feed) => {
          const slot = slots.get(feed.id);
          return right(feed.id, slot ? slot.across : 0);
        }),
    );
  const [first, second, third] = [columnWidth(1), columnWidth(2), columnWidth(3)];
  const taken = treeRight - PAD + first + second + third;
  // A gap is wide enough for a lane into each feed of the column after it, and the spare is shared.
  const gaps = ([1, 2, 3] as const).map((column) => {
    const lanes = feeds.filter(
      (feed) => feed.column === column && feed.from.length + (feed.late?.length ?? 0) > 0,
    ).length;
    return Math.max(LEAST_GAP, (lanes + 1) * LANE);
  });
  const [one = 0, two = 0, three = 0] = gaps;
  const spare = box ? Math.max(0, box.width - 2 * PAD - taken - one - two - three) / 3 : 0;
  const widen = (gap: number) => Math.max(gap, Math.min(gap + spare, MOST_GAP));
  const lefts = [
    0,
    treeRight + widen(one),
    treeRight + widen(one) + first + widen(two),
    treeRight + widen(one) + first + widen(two) + second + widen(three),
  ];

  const places = new Map<string, Place>();
  const tree = new Map(rows.map((each) => [rowId(each), each]));
  const start = PAD + HALF;
  // The tree: its agents spread down the map, the gaps between them widened to fill it.
  const [agents] = columns;
  const free = height - ((agents?.rows ?? 1) - 1) * row;
  const extra = (agents?.ids.length ?? 0) > 1 ? free / ((agents?.ids.length ?? 1) - 1) : free / 2;
  let y = start + ((agents?.ids.length ?? 0) > 1 ? 0 : free / 2);
  for (const group of agents?.ids ?? []) {
    for (const id of group) {
      places.set(id, { x: tree.get(id)?.x ?? 0, y });
      y += row;
    }
    y += extra;
  }
  const yOf = (id: string): number | undefined => {
    const slot = slots.get(id);
    if (!slot) return places.get(id)?.y;
    const holder = yOf(slot.holder);
    return holder === undefined ? undefined : holder + slot.down * row;
  };
  // invariant: Every line runs from a column left of its feed, so each column's sources stand
  // before it is placed.
  columns.slice(1).forEach((stack, index) => {
    const blocks = stack.ids.map((group) => {
      const offsets = new Map<string, number>();
      let size = 0;
      for (const id of group) {
        offsets.set(id, size);
        for (const [nested, slot] of slots) {
          if (slot.holder === id) offsets.set(nested, size + slot.down * row);
        }
        size += row * (1 + (held.get(id) ?? 0));
      }
      // Level with what it has lines from: each line pulls its feed toward its source's row.
      const pulls = feeds
        .filter((feed) => offsets.has(feed.id))
        .flatMap((feed) =>
          [...feed.from, ...(feed.late ?? [])].flatMap((source) => {
            const at = yOf(source);
            return at === undefined ? [] : [at - (offsets.get(feed.id) ?? 0)];
          }),
        );
      const want =
        pulls.length > 0 ? pulls.reduce((sum, each) => sum + each, 0) / pulls.length : start;
      return { group, offsets, want, size: size - row, top: want };
    });
    // Groups keep their order a row apart, inside the map.
    let floor = start;
    for (const block of blocks) {
      block.top = Math.max(block.want, floor);
      floor = block.top + block.size + 2 * row;
    }
    let ceiling = start + height;
    for (const block of blocks.toReversed()) {
      block.top = Math.max(Math.min(block.top, ceiling - block.size), start);
      ceiling = block.top - 2 * row;
    }
    for (const block of blocks) {
      for (const id of block.group) {
        places.set(id, { x: lefts[index + 1] ?? 0, y: block.top + (block.offsets.get(id) ?? 0) });
      }
    }
  });
  return { places, row };
}

export interface TreeMapLayout {
  rows: Row[];
  /** Every feed, in its column's order. */
  feeds: Feed[];
  /** The few feeds the map shows closed. */
  few: Set<string>;
  closed: Map<string, Place>;
  grown: Map<string, Place>;
  /** A row's height grown. */
  row: number;
  slots: Map<string, Slot>;
  /** When each node growing adds starts to draw. */
  starts: Map<string, number>;
  /** Grown, where the lines into each feed run down to it. */
  lanes: Map<string, Lane>;
  /** Grown, where a line steps aside to pass between rows, by its key. */
  jogs: Map<string, Jog[]>;
}

/** A feed's lane: `by` left of the column it stands in, which starts at the feed `of`. */
export interface Lane {
  of: string;
  by: number;
}

/** Where a node stands this far grown: a node under a feed keeps its slot under it on the way. */
export function placeAt(layout: TreeMapLayout, id: string, grow: number): Place {
  const moved = clamp(grow / MOVE_TO);
  const slot = layout.slots.get(id);
  if (slot) {
    const holder = placeAt(layout, slot.holder, grow);
    const row = between(ROW, layout.row, moved);
    return { x: holder.x + slot.across, y: holder.y + slot.down * row };
  }
  const to = layout.grown.get(id) ?? { x: 0, y: 0 };
  const from = layout.closed.get(id) ?? to;
  // why: Across into its column first, then up or down it: heads bound for different columns are
  // apart before any passes another's row.
  const across = clamp(grow / (MOVE_TO / 2));
  const down = clamp((grow - MOVE_TO / 2) / (MOVE_TO / 2));
  return { x: between(from.x, to.x, across), y: between(from.y, to.y, down) };
}

/** How far a node growing adds has drawn, 0 to 1; undefined for one the map shows closed. */
export function drawnAt(layout: TreeMapLayout, id: string, grow: number): number | undefined {
  const start = layout.starts.get(id);
  return start === undefined ? undefined : clamp((grow - start) / DRAW_SPAN);
}

/** A line's three runs: level from its source, down its lane, level into its feed. */
interface Run {
  from: Place;
  to: Place;
  lane: number;
}

/** Where two lines' runs cross, one's level runs over the other's lane. */
function crossings(a: Run[], b: Run[]): number {
  const across = (level: Run[], down: Run[]) =>
    level.reduce(
      (count, line) =>
        count +
        down.filter((other) =>
          [
            [line.from.y, line.from.x, line.lane],
            [line.to.y, line.lane, line.to.x],
          ].some(
            ([y = 0, left = 0, right = 0]) =>
              other.lane > Math.min(left, right) &&
              other.lane < Math.max(left, right) &&
              y > Math.min(other.from.y, other.to.y) &&
              y < Math.max(other.from.y, other.to.y),
          ),
        ).length,
      0,
    );
  return across(a, b) + across(b, a);
}

/**
 * Each feed's lane, in the gap left of its column: lines into one feed share it, and the lanes go
 * in the order that crosses fewest.
 */
function lanesOf(
  layout: TreeMapLayout,
  width: (id: string) => number,
): Pick<TreeMapLayout, 'lanes' | 'jogs'> {
  const lanes = new Map<string, Lane>();
  /** Per column, where a line steps aside in the gap before it: left of every lane there. */
  const steps = new Map<number, Lane>();
  const grown = (id: string) => placeAt(layout, id, 1);
  const root = (id: string): string => {
    const slot = layout.slots.get(id);
    return slot ? root(slot.holder) : id;
  };
  const rights = (ids: string[]) => Math.max(0, ...ids.map((id) => grown(id).x + width(id)));
  ([1, 2, 3] as const).forEach((column) => {
    const inColumn = layout.feeds.filter((feed) => feed.column === column);
    const head = inColumn.find((feed) => !layout.slots.has(feed.id));
    if (!head) return;
    const left = grown(head.id).x;
    const before =
      column === 1
        ? layout.rows.map(rowId)
        : layout.feeds.filter((feed) => feed.column === column - 1).map((feed) => feed.id);
    const space = left - rights(before);
    const targets = inColumn.filter((feed) => feed.from.length + (feed.late?.length ?? 0) > 0);
    const runs = (feed: Feed, lane: number): Run[] =>
      [...feed.from, ...(feed.late ?? [])].map((source) => ({
        from: { x: grown(source).x + width(source), y: grown(source).y },
        to: grown(feed.id),
        lane,
      }));
    // The first lane is the nearest its column; to start, the top feed's.
    const order = targets.toSorted((a, b) => grown(a.id).y - grown(b.id).y);
    const laneAt = (index: number) => left - (space * (index + 1)) / (order.length + 1);
    const cost = () =>
      order.reduce(
        (sum, feed, index) =>
          sum +
          order
            .slice(index + 1)
            .reduce(
              (more, other, offset) =>
                more +
                crossings(runs(feed, laneAt(index)), runs(other, laneAt(index + 1 + offset))),
              0,
            ),
        0,
      );
    let best = cost();
    for (let pass = 0, swapped = true; swapped && pass < order.length; pass += 1) {
      swapped = false;
      for (let index = 0; index + 1 < order.length; index += 1) {
        const [a, b] = [order[index], order[index + 1]];
        if (!a || !b) continue;
        order[index] = b;
        order[index + 1] = a;
        const next = cost();
        if (next < best) {
          best = next;
          swapped = true;
        } else {
          order[index] = a;
          order[index + 1] = b;
        }
      }
    }
    order.forEach((feed, index) => {
      lanes.set(feed.id, { of: root(feed.id), by: left - laneAt(index) });
    });
    steps.set(column, { of: head.id, by: space - space / (order.length + 1) / 2 });
  });
  return { lanes, jogs: jogsOf(layout, width, lanes, steps) };
}

/** A line's step aside: in the gap at `lane`, to half a row above (-1) or below (1) `near`. */
export interface Jog {
  lane: Lane;
  near: string;
  side: 1 | -1;
}

/** The key of the line from `source` into `feed`. */
export const lineKey = (source: string, feed: string) => `${source}>${feed}`;

/**
 * Where a line would run level behind a token, or along another feed's last run, it steps half a
 * row aside in the gap before it and runs on between the rows.
 */
function jogsOf(
  layout: TreeMapLayout,
  width: (id: string) => number,
  lanes: Map<string, Lane>,
  steps: Map<number, Lane>,
): Map<string, Jog[]> {
  const grown = (id: string) => placeAt(layout, id, 1);
  const laneX = (lane: Lane) => grown(lane.of).x - lane.by;
  const columnOf = new Map(layout.feeds.map((feed) => [feed.id, feed.column]));
  const band = HALF + CLEAR;
  const nodes = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
  const jogs = new Map<string, Jog[]>();
  for (const feed of layout.feeds) {
    const lane = lanes.get(feed.id);
    if (!lane) continue;
    const rail = laneX(lane);
    const end = grown(feed.id);
    // What a level run can't pass: other tokens, and the last runs into the feeds beside this one.
    const blocks = [
      ...nodes.map((id) => ({
        id,
        left: grown(id).x,
        right: grown(id).x + width(id),
        reach: band,
      })),
      ...layout.feeds
        .filter((other) => other.column === feed.column && other.id !== feed.id)
        .flatMap((other) => {
          const its = lanes.get(other.id);
          return its
            ? [{ id: other.id, left: laneX(its), right: grown(other.id).x, reach: HALF }]
            : [];
        }),
    ];
    for (const source of [...feed.from, ...(feed.late ?? [])]) {
      const aside: Jog[] = [];
      let x = grown(source).x + width(source);
      let y = grown(source).y;
      for (let tries = 0; tries < 3; tries += 1) {
        const hit = blocks
          .filter(
            (block) =>
              block.id !== source &&
              block.id !== feed.id &&
              block.right > x &&
              block.left < rail &&
              Math.abs(grown(block.id).y - y) < block.reach,
          )
          .toSorted((a, b) => a.left - b.left)[0];
        if (!hit) break;
        const step = steps.get(columnOf.get(hit.id) ?? 0);
        if (!step || laneX(step) <= x) break;
        const side = end.y >= grown(hit.id).y ? 1 : -1;
        aside.push({ lane: step, near: hit.id, side });
        x = laneX(step);
        y = grown(hit.id).y + (side * layout.row) / 2;
      }
      if (aside.length > 0) jogs.set(lineKey(source, feed.id), aside);
    }
  }
  return jogs;
}

/** Whether two tokens, at their left sides and middles, touch. */
function touching(a: Place, aWidth: number, b: Place, bWidth: number): boolean {
  return (
    a.x < b.x + bWidth + CLEAR &&
    b.x < a.x + aWidth + CLEAR &&
    Math.abs(a.y - b.y) < 2 * HALF + CLEAR
  );
}

/** The least growing from which a node stands clear of every other, all the way grown. */
function clearFrom(
  layout: TreeMapLayout,
  id: string,
  ids: string[],
  width: (id: string) => number,
) {
  for (let step = SAMPLES; step >= 0; step -= 1) {
    const grow = step / SAMPLES;
    const place = placeAt(layout, id, grow);
    const hit = ids.some(
      (other) =>
        other !== id && touching(place, width(id), placeAt(layout, other, grow), width(other)),
    );
    if (hit) return (step + 1) / SAMPLES;
  }
  return 0;
}

/**
 * The tree and what feeds it, closed and grown, for tokens this wide: grown, it fills `box` when
 * one is given.
 */
export function treeMapLayout(
  workspace: StudioWorkspace,
  agents: readonly string[] | undefined,
  width: (id: string) => number,
  box?: Box,
): TreeMapLayout {
  const rows = rowsOf(workspace, agents);
  const feeds = feedsOf(workspace, rows);
  // Closed, the providers, the tools and the runner stand beside the tree, each level with the first
  // row it or a feed closed under it has a line from, or under the one before.
  const fewFeeds = CLOSED.flatMap((kind) =>
    feeds.filter((feed) => feed.kind === kind && feed.under === undefined),
  );
  const few = new Set(fewFeeds.map((feed) => feed.id));
  const feedX = Math.max(0, ...rows.map((row) => row.x + width(rowId(row)))) + GAP;
  const closed = new Map<string, Place>(rows.map((row) => [rowId(row), row]));
  const rowY = new Map(rows.map((row) => [rowId(row), row.y]));
  const firstRow = (feed: Feed) =>
    [feed, ...feeds.filter((each) => each.closedUnder && each.under === feed.id)]
      .flatMap((each) => each.from)
      .find((id) => rowY.has(id));
  let below = Number.NEGATIVE_INFINITY;
  for (const feed of fewFeeds) {
    const y = Math.max(rowY.get(firstRow(feed) ?? '') ?? below, below);
    closed.set(feed.id, { x: feedX, y });
    below = y + ROW;
  }
  const slots = slotsOf(feeds);
  const { places, row } = grownPlaces(rows, feeds, slots, width, box);
  const layout: TreeMapLayout = {
    rows,
    feeds,
    few,
    closed,
    grown: places,
    row,
    slots,
    starts: new Map(),
    lanes: new Map(),
    jogs: new Map(),
  };
  Object.assign(layout, lanesOf(layout, width));
  // What growing adds draws in its columns' order, each once it stands clear.
  const order = feeds.filter((feed) => !few.has(feed.id));
  const ids = [...rows.map(rowId), ...feeds.map((feed) => feed.id)];
  order.forEach((feed, index) => {
    const turn =
      DRAW_FROM + ((DRAW_TO - DRAW_SPAN - DRAW_FROM) * index) / Math.max(order.length - 1, 1);
    layout.starts.set(feed.id, Math.max(turn, clearFrom(layout, feed.id, ids, width)));
  });
  return layout;
}
