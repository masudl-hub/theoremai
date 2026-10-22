/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. Beside the tree, what feeds it, shared by
 * every agent drawn: the providers that serve its models, the protocols they speak under them; the
 * first tool of each type its Tools rows allow, an MCP tool's sessions and an agent tool's agent
 * under them; and the one runner that runs every agent, its steps under it. Past those, the tool
 * runner its tool loop calls, with what it checks of each call. It changes nothing and opens
 * nothing: a picture of what a workspace holds, for a page that is not the studio.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import {
  IconAdjustments,
  IconArrowsMinimize,
  IconChecks,
  IconCloud,
  IconEngine,
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
import { mapCurve } from '../map-line.ts';
import { createBlankDraft, libraryDraft, type StudioWorkspace } from '../mod.ts';
import {
  type Box,
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
/** How far right of what it passes a line coming round a column runs. */
const RAIL = 20;
/** A token's width until it is measured. */
const GUESS = 120;

const STEP_ICONS: Record<string, IconType> = {
  resolve: IconAdjustments,
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
  if (feed.kind === 'runner') return IconEngine;
  if (feed.kind === 'step') return STEP_ICONS[of] ?? IconRepeat;
  if (feed.kind === 'provider') return IconCloud;
  if (feed.kind === 'protocol') return IconPlugConnected;
  if (feed.kind === 'tool') return toolTypeIcon(of);
  if (feed.kind === 'branch') return IconStack2;
  if (feed.kind === 'subagent') return profileTypeIcon(of) ?? AGENT_ICON;
  if (feed.kind === 'tool-runner') return IconSettingsAutomation;
  return CHECK_ICONS[of] ?? IconShieldCheck;
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
   * How far the tree has grown, from 0 to 1. As it grows each agent drifts into a zone of its own
   * and what feeds the tree spreads into its columns. What growing adds draws in as its room opens,
   * its line and then its token: the protocols under each provider, what branches off a tool, the
   * runner's steps, and the tool runner with its checks. Shrinking takes it all back the same way.
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
  const feedById = new Map(feeds.map((feed) => [feed.id, feed]));
  /** A line draws in its first half of the later of its two ends drawing, its token in the second. */
  const lineDrawn = (...ids: string[]) => {
    const parts = ids.flatMap((id) => drawn(id) ?? []);
    if (parts.length === 0) return {};
    const part = Math.min(...parts);
    return { pathLength: 1, style: { strokeDasharray: 1, strokeDashoffset: 1 - clamp(part * 2) } };
  };
  const shown = feeds.filter((feed) => (drawn(feed.id) ?? 1) > 0);

  const right = (id: string) => at(id).x + width(id);
  /** Right of every feed in its column from `to` to `feed`, where each stands now. */
  const railFor = (feed: Feed, to: Feed) => {
    const [top, bottom] = [at(to.id).y, at(feed.id).y].sort((a, b) => a - b);
    const lying = shown.filter((each) => {
      const { y } = at(each.id);
      return each.column === feed.column && y >= (top ?? 0) && y <= (bottom ?? 0);
    });
    return Math.max(...lying.map((each) => right(each.id))) + RAIL;
  };
  const joins = shown.flatMap((feed) => {
    const to = feed.joins === undefined ? undefined : feedById.get(feed.joins);
    return to && (drawn(to.id) ?? 1) > 0 ? [{ feed, to }] : [];
  });
  /** A join to a feed further right runs across to it; to one in its own column, round their right. */
  const joinPath = (feed: Feed, to: Feed) => {
    const from = { x: right(feed.id) + LINE_GAP, y: at(feed.id).y };
    if (to.column > feed.column) {
      return mapCurve(from, { x: at(to.id).x - LINE_GAP, y: at(to.id).y }).d;
    }
    return sidePath(from, { x: right(to.id) + LINE_GAP, y: at(to.id).y }, railFor(feed, to));
  };
  const places = [...rows.map(rowId), ...shown.map((feed) => feed.id)];
  const rails = joins.flatMap(({ feed, to }) =>
    to.column === feed.column ? [railFor(feed, to)] : [],
  );
  const mapWidth = Math.max(GUESS, ...places.map(right), ...rails) + PAD;
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
        {joins.map(({ feed, to }) => (
          <path
            key={`${feed.id}~${to.id}`}
            className="map-line"
            d={joinPath(feed, to)}
            {...lineDrawn(feed.id, to.id)}
          />
        ))}
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
