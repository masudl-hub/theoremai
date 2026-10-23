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
/** Grown, how much further in from the box's edges the map stands. */
const INSET = 16;
/** Grown, the room over the columns their headings take: a title, the line under it, and a gap. */
export const HEADING = 56;

/** Grown, each column's heading, in order: the tree, the registries, the runner. */
export const HEADINGS: readonly { label: string; note: string }[] = [
  { label: 'Profile', note: 'The contract you define' },
  { label: 'Registry', note: 'The pieces you provide' },
  { label: 'Runner', note: 'What runs your contract' },
];
/** Closed, between the tree's widest row and the feeds; grown, the least and most between columns. */
const GAP = 72;
const LEAST_GAP = 56;
const MOST_GAP = 200;
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

export const TOOL_RUNTIME = 'tool-runtime';
export const GUARDRAIL_RUNTIME = 'guardrail-runtime';
export const TRACE_DESTINATIONS = 'trace-destinations';
export const PROVIDER_STREAM = 'provider-stream';

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
  | 'step'
  | 'provider'
  | 'protocol'
  | 'tool'
  | 'branch'
  | 'subagent'
  | 'tool-runtime'
  | 'guardrail-runtime'
  | 'check'
  | 'destinations'
  | 'stream'
  | 'model';

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
  /** The column it stands in beside the tree: the registries, or the runner. */
  column: 1 | 2;
  /** Feeds that stand together, with a gap before the next group. */
  group: string;
}

/**
 * What the runner does in a turn, in order: the steps of the kernel contract's turn lifecycle
 * (docs/contracts/kernel.md, "Turn lifecycle") that do work, and the profile sections each reads.
 * why: The canary bind runs only while a canary detector is on, and pre_turn, before_end and
 * post_turn are hooks for the host's stages, so the map leaves those four out; the structured
 * reply's validation is the outputs' own, not a story of the runner's, so it is left out too.
 * Sanitize and egress are named for what they guard, the input and the reply, and drawn from them.
 */
export const TURN_STEPS: readonly { id: string; label: string; reads: readonly string[] }[] = [
  { id: 'sanitize', label: 'Input guard', reads: ['inputs'] },
  { id: 'egress', label: 'Reply guard', reads: ['outputs'] },
  { id: 'trace', label: 'Telemetry engine', reads: ['observability'] },
];

/**
 * What the tool runtime does with every call, in order (`executeRegisteredTool`): its permission,
 * its sign-in, and the MCP session an MCP call runs in.
 */
export const TOOL_CHECKS: readonly { id: string; label: string }[] = [
  { id: 'permission', label: 'Permission gate' },
  { id: 'sign-in', label: 'Authentication' },
  { id: 'sessions', label: 'MCP sessions' },
];

/** What the guardrail runtime does with a call: the network a remote call reaches, and the guard on its result. */
const GUARDRAIL_CHECKS: readonly { id: string; label: string }[] = [
  { id: 'network', label: 'Network guard' },
  { id: 'result', label: 'Tool result guard' },
];

/**
 * The order of an agent's rows: what it runs on, how it turns, its tools, its guardrails, then what
 * goes in and out of it, level with the guards on them; any other section after, observability last.
 */
const ROW_ORDER: readonly string[] = [
  'identity',
  'models',
  'decision',
  'image',
  'speech',
  'live',
  'turnBehaviour',
  'tools',
  'guardrails',
  'inputs',
  'outputs',
];

/** Closed, the map shows only these heads beside the tree, in this order. */
const CLOSED: readonly FeedKind[] = ['provider', 'tool', 'tool-runtime'];

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
    // why: The models are named once, under their providers beside the tree; the Models row links to
    // them. Observability comes last, level with the trace destinations and the telemetry engine at
    // the foot of the map.
    const children = node.children.filter((child) => child.ref.facet !== 'modelBinding');
    const rank = (child: StudioTreeNode) =>
      child.ref.facet === 'observability'
        ? ROW_ORDER.length + 1
        : ROW_ORDER.includes(child.ref.facet)
          ? ROW_ORDER.indexOf(child.ref.facet)
          : ROW_ORDER.length;
    for (const child of children.toSorted((a, b) => rank(a) - rank(b))) {
      walk(child, agent, depth + 1, row);
    }
  };
  workspaceTree(workspace).agents.forEach((root, index) => {
    const key = workspace.agents[index]?.key ?? '';
    if (only === undefined || only.includes(key)) walk(root, key, 0);
  });
  return rows;
}

