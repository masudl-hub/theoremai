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
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { mapCurve } from '../map-line.ts';
import { createBlankDraft, libraryDraft, type StudioWorkspace } from '../mod.ts';
import {
  drawnAt,
  type Feed,
  HALF,
  INDENT,
  PAD,
  type Place,
  placeAt,
  rowId,
  treeMapLayout,
} from './lib/tree-map-layout.ts';
import { toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import { nodeIcon } from './node-icon.ts';
import { drags, follow } from './pan.ts';
import './tree-map.css';

/** Where under a token its children's line runs: the middle of its icon. */
const TRUNK = 13;
/** The radius of the line's turn. */
const TURN = 8;
/** Between a token's side and its line. */
const LINE_GAP = 4;
/** How far right of the widest feed a line coming round them runs. */
const RAIL = 20;
/** A token's width until it is measured. */
const GUESS = 120;

const STEP_ICONS: Record<string, IconType> = {
  resolve: IconAdjustments,
  sanitize: IconShieldCheck,
  compaction: IconArrowsMinimize,
  canary: IconKey,
  pre_turn: IconFlag,
  stream: IconCloud,
  tools: IconRepeat,
  before_end: IconFlag,
  validation: IconChecks,
  egress: IconShieldCheck,
  trace: IconTimeline,
  post_turn: IconFlag,
};

function feedIcon(feed: Feed): IconType {
  if (feed.kind === 'runner') return IconEngine;
  if (feed.kind === 'provider') return IconCloud;
  if (feed.kind === 'tool') return toolTypeIcon(feed.of ?? '');
  if (feed.kind === 'tool-runner') return IconSettingsAutomation;
  if (feed.kind === 'step') return STEP_ICONS[feed.of ?? ''] ?? IconFlag;
  return IconTool;
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

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

export interface StudioTreeMapProps {
  workspace: StudioWorkspace;
  /** The keys of the agents to draw, in the workspace's order; every agent when unset. */
  agents?: readonly string[] | undefined;
  /**
   * How far the tree has grown, from 0 to 1. As it grows each agent drifts into a zone of its own,
   * its runner and providers level with its rows, and room opens under each feed for its own. What
   * growing adds draws in as its room opens, its line and then its token: the steps of a turn under
   * each turn runner, and every tool in the registry. Shrinking takes it all back the same way.
   */
  grow?: number | undefined;
  /** The box the map fits grown: growing, it eases smaller until all of it fits. */
  fit?: { width: number; height: number } | undefined;
  /** A token dragged moves to where it is dropped, its lines with it; the field dragged moves the whole map. */
  draggable?: boolean | undefined;
}

type Shift = { x: number; y: number };
const NONE: Shift = { x: 0, y: 0 };

export function StudioTreeMap({
  workspace,
  agents,
  grow = 0,
  fit,
  draggable = false,
}: StudioTreeMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const [moved, setMoved] = useState<Record<string, Shift>>({});
  const [field, setField] = useState<Shift>(NONE);
  const [dragging, setDragging] = useState(false);
  // why: Every token is drawn from the start, the undrawn ones unseen, so each is measured before it shows.
  const widths = useTokenWidths(root, workspace);
  const layout = useMemo(
    () => treeMapLayout(workspace, agents, (id) => widths[id] ?? GUESS),
    [workspace, agents, widths],
  );
  const width = (id: string) => widths[id] ?? GUESS;
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const { rows, feeds } = layout;
  const at = (id: string) => {
    const place = placeAt(layout, id, grow);
    const by = moved[id] ?? NONE;
    return { ...place, x: place.x + by.x, y: place.y + by.y };
  };
  const drawn = (id: string) => drawnAt(layout, id, grow);
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  const lineDrawn = (id: string) => {
    const part = drawn(id);
    return part === undefined
      ? {}
      : { pathLength: 1, style: { strokeDasharray: 1, strokeDashoffset: 1 - clamp(part * 2) } };
  };
  const shown = feeds.filter((feed) => (drawn(feed.id) ?? 1) > 0);

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
  const grown = useMemo(() => {
    const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
    const ends = ids.map((id) => ({ id, ...placeAt(layout, id, 1) }));
    return {
      width: Math.max(...ends.map((end) => end.x + (widths[end.id] ?? GUESS))) + RAIL + PAD,
      height: Math.max(...ends.map((end) => end.y)) + HALF + PAD,
    };
  }, [layout, widths]);
  const fits = fit ? Math.min(1, fit.width / grown.width, fit.height / grown.height) : 1;
  const scale = 1 + (fits - 1) * clamp(grow);
  // why: The pointer moves in the page's pixels; the map is scaled, so a move is divided back into its own.
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable || !drags(event)) return;
    event.preventDefault();
    const token = (event.target as Element).closest<HTMLElement>('[data-map-token]')?.dataset[
      'mapToken'
    ];
    const from = token === undefined ? field : (moved[token] ?? NONE);
    const put = (to: Shift) => {
      if (token === undefined) setField(to);
      else setMoved((last) => ({ ...last, [token]: to }));
    };
    setDragging(true);
    follow(
      event,
      (x, y) => {
        put(
          token === undefined
            ? { x: from.x + x, y: from.y + y }
            : { x: from.x + x / scale, y: from.y + y / scale },
        );
      },
      () => {
        setDragging(false);
      },
    );
  };
  const translate = field.x || field.y ? { translate: `${field.x}px ${field.y}px` } : {};

  return (
    <div
      ref={root}
      className="studio-tree-map"
      style={{
        width: mapWidth,
        height,
        ...translate,
        ...(scale < 1 ? { scale: String(scale) } : {}),
      }}
      data-draggable={draggable ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={drag}
    >
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
      {feeds.map((feed) => {
        const { x, y } = at(feed.id);
        const part = drawn(feed.id);
        const unseen = part === 0 ? { visibility: 'hidden' as const } : {};
        return (
          <MapToken
            key={feed.id}
            id={feed.id}
            label={feed.label}
            icon={feedIcon(feed)}
            x={x}
            y={y}
            {...(part === undefined ? {} : { style: { ...unseen, opacity: clamp(part * 2 - 1) } })}
          />
        );
      })}
    </div>
  );
}
