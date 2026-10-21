/**
 * Where each node of the tree map stands, closed and grown, and how far each node growing adds has
 * drawn: the part of `tree-map.tsx` that is not drawing, so its motion can be checked without a page.
 *
 * invariant: Grown, every node keeps its place in its column's order and every gap stays a row or
 * more, so no node passes through another on the way; a node growing adds shows only once nothing
 * stands where it is.
 */
import { type StudioTreeNode, type StudioWorkspace, workspaceTree } from '../../mod.ts';

/** A row's height closed, and grown. */
const ROW = 32;
const GROWN_ROW = 28;
/** How far in each level of the tree starts. */
export const INDENT = 28;
/** A token's half height. */
export const HALF = 11;
export const PAD = 16;
/** Between the tree's widest row and the feeds. */
const GAP = 72;
/** How many of the registry's tools sit under it closed: one of each type first. */
const SHOWN_TOOLS = 4;
const TOOL_TYPES = ['function', 'http', 'mcp', 'agent'];
/** Grown, between one agent's zone and the next. */
const AGENT_GAP = 16;
/** Grown, a turn's steps in rows under its runner, so many to a row. */
const STEPS_ACROSS = 3;
const STEP_SLOT = 160;
/** Grown, the registry's tools in columns this tall. */
const TOOLS_DOWN = 8;
const TOOL_SLOT = 210;
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

export const REGISTRY = 'tool-registry';

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

export type FeedKind = 'runner' | 'step' | 'provider' | 'registry' | 'tool' | 'tool-runner';

/** A runner, a provider or the tool registry beside the tree, the rows it joins, and the feed above it that it runs. */
export interface Feed {
  id: string;
  label: string;
  kind: FeedKind;
  agent: string;
  /** A tool's type, or a step's id: what its icon is. */
  of?: string;
  y: number;
  into: string[];
  /** Under another feed: a level in when it is one of that feed's own, else level with it. */
  under?: string;
  depth: number;
}

/**
 * What a turn runner does in one turn, in order.
 * why: The kernel contract's turn lifecycle (docs/contracts/kernel.md, "Turn lifecycle"), step for
 * step; a decision and a session have no such list there, so their runners open into nothing.
 */