/**
 * Beside the tree, shared by every agent drawn, two columns. First, the registries: the first tool of
 * each type the agents allow, with a line from each Tools row that allows it, and an agent tool's
 * agent under it; each provider, with its models under it, each with a line from its Models row; and the trace
 * destinations, with a line from the observability rows. Then the runner: the provider stream, over
 * each provider's protocols, each with a line from its provider; the tool runtime, with a line from
 * each tool, and what it does with each call under it; the guardrail runtime, with a line from the
 * guardrails, and what it does under it; and the telemetry engine, with a line from the trace
 * destinations.
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
  const firstOf = (type: string) =>
    workspace.toolSpecs.find((each) => each.toolType === type && allowing(each.key).length > 0);
  // why: An agent tool's agent runs on a model of its own, so its models stand under their
  // providers too, each with a line from the agent under the tool, when the tree does not draw it.
  const asked = firstOf('agent');
  const askedAgent = drawn.some((agent) => agent.key === asked?.agentKey)
    ? undefined
    : workspace.agents.find((agent) => agent.key === asked?.agentKey);
  const modelled = [
    ...drawn.flatMap((agent) => {
      const section = rowOf(agent.key, 'models');
      return section ? [{ agent, source: rowId(section) }] : [];
    }),
    ...(asked && askedAgent ? [{ agent: askedAgent, source: `tool:${asked.key}/agent` }] : []),
  ];
  const providers = new Map<string, Map<string, string[]>>();
  const models: Feed[] = [];
  for (const { agent, source } of modelled) {
    for (const binding of agent.modelBindings) {
      const protocols = providers.get(binding.provider) ?? new Map<string, string[]>();
      protocols.set(binding.protocol, [...(protocols.get(binding.protocol) ?? []), source]);
      providers.set(binding.provider, protocols);
      models.push({
        id: `model:${agent.key}/${binding.key}`,
        label: binding.modelId,
        kind: 'model',
        of: binding.apiId,
        from: [source],
        under: `provider:${binding.provider}`,
        closedUnder: true,
        column: 1,
        group: 'providers',
      });
    }
  }
  const protocols: Feed[] = [];
  for (const [provider, byProtocol] of providers) {
    const id = `provider:${provider}`;
    feeds.push({
      id,
      label: provider,
      kind: 'provider',
      // why: The Models rows link to the models under it, not to the provider.
      from: [],
      column: 1,
      group: 'providers',
    });
    for (const protocol of byProtocol.keys()) {
      protocols.push({
        id: `${id}/${protocol}`,
        label: protocol,
        kind: 'protocol',
        from: [id],
        under: PROVIDER_STREAM,
        column: 2,
        group: 'protocols',
      });
    }
  }
  const tools: { id: string; spec: StudioWorkspace['toolSpecs'][number] }[] = [];
  for (const type of TOOL_TYPES) {
    const spec = firstOf(type);
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

  const stepOf = (id: string) =>
    TURN_STEPS.find((step) => step.id === id) ?? { id, label: id, reads: [] as string[] };
  const guardrails = sections(['guardrails']);
  const observability = sections(['observability']);

  // Registries: each provider, its models under it, and the trace destinations.
  feeds.push(...models);
  feeds.push({
    id: TRACE_DESTINATIONS,
    label: 'Trace destinations',
    kind: 'destinations',
    from: observability,
    column: 1,
    group: 'destinations',
  });

  // The runner: the provider stream over each protocol, then the tool runtime and the guardrail
  // runtime with what each does under it, then the telemetry engine.
  if (protocols.length > 0) {
    feeds.push({
      id: PROVIDER_STREAM,
      label: 'Provider stream',
      kind: 'stream',
      from: [],
      column: 2,
      group: 'protocols',
    });
    feeds.push(...protocols);
  }
  const toolsOf = (types: readonly string[]) =>
    tools.filter(({ spec }) => types.includes(spec.toolType)).map(({ id }) => id);
  const checkFrom: Record<string, string[]> = {
    'sign-in': tools.filter(({ spec }) => (spec.authType ?? 'none') !== 'none').map(({ id }) => id),
    network: toolsOf(REMOTE_TYPES),
    sessions: toolsOf(['mcp']),
    // why: The tool runtime hands each result to its guard before it goes back to the model.
    result: tools.length > 0 ? [TOOL_RUNTIME] : [],
  };
  feeds.push({
    id: TOOL_RUNTIME,
    label: 'Tool runtime',
    kind: 'tool-runtime',
    from: tools.map(({ id }) => id),
    column: 2,
    group: 'tool-runtime',
  });
  for (const check of TOOL_CHECKS) {
    feeds.push({
      id: `${TOOL_RUNTIME}/${check.id}`,
      label: check.label,
      kind: check.id === 'sessions' ? 'branch' : 'check',
      of: check.id,
      from: checkFrom[check.id] ?? [],
      under: TOOL_RUNTIME,
      column: 2,
      group: 'tool-runtime',
    });
  }
  feeds.push({
    id: GUARDRAIL_RUNTIME,
    label: 'Guardrail runtime',
    kind: 'guardrail-runtime',
    from: guardrails,
    column: 2,
    group: 'guardrail-runtime',
  });
  for (const id of ['sanitize', 'egress']) {
    const step = stepOf(id);
    feeds.push({
      id: `${GUARDRAIL_RUNTIME}/${id}`,
      label: step.label,
      kind: 'step',
      of: id,
      from: sections(step.reads),
      under: GUARDRAIL_RUNTIME,
      column: 2,
      group: 'guardrail-runtime',
    });
  }
  for (const check of GUARDRAIL_CHECKS) {
    feeds.push({
      id: `${GUARDRAIL_RUNTIME}/${check.id}`,
      label: check.label,
      kind: 'check',
      of: check.id,
      from: checkFrom[check.id] ?? [],
      under: GUARDRAIL_RUNTIME,
      column: 2,
      group: 'guardrail-runtime',
    });
  }
  feeds.push({
    id: 'telemetry',
    label: stepOf('trace').label,
    kind: 'step',
    of: 'trace',
    from: [TRACE_DESTINATIONS],
    column: 2,
    group: 'telemetry',
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
    slots.set(feed.id, { holder: feed.under, across: INDENT, down: index + 1 });
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
 * The map grown: the tree, each row with lines into a registry level with it; beside it the
 * registries, then the runner, each block centred on its sources. Rows stretch, up to a most, and
 * the gaps between columns and between groups widen, so the map fills `box`; without one, rows and
 * gaps are at their least.
 */
