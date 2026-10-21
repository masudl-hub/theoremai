/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. Beside the tree, what feeds it: the
 * runner that runs each agent (its turns, or its decisions), the providers that serve its models, and the tool registry its
 * tool policy picks from, a few of its tools nested under it and the tool runner under those, each
 * with a line into its row. It changes nothing and opens nothing: a picture of what a workspace holds, for a
 * page that is not the studio.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import {
  IconAdjustments,
  IconArrowsMinimize,
  IconChecks,
  IconCloud,
  IconEngine,
  IconFlag,
  IconKey,
  IconRepeat,
  IconSettingsAutomation,
  IconShieldCheck,
  IconTimeline,
  IconTool,
} from '@tabler/icons-react';
import { useRef } from 'react';
import { mapCurve } from '../map-line.ts';
import {
  createBlankDraft,
  libraryDraft,
  type StudioTreeNode,
  type StudioWorkspace,
  workspaceTree,
} from '../mod.ts';
import { toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import { nodeIcon } from './node-icon.ts';
import './tree-map.css';

/** A row's height, and how far in each level of the tree starts. */
const ROW = 32;
const INDENT = 28;
/** Where under a token its children's line runs: the middle of its icon. */
const TRUNK = 13;
/** A token's half height, and the radius of the line's turn. */
const HALF = 11;
const TURN = 8;
const PAD = 16;
/** Between the tree's widest row and the feeds, and between a token's side and its line. */
const GAP = 72;
const LINE_GAP = 4;
/** How far right of the widest feed a line coming round them runs. */
const RAIL = 20;
/** How many of the registry's tools sit under it: one of each type first. */
const SHOWN_TOOLS = 4;
const TOOL_TYPES = ['function', 'http', 'mcp', 'agent'];
/** A token's width until it is measured. */
const GUESS = 120;

interface Place {
  x: number;
  y: number;
}

interface Row extends Place {
  node: StudioTreeNode;
  agent: string;
  /** The row above it in the tree, by its token id. */
  parent?: string;
}

/** A runner, a provider or the tool registry beside the tree, the rows it joins, and the feed above it that it runs. */
interface Feed {
  id: string;
  label: string;
  icon: IconType;
  y: number;
  into: string[];
  /** Under another feed: a level in when it is one of that feed's own, else level with it. */
  under?: string;
  depth: number;
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

/** A row's token id: the tree's ids repeat from one agent to the next. */
function rowId(row: Row): string {
  return `${row.agent}/${row.node.id}`;
}

/**
 * Each agent's runner (`runTurn`, or `runDecision` for a decision), beside its name; its providers, beside its models; and the
 * workspace's tool registry, beside its Tools row, with the tool runner under it. A feed sits level
 * with the middle of the rows it joins, or under the feed before it when that is lower.
 */
const REGISTRY = 'tool-registry';

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
 * What a turn runner does in one turn, in order.
 * why: The kernel contract's turn lifecycle (docs/contracts/kernel.md, "Turn lifecycle"), step for
 * step; a decision and a session have no such list there, so their runners open into nothing.
 */
const TURN_STEPS: readonly { id: string; label: string; icon: IconType }[] = [
  { id: 'resolve', label: 'Resolve', icon: IconAdjustments },
  { id: 'sanitize', label: 'Sanitize', icon: IconShieldCheck },
  { id: 'compaction', label: 'Compaction', icon: IconArrowsMinimize },
  { id: 'canary', label: 'Canary bind', icon: IconKey },
  { id: 'pre_turn', label: 'pre_turn', icon: IconFlag },
  { id: 'stream', label: 'Provider stream', icon: IconCloud },
  { id: 'tools', label: 'Tool loop', icon: IconRepeat },
  { id: 'before_end', label: 'before_end', icon: IconFlag },
  { id: 'validation', label: 'Validation', icon: IconChecks },
  { id: 'egress', label: 'Egress', icon: IconShieldCheck },
  { id: 'trace', label: 'Trace', icon: IconTimeline },
  { id: 'post_turn', label: 'post_turn', icon: IconFlag },
];

function feedsOf(workspace: StudioWorkspace, rows: Row[], detail: boolean): Feed[] {
  const feeds: Feed[] = [];
  const add = (
    id: string,
    label: string,
    icon: IconType,
    into: Row[],
    under?: string,
    depth = 0,
  ) => {
    const below = (feeds.at(-1)?.y ?? Number.NEGATIVE_INFINITY) + ROW;
    const middle = into.length ? into.reduce((sum, row) => sum + row.y, 0) / into.length : below;
    feeds.push({
      id,
      label,
      icon,
      y: Math.max(middle, below),
      into: into.map(rowId),
      ...(under ? { under } : {}),
      depth,
    });
  };
  for (const agent of workspace.agents) {
    const mine = rows.filter((row) => row.agent === agent.key);
    const name = mine.find((row) => row.node.ref.facet === 'identity');
    if (!name) continue;
    const runner = runnerLabel(agent.identity.profileType);
    if (runner) {
      const id = `${agent.key}/runner`;
      add(id, runner, IconEngine, [name]);
      const steps = detail && runner === 'Turn runner' ? TURN_STEPS : [];
      for (const step of steps) add(`${id}/${step.id}`, step.label, step.icon, [], id, 1);
    }
    const providers = new Map<string, Row[]>();
    for (const binding of agent.modelBindings) {
      const row = mine.find(
        (each) => each.node.ref.facet === 'modelBinding' && each.node.ref.key === binding.key,
      );
      if (row) providers.set(binding.provider, [...(providers.get(binding.provider) ?? []), row]);
    }
    for (const [provider, into] of providers) {
      add(`${agent.key}/provider:${provider}`, provider, IconCloud, into);
    }
    // The workspace's tools are one registry that each agent's tool policy picks from: drawn once,
    // beside the first Tools row, with a line into every other.
    const tools = mine.find((row) => row.node.ref.facet === 'tools');
    const drawn = feeds.find((feed) => feed.id === REGISTRY);
    if (tools && drawn) drawn.into.push(rowId(tools));
    else if (tools && workspace.toolSpecs.length > 0) {
      const registry = REGISTRY;
      add(registry, 'Tool registry', IconTool, [tools]);
      for (const tool of listedTools(workspace.toolSpecs, detail)) {
        const icon = toolTypeIcon(tool.toolType);
        add(`${registry}/${tool.key}`, tool.toolName, icon, [], registry, 1);
      }
      add('tool-runner', 'Tool runner', IconSettingsAutomation, [], registry);
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

/** Right from `from` to `rail`, up or down it, and back left to `to`, its corners turned. */
function sidePath(from: Place, to: Place, rail: number): string {
  const up = Math.sign(to.y - from.y);
  return (
    `M ${from.x} ${from.y} H ${rail - TURN} Q ${rail} ${from.y} ${rail} ${from.y + up * TURN}` +
    ` V ${to.y - up * TURN} Q ${rail} ${to.y} ${rail - TURN} ${to.y} H ${to.x}`
  );
}

/** Down from under the parent's icon, then a turn across to the child. */
function linePath(from: Place, to: Place): string {
  const x = from.x + TRUNK;
  return `M ${x} ${from.y + HALF} V ${to.y - TURN} Q ${x} ${to.y} ${x + TURN} ${to.y} H ${to.x - LINE_GAP}`;
}

/**
 * From under the parent's icon to a child in any column of the rows under it: across just under
 * the parent to the child's own trunk, a level in from the child, then down it and across. A child
 * one level in has its trunk under the parent's icon, so it is the tree's line.
 */
function underPath(from: Place, to: Place): string {
  const trunk = to.x - INDENT + TRUNK;
  const across = from.y + HALF + LINE_GAP;
  return (
    `M ${from.x + TRUNK} ${from.y + HALF} V ${across} H ${trunk} V ${to.y - TURN}` +
    ` Q ${trunk} ${to.y} ${trunk + TURN} ${to.y} H ${to.x - LINE_GAP}`
  );
}

export interface StudioTreeMapProps {
  workspace: StudioWorkspace;
  /** The keys of the agents to draw, in the workspace's order; every agent when unset. */
  agents?: readonly string[] | undefined;
  /**
   * How far the tree has grown, from 0 to 1. As it grows each section drifts to its own zone: the
   * providers to a band along the top, each agent's tree apart from the next with its runner level
   * with it, and the tool registry to a field of its own. What growing adds draws in on the way,
   * each over its own stretch, its line and then its token: the steps of a turn under each turn
   * runner, and every tool in the registry. Shrinking takes it all back the same way.
   */
  grow?: number | undefined;
}

/** Grown, a row's height and the room between two agents' trees. */
const GROWN_ROW = 28;
const AGENT_GAP = 16;
/** Grown, the providers' band and the room under it. */
const BAND = GROWN_ROW + AGENT_GAP;
/** Grown, a turn's steps in rows under its runner, so many to a row. */
const STEPS_ACROSS = 3;
const STEP_SLOT = 160;
/** Grown, the registry's field: right of the turn's steps, its tools in columns this tall. */
const REGISTRY_IN = 186;
const TOOLS_DOWN = 16;
const TOOL_SLOT = 210;
/** Over what stretch of growing the added nodes draw, and how long each takes of it. */
const DRAW_FROM = 0.2;
const DRAW_TO = 0.95;
const DRAW_SPAN = 0.1;

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
const between = (from: number, to: number, at: number) => from + (to - from) * at;

/** Every other one from each list, while both last: the turn's steps and the tools draw by turns. */
function byTurns<T>(first: T[], second: T[]): T[] {
  return Array.from({ length: Math.max(first.length, second.length) }, (_, index) =>
    [first[index], second[index]].filter((each): each is T => each !== undefined),
  ).flat();
}

/** The rows grown: restacked, each agent apart from the next, under the providers' band. */
function grownRows(rows: Row[]): Map<string, Place> {
  const places = new Map<string, Place>();
  let agents = -1;
  rows.forEach((row, index) => {
    if (index === 0 || rows[index - 1]?.agent !== row.agent) agents += 1;
    places.set(rowId(row), {
      x: row.x,
      y: PAD + HALF + BAND + index * GROWN_ROW + agents * AGENT_GAP,
    });
  });
  return places;
}

/** What placing the feeds one by one keeps: the band so far, each holder's count, the steps' end. */
interface Growing {
  places: Map<string, Place>;
  band: Map<string, Place>;
  bandX: number;
  under: Map<string, number>;
  stepsEnd: number;
  feedX: number;
  width: (id: string) => number;
}

/** The next place under a holder, counting it. */
function nextUnder(growing: Growing, holder: string): number {
  const index = growing.under.get(holder) ?? 0;
  growing.under.set(holder, index + 1);
  return index;
}

/** A provider's place in the band, by name: an agent that has one too shares it. */
function bandPlace(growing: Growing, feed: Feed): Place {
  const held = growing.band.get(feed.label);
  if (held) return held;
  const place = { x: growing.bandX, y: PAD + HALF };
  growing.band.set(feed.label, place);
  growing.bandX += growing.width(feed.id) + AGENT_GAP;
  return place;
}

/** Under the registry: its tools in columns, then the tool runner below them. */
function registryPlace(growing: Growing, feed: Feed, above: Place): Place {
  if (feed.depth === 0) {
    const tools = Math.min(growing.under.get(REGISTRY) ?? 0, TOOLS_DOWN);
    return { x: above.x, y: above.y + (tools + 1) * GROWN_ROW };
  }
  const index = nextUnder(growing, REGISTRY);
  return {
    x: above.x + INDENT + Math.floor(index / TOOLS_DOWN) * TOOL_SLOT,
    y: above.y + ((index % TOOLS_DOWN) + 1) * GROWN_ROW,
  };
}

/** A step under its runner, in rows so many across. */
function stepPlace(growing: Growing, holder: string, above: Place): Place {
  const index = nextUnder(growing, holder);
  const y = above.y + (Math.floor(index / STEPS_ACROSS) + 1) * GROWN_ROW;
  growing.stepsEnd = Math.max(growing.stepsEnd, y);
  return { x: above.x + INDENT + (index % STEPS_ACROSS) * STEP_SLOT, y };
}

function feedPlace(growing: Growing, feed: Feed): Place {
  if (feed.id.includes('/provider:')) return bandPlace(growing, feed);
  if (feed.id === REGISTRY) {
    return { x: growing.feedX + REGISTRY_IN, y: growing.stepsEnd + GROWN_ROW * 1.5 };
  }
  const above = feed.under === undefined ? undefined : growing.places.get(feed.under);
  if (feed.under === REGISTRY && above) return registryPlace(growing, feed, above);
  if (feed.under !== undefined && above) return stepPlace(growing, feed.under, above);
  const into = growing.places.get(feed.into[0] ?? '');
  return { x: growing.feedX, y: into?.y ?? feed.y };
}

/** Each node's place grown: by its token id, rows and feeds alike. */
function grownPlaces(
  rows: Row[],
  feeds: Feed[],
  feedX: number,
  width: (id: string) => number,
): Map<string, Place> {
  const growing: Growing = {
    places: grownRows(rows),
    band: new Map(),
    bandX: feedX,
    under: new Map(),
    stepsEnd: PAD + HALF + BAND,
    feedX,
    width,
  };
  for (const feed of feeds) growing.places.set(feed.id, feedPlace(growing, feed));
  return growing.places;
}

export function StudioTreeMap({ workspace, agents, grow = 0 }: StudioTreeMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const rows = rowsOf(workspace, agents);
  const few = feedsOf(workspace, rows, false);
  const full = feedsOf(workspace, rows, true);
  const widths = useTokenWidths(root, workspace);
  const width = (id: string) => widths[id] ?? GUESS;
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const feedX = Math.max(0, ...rows.map((row) => row.x + width(rowId(row)))) + GAP;

  // The tree as it stands: the rows, and the few feeds beside them.
  const closed = new Map<string, Place>(rows.map((row) => [rowId(row), row]));
  for (const feed of few) closed.set(feed.id, { x: feedX + feed.depth * INDENT, y: feed.y });
  const grown = grownPlaces(rows, full, feedX, width);
  const feedById = new Map(full.map((feed) => [feed.id, feed]));
  /**
   * Where a node is, this far grown. One growing adds keeps its place in its zone and rides with
   * the feed it comes under, so a zone drifts whole.
   */
  const at = (id: string): Place => {
    const to = grown.get(id) ?? closed.get(id) ?? { x: 0, y: 0 };
    const from = closed.get(id);
    if (from) return { x: between(from.x, to.x, grow), y: between(from.y, to.y, grow) };
    const under = feedById.get(id)?.under;
    const holder = under === undefined ? undefined : grown.get(under);
    if (under === undefined || holder === undefined) return to;
    const now = at(under);
    return { x: to.x + now.x - holder.x, y: to.y + now.y - holder.y };
  };

  // What growing adds draws in order, the turn's steps and the tools by turns.
  const fewIds = new Set(few.map((feed) => feed.id));
  const added = full.filter((feed) => !fewIds.has(feed.id));
  const order = byTurns(
    added.filter((feed) => feed.under !== REGISTRY),
    added.filter((feed) => feed.under === REGISTRY),
  );
  /** How far an added node has drawn, 0 to 1: its line in the first half, its token in the second. */
  const drawn = new Map(
    order.map((feed, index) => {
      const start =
        DRAW_FROM + ((DRAW_TO - DRAW_SPAN - DRAW_FROM) * index) / Math.max(order.length - 1, 1);
      return [feed.id, clamp((grow - start) / DRAW_SPAN)];
    }),
  );
  const lineDrawn = (id: string) => {
    const part = drawn.get(id);
    return part === undefined
      ? {}
      : { pathLength: 1, style: { strokeDasharray: 1, strokeDashoffset: 1 - clamp(part * 2) } };
  };
  const shown = full.filter((feed) => (drawn.get(feed.id) ?? 1) > 0);

  const right = (id: string) => at(id).x + width(id);
  /** Right of every feed from `above` down to `feed`, where each stands now. */
  const railFor = (feed: Feed, above: Feed) => {
    const [top, bottom] = [at(above.id).y, at(feed.id).y].sort((a, b) => a - b);
    const lying = shown.filter((each) => {
      const { y } = at(each.id);
      return y >= (top ?? 0) && y <= (bottom ?? 0) && each.id !== feed.id;
    });
    return Math.max(right(feed.id), ...lying.map((each) => right(each.id))) + RAIL;
  };
  const places = [...rows.map(rowId), ...shown.map((feed) => feed.id)];
  const rails = shown.flatMap((feed) => {
    const above = feed.under === undefined ? undefined : feedById.get(feed.under);
    return above && feed.depth <= above.depth ? [railFor(feed, above)] : [];
  });
  const mapWidth = Math.max(GUESS, ...places.map(right), ...rails) + PAD;
  const height = Math.max(...places.map((id) => at(id).y)) + HALF + PAD;

  return (
    <div ref={root} className="studio-tree-map" style={{ width: mapWidth, height }}>
      <svg className="studio-tree-map-lines" width={mapWidth} height={height} aria-hidden="true">
        {rows.map(
          (row) =>
            row.parent && (
              <path
                key={rowId(row)}
                className="map-line"
                d={linePath(at(row.parent), at(rowId(row)))}
              />
            ),
        )}
        {shown.flatMap((feed) =>
          feed.into.map((id) => {
            const from = at(feed.id);
            const { d } = mapCurve(
              { x: from.x - LINE_GAP, y: from.y },
              { x: right(id) + LINE_GAP, y: at(id).y },
            );
            return <path key={`${feed.id}>${id}`} className="map-line" d={d} />;
          }),
        )}
        {shown.map((feed) => {
          const above = feed.under === undefined ? undefined : feedById.get(feed.under);
          if (above === undefined) return null;
          // One of its own comes down from it, as a tree row does; one level with it comes round
          // the right of what lies between, so it reads as joining the feed, not as one of its own.
          const d =
            feed.depth > above.depth
              ? underPath(at(above.id), at(feed.id))
              : sidePath(
                  { x: right(feed.id) + LINE_GAP, y: at(feed.id).y },
                  { x: right(above.id) + LINE_GAP, y: at(above.id).y },
                  railFor(feed, above),
                );
          return <path key={`${feed.id}^`} className="map-line" d={d} {...lineDrawn(feed.id)} />;
        })}
      </svg>
      {rows.map((row) => {
        const draft = drafts.get(row.agent) ?? createBlankDraft();
        const { x, y } = at(rowId(row));
        return (
          <MapToken
            key={rowId(row)}
            id={rowId(row)}
            label={row.node.label}
            icon={nodeIcon(draft, row.node.ref)}
            x={x}
            y={y}
          />
        );
      })}
      {shown.map((feed) => {
        const { x, y } = at(feed.id);
        const part = drawn.get(feed.id);
        return (
          <MapToken
            key={feed.id}
            id={feed.id}
            label={feed.label}
            icon={feed.icon}
            x={x}
            y={y}
            {...(part === undefined ? {} : { style: { opacity: clamp(part * 2 - 1) } })}
          />
        );
      })}
    </div>
  );
}
