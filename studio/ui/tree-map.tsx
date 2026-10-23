/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. Beside the tree, what feeds it, shared by
 * every agent drawn, in two columns beside it. The registries: the first tool of each type its Tools
 * rows allow, an agent tool's agent under it; the providers; and the trace destinations. The runner:
 * each provider's protocols under the provider stream; the tool runtime, with what it does with each
 * call; and the guardrail runtime, with what it does under it, and the telemetry engine. It changes
 * nothing and opens nothing: a picture of what a workspace holds, for a page that is not the studio.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import {
  IconArrowsMinimize,
  IconChecks,
  IconCloud,
  IconDatabase,
  IconKey,
  IconLock,
  IconPlugConnected,
  IconRepeat,
  IconSettingsAutomation,
  IconShieldCheck,
  IconStack2,
  IconTimeline,
  IconWorldCheck,
} from '@tabler/icons-react';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import { mapRoute } from '../map-line.ts';
import { createBlankDraft, libraryDraft, type StudioWorkspace } from '../mod.ts';
import {
  type Box,
  drawnAt,
  type Feed,
  HALF,
  INDENT,
  lineKey,
  MOVE_TO,
  PAD,
  type Place,
  placeAt,
  rowId,
  treeMapLayout,
} from './lib/tree-map-layout.ts';
import { AGENT_ICON, profileTypeIcon, toolTypeIcon } from './lib/type-icons.ts';
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
/** A token's width until it is measured. */
const GUESS = 120;

const STEP_ICONS: Record<string, IconType> = {
  sanitize: IconShieldCheck,
  compaction: IconArrowsMinimize,
  stream: IconCloud,
  tools: IconRepeat,
  validation: IconChecks,
  egress: IconShieldCheck,
  trace: IconTimeline,
};

const CHECK_ICONS: Record<string, IconType> = {
  permission: IconLock,
  'sign-in': IconKey,
  network: IconWorldCheck,
  result: IconShieldCheck,
};

