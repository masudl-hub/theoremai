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
/** The tools beside a Tools row: the first of each type. */
const TOOL_TYPES = ['function', 'http', 'mcp', 'agent'];
/** Grown, the runner's steps two across, down one column and then the next. */
const STEPS_DOWN = 4;
const STEP_GAP = 24;
/** By how far grown every node has reached its zone; the rest is for drawing in. */
const MOVE_TO = 0.7;
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
  | 'check';

/** What feeds the tree: a runner, a provider, a tool, or one of their own nested under them. */
export interface Feed {
  id: string;
  label: string;
  kind: FeedKind;
  /** A tool's type, a subagent's profile type, or a step's or a check's id: what its icon is. */
  of?: string;
  /** The tree rows it has a line into. */
  into: string[];
  /** The feed it is one of, a level in under it. */
  under?: string;
  /** Another feed it has a line to: a subagent to the runner that runs it, the tool loop to the tool runner. */
  joins?: string;
  /** The column it stands in beside the tree, first or second. */
  column: 1 | 2;
  /** Feeds that stand together, with a gap before the next group. */
  group: string;
}

/**
 * What the runner does in a turn, in order: the steps of the kernel contract's turn lifecycle
 * (docs/contracts/kernel.md, "Turn lifecycle") that do work.
 * why: The canary bind runs only while a canary detector is on, and pre_turn, before_end and
 * post_turn are hooks for the host's stages, so the map leaves those four out.
 */
export const TURN_STEPS: readonly { id: string; label: string }[] = [
  { id: 'resolve', label: 'Resolve' },
  { id: 'sanitize', label: 'Sanitize' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'stream', label: 'Provider stream' },
  { id: 'tools', label: 'Tool loop' },
  { id: 'validation', label: 'Validation' },
  { id: 'egress', label: 'Egress' },
  { id: 'trace', label: 'Trace' },
];

/**
 * What the tool runner checks of every call, in order (`executeRegisteredTool`): its permission,
 * its sign-in, the network a remote call reaches, and the guard on its result.
 */
export const TOOL_CHECKS: readonly { id: string; label: string }[] = [
  { id: 'permission', label: 'Permission gate' },
  { id: 'sign-in', label: 'Sign-in' },
  { id: 'network', label: 'Network check' },
  { id: 'result', label: 'Result guard' },
];

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
 * Beside the tree, shared by every agent drawn: the providers, each with the protocols the models
 * it serves speak, and a line into each of those models; the first tool of each type the agents
 * allow, with a line into each Tools row that allows it, an MCP tool's sessions under it and an
 * agent tool's agent under it, joined to the runner; and the one runner, with a line into each
 * agent but a host (whose calls the tool runner runs) and its steps under it. Past them, the tool
 * runner the tool loop calls, its checks under it.
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
  const feeds: Feed[] = [];

  const providers = new Map<string, { into: string[]; protocols: Set<string> }>();
  for (const agent of drawn) {
    for (const binding of agent.modelBindings) {
      const row = rowOf(agent.key, 'modelBinding', binding.key);
      if (!row) continue;
      const provider = providers.get(binding.provider) ?? { into: [], protocols: new Set() };
      provider.into.push(rowId(row));
      provider.protocols.add(binding.protocol);
      providers.set(binding.provider, provider);
    }
  }
  for (const [provider, { into, protocols }] of providers) {
    const id = `provider:${provider}`;
    feeds.push({ id, label: provider, kind: 'provider', into, column: 1, group: 'providers' });
    for (const protocol of protocols) {
      const nested = { id: `${id}/${protocol}`, label: protocol, kind: 'protocol' as const };
      feeds.push({ ...nested, into: [], under: id, column: 1, group: 'providers' });
    }
  }

  const allowing = (key: string) =>
    drawn.flatMap((agent) => {
      const row = agent.tools.allow.includes(key) ? rowOf(agent.key, 'tools') : undefined;
      return row ? [rowId(row)] : [];
    });
  for (const type of TOOL_TYPES) {
    const tool = workspace.toolSpecs.find(
      (each) => each.toolType === type && allowing(each.key).length > 0,
    );
    if (!tool) continue;
    const id = `tool:${tool.key}`;
    const into = allowing(tool.key);
    feeds.push({
      id,
      label: tool.toolName,
      kind: 'tool',
      of: type,
      into,
      column: 1,
      group: 'tools',
    });
    const nested = { into: [], under: id, column: 1 as const, group: 'tools' };
    if (type === 'mcp') {
      feeds.push({ ...nested, id: `${id}/sessions`, label: 'MCP sessions', kind: 'branch' });
    }
    const agent = workspace.agents.find((each) => each.key === tool.agentKey);
    if (type === 'agent' && agent) {
      const label = agent.identity.agentId || agent.identity.handle;
      feeds.push({
        ...nested,
        id: `${id}/agent`,
        label,
        kind: 'subagent',
        of: agent.identity.profileType,
        joins: RUNNER,
      });
    }
  }

  const runs = drawn.filter((agent) => agent.identity.profileType !== 'host');
  const into = runs.flatMap((agent) => {
    const row = rowOf(agent.key, 'identity');
    return row ? [rowId(row)] : [];
  });
  feeds.push({ id: RUNNER, label: 'Runner', kind: 'runner', into, column: 1, group: 'runner' });
  for (const step of TURN_STEPS) {
    feeds.push({
      id: `${RUNNER}/${step.id}`,
      label: step.label,
      kind: 'step',
      of: step.id,
      into: [],
      under: RUNNER,
      column: 1,
      group: 'runner',
      ...(step.id === 'tools' ? { joins: TOOL_RUNNER } : {}),
    });
  }
  const runner = { id: TOOL_RUNNER, label: 'Tool runner', kind: 'tool-runner' as const };
  feeds.push({ ...runner, into: [], column: 2, group: 'tool-runner' });
  for (const check of TOOL_CHECKS) {
    const nested = { id: `${TOOL_RUNNER}/${check.id}`, label: check.label, of: check.id };
    feeds.push({
      ...nested,
      kind: 'check',
      into: [],
      under: TOOL_RUNNER,
      column: 2,
      group: 'tool-runner',
    });
  }
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

