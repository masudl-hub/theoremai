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
import { type CSSProperties, useRef } from 'react';
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
  parent?: Place;
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
      ...(parent ? { parent: { x: parent.x, y: parent.y } } : {}),
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

export interface StudioTreeMapProps {
  workspace: StudioWorkspace;
  /** The keys of the agents to draw, in the workspace's order; every agent when unset. */
  agents?: readonly string[] | undefined;
  /**
   * Every tool in the registry, not a few, and each turn runner opened into the steps of a turn. Turned on, what is drawn moves to make room, then each
   * node it adds draws in after the one before, its line first, as the loader's map draws; turned
   * off, they leave in the reverse order and the rest moves back.
   */
  detail?: boolean | undefined;
}

/** The order an added node draws in, and which end its line starts from: 1 the path's start, -1 its end. */
const addedStyle = (index: number, from: 1 | -1 = 1) =>
  ({ '--added-i': index, '--added-from': from }) as CSSProperties;

/**
 * A line's path as a style too, so a line that moves eases to its new shape where the browser
 * eases `d`; the attribute draws it where it does not.
 */
const pathStyle = (d: string, style?: CSSProperties) =>
  ({ ...style, d: `path("${d}")` }) as CSSProperties;

export function StudioTreeMap({ workspace, agents, detail = false }: StudioTreeMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const rows = rowsOf(workspace, agents);
  const few = feedsOf(workspace, rows, false);
  const full = feedsOf(workspace, rows, true);
  const fewIds = new Set(few.map((feed) => feed.id));
  const addedIndex = new Map(
    full.filter((feed) => !fewIds.has(feed.id)).map((feed, index) => [feed.id, index]),
  );
  /** The feeds laid out; without detail, an added one waits on the feed it comes under. */
  const feeds = detail ? full : few;
  const widths = useTokenWidths(root, workspace);
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const right = (row: Row) => row.x + (widths[rowId(row)] ?? GUESS);
  const feedX = Math.max(0, ...rows.map(right)) + GAP;
  const byId = new Map(rows.map((row) => [rowId(row), row]));
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const placed = (feed: Feed): Feed =>
    feedById.get(feed.id) ?? { ...feed, y: feedById.get(feed.under ?? '')?.y ?? feed.y };
  const height = PAD * 2 + Math.max(rows.length * ROW, ...feeds.map((feed) => feed.y + HALF - PAD));
  const feedLeft = (feed: Feed) => feedX + feed.depth * INDENT;
  const feedRight = (feed: Feed) => feedLeft(feed) + (widths[feed.id] ?? GUESS);
  /** Right of every feed from `above` down to `feed`. */
  const railFor = (feed: Feed, above: Feed) =>
    Math.max(...feeds.filter((each) => each.y >= above.y && each.y <= feed.y).map(feedRight)) +
    RAIL;
  const rails = feeds.flatMap((feed) => {
    const above = feed.under === undefined ? undefined : feedById.get(feed.under);
    return above && feed.depth <= above.depth ? [railFor(feed, above)] : [];
  });
  const width = Math.max(GUESS, ...feeds.map(feedRight), ...rails) + PAD;
  /** What marks a node or line detail adds: its turn to draw, and the end its line draws from. */
  const addedProps = (id: string, from: 1 | -1 = 1) => {
    const index = addedIndex.get(id);
    return index === undefined ? {} : { 'data-added': '', style: addedStyle(index, from) };
  };
  return (
    <div
      ref={root}
      className="studio-tree-map"
      data-detail={detail ? '' : undefined}
      style={{ width, height, '--added-n': addedIndex.size } as CSSProperties}
    >
      <svg className="studio-tree-map-lines" width={width} height={height} aria-hidden="true">
        {rows.map(
          (row) =>
            row.parent && (
              <path
                key={rowId(row)}
                className="map-line"
                d={linePath(row.parent, row)}
                style={pathStyle(linePath(row.parent, row))}
              />
            ),
        )}
        {full.flatMap((each) => {
          const feed = placed(each);
          return feed.into.map((id) => {
            const row = byId.get(id);
            if (!row) return null;
            const { d } = mapCurve(
              { x: feedX - LINE_GAP, y: feed.y },
              { x: right(row) + LINE_GAP, y: row.y },
            );
            // The line runs from the feed to the row; it draws from the row.
            const { style, ...added } = addedProps(feed.id, -1);
            return (
              <path
                key={`${feed.id}>${id}`}
                className="map-line"
                d={d}
                pathLength={1}
                style={pathStyle(d, style)}
                {...added}
              />
            );
          });
        })}
        {full.map((each) => {
          const feed = placed(each);
          const above = feed.under === undefined ? undefined : feedById.get(feed.under);
          if (above === undefined) return null;
          const from = { x: feedLeft(above), y: above.y };
          // One of its own turns in from the trunk, as a tree row does; one level with it comes round
          // the right of what lies between, so it reads as joining the feed, not as one of its own.
          const isOwn = feed.depth > above.depth;
          const d = isOwn
            ? linePath(from, { x: feedLeft(feed), y: feed.y })
            : sidePath(
                { x: feedRight(feed) + LINE_GAP, y: feed.y },
                { x: feedRight(above) + LINE_GAP, y: above.y },
                railFor(feed, above),
              );
          // A turn in runs from the feed above; a line round the side runs from this one.
          const { style, ...added } = addedProps(feed.id, isOwn ? 1 : -1);
          return (
            <path
              key={`${feed.id}^`}
              className="map-line"
              d={d}
              pathLength={1}
              style={pathStyle(d, style)}
              {...added}
            />
          );
        })}
      </svg>
      {rows.map((row) => {
        const draft = drafts.get(row.agent) ?? createBlankDraft();
        return (
          <MapToken
            key={rowId(row)}
            id={rowId(row)}
            label={row.node.label}
            icon={nodeIcon(draft, row.node.ref)}
            x={row.x}
            y={row.y}
          />
        );
      })}
      {full.map((each) => {
        const feed = placed(each);
        return (
          <MapToken
            key={feed.id}
            id={feed.id}
            label={feed.label}
            icon={feed.icon}
            x={feedLeft(feed)}
            y={feed.y}
            {...addedProps(feed.id)}
          />
        );
      })}
    </div>
  );
}