export const TURN_STEPS: readonly { id: string; label: string }[] = [
  { id: 'resolve', label: 'Resolve' },
  { id: 'sanitize', label: 'Sanitize' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'canary', label: 'Canary bind' },
  { id: 'pre_turn', label: 'pre_turn' },
  { id: 'stream', label: 'Provider stream' },
  { id: 'tools', label: 'Tool loop' },
  { id: 'before_end', label: 'before_end' },
  { id: 'validation', label: 'Validation' },
  { id: 'egress', label: 'Egress' },
  { id: 'trace', label: 'Trace' },
  { id: 'post_turn', label: 'post_turn' },
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
 * What runs a profile of this type: `runDecision`, `runSession`, `runEmbedding`, else `runTurn`. A
 * host has none of its own: the tool runner runs its calls.
 */
function runnerLabel(type: string): string | undefined {
  if (type === 'host') return undefined;
  if (type === 'decision') return 'Decision runner';
  if (type === 'live') return 'Session runner';
  if (type === 'embedding') return 'Embedding runner';
  return 'Turn runner';
}

/**
 * Each agent's runner (`runTurn`, or `runDecision` for a decision), beside its name; its providers,
 * beside its models; and the workspace's tool registry, beside its Tools row, with the tool runner
 * under it. A feed sits level with the middle of the rows it joins, or under the feed before it when
 * that is lower. With `detail`, every tool and each turn runner's steps.
 */
function feedsOf(workspace: StudioWorkspace, rows: Row[], detail: boolean): Feed[] {
  const feeds: Feed[] = [];
  const add = (feed: Omit<Feed, 'y' | 'into' | 'depth'>, into: Row[] = [], depth = 0) => {
    const below = (feeds.at(-1)?.y ?? Number.NEGATIVE_INFINITY) + ROW;
    const middle = into.length ? into.reduce((sum, row) => sum + row.y, 0) / into.length : below;
    feeds.push({ ...feed, y: Math.max(middle, below), into: into.map(rowId), depth });
  };
  for (const agent of workspace.agents) {
    const mine = rows.filter((row) => row.agent === agent.key);
    const name = mine.find((row) => row.node.ref.facet === 'identity');
    if (!name) continue;
    const runner = runnerLabel(agent.identity.profileType);
    if (runner) {
      const id = `${agent.key}/runner`;
      add({ id, label: runner, kind: 'runner', agent: agent.key }, [name]);
      const steps = detail && runner === 'Turn runner' ? TURN_STEPS : [];
      for (const step of steps) {
        const of = step.id;
        add(
          { id: `${id}/${of}`, label: step.label, kind: 'step', agent: agent.key, of, under: id },
          [],
          1,
        );
      }
    }
    const providers = new Map<string, Row[]>();
    for (const binding of agent.modelBindings) {
      const row = mine.find(
        (each) => each.node.ref.facet === 'modelBinding' && each.node.ref.key === binding.key,
      );
      if (row) providers.set(binding.provider, [...(providers.get(binding.provider) ?? []), row]);
    }
    for (const [provider, into] of providers) {
      const id = `${agent.key}/provider:${provider}`;
      add({ id, label: provider, kind: 'provider', agent: agent.key }, into);
    }
    // The workspace's tools are one registry that each agent's tool policy picks from: drawn once,
    // beside the first Tools row, with a line into every other.
    const tools = mine.find((row) => row.node.ref.facet === 'tools');
    const drawn = feeds.find((feed) => feed.id === REGISTRY);
    if (tools && drawn) drawn.into.push(rowId(tools));
    else if (tools && workspace.toolSpecs.length > 0) {
      add({ id: REGISTRY, label: 'Tool registry', kind: 'registry', agent: agent.key }, [tools]);
      for (const tool of listedTools(workspace.toolSpecs, detail)) {
        const id = `${REGISTRY}/${tool.key}`;
        const feed = { id, label: tool.toolName, kind: 'tool' as const, agent: agent.key };
        add({ ...feed, of: tool.toolType, under: REGISTRY }, [], 1);
      }
      const runs = { id: 'tool-runner', label: 'Tool runner', kind: 'tool-runner' as const };
      add({ ...runs, agent: agent.key, under: REGISTRY });
    }
  }
  return feeds;
}

/**
 * The registry's tools: the first of each type, then the rest in the registry's order. A few of
 * them, or with `detail` every one.
 */
function listedTools(
  tools: StudioWorkspace['toolSpecs'],
  detail: boolean,
): StudioWorkspace['toolSpecs'] {
  const firsts = TOOL_TYPES.flatMap((type) => {
    const tool = tools.find((each) => each.toolType === type);
    return tool ? [tool] : [];
  });
  const rest = tools.filter((tool) => !firsts.includes(tool));
  const listed = [...firsts, ...rest];
  return detail ? listed : listed.slice(0, SHOWN_TOOLS);
}

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
const between = (from: number, to: number, at: number) => from + (to - from) * at;

/** Every other one from each list, while both last: the turn's steps and the tools draw by turns. */
function byTurns<T>(first: T[], second: T[]): T[] {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) =>
    [first[index], second[index]].filter((each): each is T => each !== undefined),
  ).flat();
}

/** Where a node under a feed sits from it: across, and rows down. */
export interface Slot {
  holder: string;
  across: number;
  down: number;
}