/** A step under the runner two across, down one column and then the next; any other a level in. */
function slotsOf(feeds: Feed[], width: (id: string) => number): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const steps = feeds.filter((feed) => feed.kind === 'step');
  const stepColumn = Math.max(0, ...steps.map((step) => width(step.id))) + STEP_GAP;
  const counts = new Map<string, number>();
  for (const feed of feeds) {
    if (feed.under === undefined) continue;
    const index = counts.get(feed.under) ?? 0;
    counts.set(feed.under, index + 1);
    const slot =
      feed.kind === 'step'
        ? { across: Math.floor(index / STEPS_DOWN) * stepColumn, down: (index % STEPS_DOWN) + 1 }
        : { across: 0, down: index + 1 };
    slots.set(feed.id, { holder: feed.under, across: INDENT + slot.across, down: slot.down });
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
  const columns = ([1, 2] as const).map((column) => {
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
 * The map grown: the tree, each agent a zone of its own; beside it the providers, the tools and the
 * runner; past them the tool runner. Rows stretch, up to a most, and the gaps between columns and
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
  const columnWidth = (column: 1 | 2) =>
    Math.max(
      0,
      ...feeds
        .filter((feed) => feed.column === column)
        .map((feed) => {
          const slot = slots.get(feed.id);
          return right(feed.id, slot ? slot.across : 0);
        }),
    );
  const [first, second] = [columnWidth(1), columnWidth(2)];
  const spare = box ? (box.width - 2 * PAD - (treeRight - PAD) - first - second) / 2 : LEAST_GAP;
  const gap = Math.min(Math.max(spare, LEAST_GAP), MOST_GAP);
  const lefts = [0, treeRight + gap, treeRight + gap + first + gap];

  const places = new Map<string, Place>();
  const tree = new Map(rows.map((each) => [rowId(each), each]));
  columns.forEach((stack, column) => {
    const free = height - (stack.rows - 1) * row;
    // Past a group, the next stands a row and its share of what is free further down.
    const extra = stack.ids.length > 1 ? free / (stack.ids.length - 1) : 0;
    // why: A column of one group has no gap to widen, so it stands in the middle of the map.
    let y = PAD + HALF + (stack.ids.length > 1 ? 0 : free / 2);
    for (const group of stack.ids) {
      for (const id of group) {
        places.set(id, { x: tree.get(id)?.x ?? lefts[column] ?? 0, y });
        y += row * (1 + (held.get(id) ?? 0));
      }
      y += extra;
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
  return { x: between(from.x, to.x, moved), y: between(from.y, to.y, moved) };
}

/** How far a node growing adds has drawn, 0 to 1; undefined for one the map shows closed. */
export function drawnAt(layout: TreeMapLayout, id: string, grow: number): number | undefined {
  const start = layout.starts.get(id);
  return start === undefined ? undefined : clamp((grow - start) / DRAW_SPAN);
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
  // Closed, the first column's heads stand beside the tree, each level with the first row it
  // joins or under the one before.
  const fewFeeds = feeds.filter((feed) => feed.column === 1 && feed.under === undefined);
  const few = new Set(fewFeeds.map((feed) => feed.id));
  const feedX = Math.max(0, ...rows.map((row) => row.x + width(rowId(row)))) + GAP;
  const closed = new Map<string, Place>(rows.map((row) => [rowId(row), row]));
  const rowY = new Map(rows.map((row) => [rowId(row), row.y]));
  let below = Number.NEGATIVE_INFINITY;
  for (const feed of fewFeeds) {
    const y = Math.max(rowY.get(feed.into[0] ?? '') ?? below, below);
    closed.set(feed.id, { x: feedX, y });
    below = y + ROW;
  }
  const slots = slotsOf(feeds, width);
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
  };
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