function feedIcon(feed: Feed): IconType {
  const of = feed.of ?? '';
  if (feed.kind === 'step') return STEP_ICONS[of] ?? IconRepeat;
  if (feed.kind === 'provider') return IconCloud;
  if (feed.kind === 'protocol') return IconPlugConnected;
  if (feed.kind === 'tool') return toolTypeIcon(of);
  if (feed.kind === 'branch' || feed.kind === 'stream') return IconStack2;
  if (feed.kind === 'subagent') return profileTypeIcon(of) ?? AGENT_ICON;
  if (feed.kind === 'tool-runtime') return IconSettingsAutomation;
  if (feed.kind === 'guardrail-runtime') return IconShieldCheck;
  if (feed.kind === 'destinations') return IconDatabase;
  return CHECK_ICONS[of] ?? IconShieldCheck;
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
   * How far the tree has grown, from 0 to 1. As it grows each agent drifts into a zone of its own
   * and what feeds the tree spreads into its columns. What growing adds draws in as its room opens,
   * its line and then its token: the protocols under each provider, an agent tool's agent, the
   * runner's steps, the tool runner with what it does with each call, and the trace's destinations.
   * Shrinking takes it all back the same way.
   */
  grow?: number | undefined;
  /**
   * The box the map fills grown: its rows and gaps stretch to fill it, and it stands in the middle
   * of it. When the map cannot fit, it eases smaller as it grows until all of it does.
   */
  fit?: Box | undefined;
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
  const { width: fitWidth, height: fitHeight } = fit ?? { width: 0, height: 0 };
  const layout = useMemo(
    () =>
      treeMapLayout(
        workspace,
        agents,
        (id) => widths[id] ?? GUESS,
        fitWidth > 0 && fitHeight > 0 ? { width: fitWidth, height: fitHeight } : undefined,
      ),
    [workspace, agents, widths, fitWidth, fitHeight],
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
  /** A line draws in its first half of the later of its two ends drawing, its token in the second. */
  const lineDrawn = (...ids: string[]) => {
    const parts = ids.flatMap((id) => drawn(id) ?? []);
    if (parts.length === 0) return {};
    const part = Math.min(...parts);
    return { pathLength: 1, style: { strokeDasharray: 1, strokeDashoffset: 1 - clamp(part * 2) } };
  };
  const shown = feeds.filter((feed) => (drawn(feed.id) ?? 1) > 0);

  const right = (id: string) => at(id).x + width(id);
  const isRow = new Set(rows.map(rowId));
  /** Where a feed's lines end: a feed closed under another, at that one until it draws. */
  const endOf = (feed: Feed) => {
    const place = at(feed.id);
    if (!feed.closedUnder || feed.under === undefined) return place;
    const holder = at(feed.under);
    const part = clamp((drawn(feed.id) ?? 1) * 2);
    return { x: holder.x + (place.x - holder.x) * part, y: holder.y + (place.y - holder.y) * part };
  };
  const firstUnder = new Map<string, string>();
  for (const feed of feeds) {
    if (feed.under !== undefined && !firstUnder.has(feed.under))
      firstUnder.set(feed.under, feed.id);
  }
  // why: Closed, a line is the still's curve; grown, it runs down its feed's lane like the tree's.
  const square = clamp(grow / MOVE_TO);
  const lines = feeds.flatMap((feed) => {
    if (!feed.closedUnder && (drawn(feed.id) ?? 1) <= 0) return [];
    const late = (feed.late ?? []).map((source) => ({ source, late: true }));
    return [...feed.from.map((source) => ({ source, late: false })), ...late].flatMap(
      ({ source, late }) => {
        if (!isRow.has(source) && (drawn(source) ?? 1) <= 0) return [];
        const end = endOf(feed);
        const start = { x: right(source) + LINE_GAP, y: at(source).y };
        const lane = layout.lanes.get(feed.id);
        const rail = lane ? at(lane.of).x - lane.by : (start.x + end.x) / 2;
        const steps = (layout.jogs.get(lineKey(source, feed.id)) ?? []).map((jog) => ({
          x: at(jog.lane.of).x - jog.lane.by,
          y: at(jog.near).y + (jog.side * layout.row) / 2,
        }));
        const d = mapRoute(start, { x: end.x - LINE_GAP, y: end.y }, steps, rail, TURN, square);
        const draws = late
          ? [firstUnder.get(feed.id) ?? feed.id]
          : feed.closedUnder
            ? []
            : [feed.id, ...(isRow.has(source) ? [] : [source])];
        return [{ key: lineKey(source, feed.id), d, draws }];
      },
    );
  });
  const places = [...rows.map(rowId), ...shown.map((feed) => feed.id)];
  const mapWidth = Math.max(GUESS, ...places.map(right)) + PAD;
  const height = Math.max(...places.map((id) => at(id).y)) + HALF + PAD;
  const grown = useMemo(() => {
    const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
    const ends = ids.map((id) => ({ id, ...placeAt(layout, id, 1) }));
    return {
      width: Math.max(...ends.map((end) => end.x + (widths[end.id] ?? GUESS))) + PAD,
      height: Math.max(...ends.map((end) => end.y)) + HALF + PAD,
    };
  }, [layout, widths]);
  const fits = fit ? Math.min(1, fit.width / grown.width, fit.height / grown.height) : 1;
  const scale = 1 + (fits - 1) * clamp(grow);
  // why: Grown, the map stands in the middle of the box it fills; closed, at its top left.
  const centre = fit
    ? {
        x: (Math.max(0, fit.width - grown.width * fits) / 2) * clamp(grow),
        y: (Math.max(0, fit.height - grown.height * fits) / 2) * clamp(grow),
      }
    : NONE;
  // why: The pointer moves in the page's pixels; the map is scaled, so a move is divided back into its own.
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable || !drags(event)) return;
    event.preventDefault();
    const token = (event.target as Element).closest<HTMLElement>('[data-map-token]')?.dataset
      .mapToken;
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
  const shift = { x: field.x + centre.x, y: field.y + centre.y };
  const translate = shift.x || shift.y ? { translate: `${shift.x}px ${shift.y}px` } : {};

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
        {lines.map(({ key, d, draws }) => (
          <path key={key} className="map-line" d={d} {...lineDrawn(...draws)} />
        ))}
        {shown.map(
          (feed) =>
            feed.under !== undefined && (
              <path
                key={`${feed.id}^`}
                className="map-line"
                d={underPath(at(feed.under), at(feed.id))}
                {...lineDrawn(feed.id)}
              />
            ),
        )}
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