/** A step under its runner in rows so many across; a tool under the registry in columns. */
function slotsOf(feeds: Feed[]): Map<string, Slot> {
  const slots = new Map<string, Slot>();
  const counts = new Map<string, number>();
  for (const feed of feeds) {
    if (feed.under === undefined || feed.depth === 0) continue;
    const index = counts.get(feed.under) ?? 0;
    counts.set(feed.under, index + 1);
    const slot =
      feed.kind === 'tool'
        ? { across: Math.floor(index / TOOLS_DOWN) * TOOL_SLOT, down: (index % TOOLS_DOWN) + 1 }
        : {
            across: (index % STEPS_ACROSS) * STEP_SLOT,
            down: Math.floor(index / STEPS_ACROSS) + 1,
          };
    slots.set(feed.id, { holder: feed.under, across: INDENT + slot.across, down: slot.down });
  }
  return slots;
}

/**
 * The column grown: each agent a zone of its own, its rows restacked and its feeds in their order,
 * each level with its rows or under the room the one before it holds for its own.
 */
function grownColumn(rows: Row[], feeds: Feed[], slots: Map<string, Slot>, feedX: number) {
  const places = new Map<string, Place>();
  const held = new Map<string, number>();
  for (const slot of slots.values()) {
    held.set(slot.holder, Math.max(held.get(slot.holder) ?? 0, slot.down));
  }
  let top = PAD + HALF;
  for (const agent of new Set(rows.map((row) => row.agent))) {
    const mine = rows.filter((row) => row.agent === agent);
    mine.forEach((row, index) => {
      places.set(rowId(row), { x: row.x, y: top + index * GROWN_ROW });
    });
    let cursor = top;
    for (const feed of feeds) {
      if (feed.agent !== agent || slots.has(feed.id)) continue;
      const level = feed.into.flatMap((id) => places.get(id)?.y ?? []);
      const middle = level.length ? level.reduce((sum, y) => sum + y, 0) / level.length : cursor;
      const y = Math.max(middle, cursor);
      places.set(feed.id, { x: feedX, y });
      cursor = y + GROWN_ROW * (1 + (held.get(feed.id) ?? 0));
    }
    top = Math.max(top + mine.length * GROWN_ROW, cursor) + AGENT_GAP;
  }
  return places;
}

export interface TreeMapLayout {
  rows: Row[];
  /** Every feed, in the column's order. */
  feeds: Feed[];
  /** The few feeds the map shows closed. */
  few: Set<string>;
  closed: Map<string, Place>;
  grown: Map<string, Place>;
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
    return { x: holder.x + slot.across, y: holder.y + slot.down * between(ROW, GROWN_ROW, moved) };
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

/** The tree and what feeds it, closed and grown, for tokens this wide. */
export function treeMapLayout(
  workspace: StudioWorkspace,
  agents: readonly string[] | undefined,
  width: (id: string) => number,
): TreeMapLayout {
  const rows = rowsOf(workspace, agents);
  const fewFeeds = feedsOf(workspace, rows, false);
  const few = new Set(fewFeeds.map((feed) => feed.id));
  const feeds = feedsOf(workspace, rows, true);
  const feedX = Math.max(0, ...rows.map((row) => row.x + width(rowId(row)))) + GAP;
  const closed = new Map<string, Place>(rows.map((row) => [rowId(row), row]));
  for (const feed of fewFeeds) closed.set(feed.id, { x: feedX + feed.depth * INDENT, y: feed.y });
  const slots = slotsOf(feeds);
  const layout: TreeMapLayout = {
    rows,
    feeds,
    few,
    closed,
    grown: grownColumn(rows, feeds, slots, feedX),
    slots,
    starts: new Map(),
  };
  // What growing adds draws in order, the turn's steps and the tools by turns, each once it stands clear.
  const added = feeds.filter((feed) => !few.has(feed.id));
  const order = byTurns(
    added.filter((feed) => feed.under !== REGISTRY),
    added.filter((feed) => feed.under === REGISTRY),
  );
  const ids = [...rows.map(rowId), ...feeds.map((feed) => feed.id)];
  order.forEach((feed, index) => {
    const turn =
      DRAW_FROM + ((DRAW_TO - DRAW_SPAN - DRAW_FROM) * index) / Math.max(order.length - 1, 1);
    layout.starts.set(feed.id, Math.max(turn, clearFrom(layout, feed.id, ids, width)));
  });
  return layout;
}