function grownPlaces(
  rows: Row[],
  feeds: Feed[],
  slots: Map<string, Slot>,
  width: (id: string) => number,
  box: Box | undefined,
) {
  const { held, columns } = stacksOf(rows, feeds, slots);
  const [, registries, runner] = columns;
  const start = PAD + INSET + HEADING + HALF;
  const room = box ? box.height - 2 * (PAD + INSET + HALF) - HEADING : 0;
  const byId = new Map(feeds.map((feed) => [feed.id, feed]));
  const sourcesOf = (id: string) => {
    const feed = byId.get(id);
    return feed ? [...feed.from, ...(feed.late ?? [])] : [];
  };
  const tree = new Map(rows.map((each) => [rowId(each), each]));
  const lined = new Set(feeds.flatMap((feed) => sourcesOf(feed.id)));

  /** A column's groups, each a block of rows `step` apart, its heads' nested feeds under them. */
  const blocksOf = (stack: Stack | undefined, step: number) =>
    (stack?.ids ?? []).map((group) => {
      const offsets = new Map<string, number>();
      let size = 0;
      for (const id of group) {
        offsets.set(id, size);
        for (const [nested, slot] of slots) {
          if (slot.holder === id) offsets.set(nested, size + slot.down * step);
        }
        size += step * (1 + (held.get(id) ?? 0));
      }
      // A registry block stands level with the first tree row any of its feeds has a line from.
      const anchor = [...offsets]
        .toSorted((a, b) => a[1] - b[1])
        .flatMap(([id, offset]) => {
          const row = sourcesOf(id).find((source) => tree.has(source));
          return row ? [{ row, offset }] : [];
        })[0];
      return { group, offsets, size: size - step, top: start, anchor };
    });

  /**
   * The tree and the registries, together down the map: a row with lines into a registry block is
   * level with the first feed it has a line to, and the row after it stands below that block.
   */
  const lay = (step: number, extra = 0) => {
    const ys = new Map<string, number>();
    const blocks = blocksOf(registries, step);
    let y = start;
    let floor = start;
    let last: Row | undefined;
    for (const row of rows) {
      const id = rowId(row);
      if (last && last.agent !== row.agent) y += 2 * step;
      let below = y;
      for (const block of blocks.filter((each) => each.anchor?.row === id)) {
        const offset = block.anchor?.offset ?? 0;
        block.top = Math.max(floor, y - offset);
        y = block.top + offset;
        floor = block.top + block.size + 2 * step + extra;
        below = Math.max(below, block.top + block.size + extra);
      }
      ys.set(id, y);
      y = Math.max(y + step, below);
      last = row;
    }
    for (const block of blocks.filter((each) => !each.anchor)) {
      block.top = floor;
      floor = block.top + block.size + 2 * step;
    }
    const bottom = Math.max(...ys.values(), ...blocks.map((block) => block.top + block.size));
    return { ys, blocks, bottom };
  };
  const runnerRows = (runner?.rows ?? 1) + 2 * ((runner?.ids.length ?? 1) - 1) - 1;
  const fits = (step: number) => {
    const laid = lay(step);
    return laid.bottom - start <= room && runnerRows * step <= room;
  };
  let row = GROWN_ROW;
  if (box) {
    for (let step = TALLEST_ROW; step >= GROWN_ROW; step -= 1) {
      if (fits(step)) {
        row = step;
        break;
      }
    }
  }
  const plain = lay(row);
  const height = Math.max(room, plain.bottom - start, runnerRows * row);
  // why: The last row's registry stands at the foot of the map, with the rows before it that have
  // no line of their own; the map's spare room is shared between the gap above them and the gap
  // below each registry block before it.
  const lastRow = rows.at(-1);
  const atFoot = (block: (typeof plain.blocks)[number]) =>
    lastRow !== undefined && block.anchor?.row === rowId(lastRow);
  const breaks = plain.blocks.filter((block) => block.anchor && !atFoot(block)).length + 1;
  const footOf = (blocks: typeof plain.blocks) =>
    Math.max(...blocks.filter(atFoot).map((block) => block.top + block.size));
  const { ys, blocks, bottom } = plain.blocks.some(atFoot)
    ? lay(row, Math.max(0, start + height - footOf(plain.blocks)) / breaks)
    : plain;
  const foot = blocks.filter(atFoot);
  if (lastRow && foot.length > 0) {
    const tail = [lastRow];
    for (const each of rows.toReversed().slice(1)) {
      if (lined.has(rowId(each)) || each.agent !== lastRow.agent) break;
      tail.push(each);
    }
    const shift = start + height - footOf(foot);
    if (shift > 0) {
      for (const each of tail) ys.set(rowId(each), (ys.get(rowId(each)) ?? 0) + shift);
      for (const block of foot) block.top += shift;
    }
  } else {
    // Otherwise the spare room opens between the agents, each a zone of its own.
    const agents = [...new Set(rows.map((each) => each.agent))];
    const spare = start + height - bottom;
    if (agents.length > 1 && spare > 0) {
      const by = (agent: string) => (spare * agents.indexOf(agent)) / (agents.length - 1);
      for (const each of rows) ys.set(rowId(each), (ys.get(rowId(each)) ?? 0) + by(each.agent));
      for (const block of blocks) {
        const anchor = block.anchor && tree.get(block.anchor.row);
        if (anchor) block.top += by(anchor.agent);
      }
    }
  }

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
  const taken = treeRight - PAD + first + second;
  // A gap is wide enough for a lane into each feed of the column after it, and the spare is shared.
  const gaps = ([1, 2] as const).map((column) => {
    const lanes = feeds.filter(
      (feed) => feed.column === column && feed.from.length + (feed.late?.length ?? 0) > 0,
    ).length;
    return Math.max(LEAST_GAP, (lanes + 1) * LANE);
  });
  const [one = 0, two = 0] = gaps;
  const spare = box ? Math.max(0, box.width - 2 * (PAD + INSET) - taken - one - two) / 2 : 0;
  const widen = (gap: number) => Math.max(gap, Math.min(gap + spare, MOST_GAP));
  const lefts = [0, treeRight + widen(one), treeRight + widen(one) + first + widen(two)];

  const places = new Map<string, Place>();
  for (const [id, y] of ys) places.set(id, { x: INSET + (tree.get(id)?.x ?? 0), y });
  for (const block of blocks) {
    for (const id of block.group) {
      places.set(id, { x: INSET + (lefts[1] ?? 0), y: block.top + (block.offsets.get(id) ?? 0) });
    }
  }
  const yOf = (id: string): number | undefined => {
    const slot = slots.get(id);
    if (!slot) return places.get(id)?.y;
    const holder = yOf(slot.holder);
    return holder === undefined ? undefined : holder + slot.down * row;
  };
  // The runner: each block centred on the rows its head has lines from, or, a head without lines,
  // on the rows its feeds have lines from.
  const steps = blocksOf(runner, row).map((block) => {
    const [head] = block.group;
    const heads = head === undefined ? [] : sourcesOf(head);
    const sources = heads.length > 0 ? heads : [...block.offsets.keys()].flatMap(sourcesOf);
    const at = sources.flatMap((source) => {
      const y = yOf(source);
      return y === undefined ? [] : [y];
    });
    const want = at.length > 0 ? (Math.min(...at) + Math.max(...at)) / 2 - block.size / 2 : start;
    return { ...block, want };
  });
  // Groups keep their order a row apart, inside the map.
  let floor = start;
  for (const block of steps) {
    block.top = Math.max(block.want, floor);
    floor = block.top + block.size + 2 * row;
  }
  let ceiling = start + height;
  for (const block of steps.toReversed()) {
    block.top = Math.max(Math.min(block.top, ceiling - block.size), start);
    ceiling = block.top - 2 * row;
  }
  for (const block of steps) {
    for (const id of block.group) {
      places.set(id, { x: INSET + (lefts[2] ?? 0), y: block.top + (block.offsets.get(id) ?? 0) });
    }
  }
  const headings = HEADINGS.map((heading, index) => ({
    ...heading,
    x: INSET + (index === 0 ? PAD : (lefts[index] ?? 0)),
    y: PAD + INSET,
  }));
  return { places, row, headings };
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
  /** Grown, each column's heading: its top left corner. */
  headings: ({ label: string; note: string } & Place)[];
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
  ([1, 2] as const).forEach((column) => {
    const inColumn = layout.feeds.filter((feed) => feed.column === column);
    const head = inColumn.find((feed) => !layout.slots.has(feed.id));
    if (!head) return;
    const left = grown(head.id).x;
    const before =
      column === 1
        ? layout.rows.map(rowId)
        : layout.feeds.filter((feed) => feed.column === column - 1).map((feed) => feed.id);
    const space = left - rights(before);
    // why: As in the studio's map, the lines that share an end run as one: the end most lines share
    // takes them as its hub, then the end most of the rest share, a feed before a source when even.
    const links = inColumn.flatMap((feed) =>
      [...feed.from, ...(feed.late ?? [])]
        .filter((source) => !beside(layout, source, feed))
        .map((source) => ({ source, feed: feed.id })),
    );
    const hubs = new Map<string, typeof links>();
    let open = links;
    while (open.length > 0) {
      const ends = new Map<string, typeof links>();
      for (const link of open) {
        for (const end of [`>${link.feed}`, `${link.source}>`]) {
          ends.set(end, [...(ends.get(end) ?? []), link]);
        }
      }
      const feedEnd = (end: string) => end.startsWith('>');
      const [hub, taken] = [...ends].reduce((most, each) =>
        each[1].length > most[1].length ||
        (each[1].length === most[1].length && feedEnd(each[0]) && !feedEnd(most[0]))
          ? each
          : most,
      );
      hubs.set(hub, taken);
      open = open.filter((link) => !taken.includes(link));
    }
    const middle = (group: typeof links) =>
      group.reduce((sum, link) => sum + grown(link.feed).y, 0) / group.length;
    const runs = (group: typeof links, lane: number): Run[] =>
      group.map(({ source, feed }) => ({
        from: { x: grown(source).x + width(source), y: grown(source).y },
        to: grown(feed),
        lane,
      }));
    // The first lane is the nearest its column; to start, the top hub's.
    const order = [...hubs.values()].toSorted((a, b) => middle(a) - middle(b));
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
    order.forEach((group, index) => {
      const of = root(group[0]?.feed ?? head.id);
      for (const { source, feed } of group) {
        lanes.set(lineKey(source, feed), { of, by: grown(of).x - laneAt(index) });
      }
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

/** Whether `source` stands in `feed`'s own column: its line runs out to the right of the column and back. */
export function beside(layout: TreeMapLayout, source: string, feed: Feed): boolean {
  return layout.feeds.some((each) => each.id === source && each.column === feed.column);
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
        .flatMap((other) =>
          [...other.from, ...(other.late ?? [])].flatMap((source) => {
            const its = lanes.get(lineKey(source, other.id));
            return its
              ? [{ id: other.id, left: laneX(its), right: grown(other.id).x, reach: HALF }]
              : [];
          }),
        ),
    ];
    for (const source of [...feed.from, ...(feed.late ?? [])]) {
      if (beside(layout, source, feed)) continue;
      const lane = lanes.get(lineKey(source, feed.id));
      if (!lane) continue;
      const rail = laneX(lane);
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
  const { places, row, headings } = grownPlaces(rows, feeds, slots, width, box);
  const layout: TreeMapLayout = {
    rows,
    feeds,
    few,
    closed,
    grown: places,
    row,
    headings,
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
