/**
 * The workspace's tree, every row open, drawn as the map draws: each row a map token, and a line
 * from each row down and across to each of its children. Beside the tree, what feeds it, shared by
 * every agent drawn, in two columns beside it. The registries: each tool its Tools rows allow, by
 * type, an agent tool's agent under it; the providers; and the trace destinations. The runner:
 * the provider protocols, each provider's under one head; the tool runner, with what it does with each
 * call; and the guard runner, with what it does under it, and the trace exporter. It changes
 * nothing and opens nothing: a picture of what a workspace holds, for a page that is not the studio.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import {
  IconArrowsMinimize,
  IconCloud,
  IconCpu,
  IconDatabase,
  IconKey,
  IconLock,
  IconPlugConnected,
  IconRepeat,
  IconRotateClockwise,
  IconSettingsAutomation,
  IconShieldCheck,
  IconStack2,
  IconTimeline,
  IconVault,
  IconWorldCheck,
} from '@tabler/icons-react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type MapPlace, mapBracket, mapPolyline, mapRoute } from '../map-line.ts';
import { createBlankDraft, libraryDraft, type StudioWorkspace } from '../mod.ts';
import { modelFamilyMark } from './brand-icons.tsx';
import {
  atRest,
  type Box,
  beside,
  drawnAt,
  type Feed,
  goneAt,
  HALF,
  INDENT,
  lineAt,
  lineKey,
  PAD,
  type Place,
  placeAt,
  type Row,
  rowId,
  settledAt,
  settling,
  treeMapLayout,
  underKey,
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
/** How far right of the feeds it passes a line between two feeds of one column runs. */
const BOW = 16;
/** How far a feed going drifts off. */
const DRIFT = 8;
/** A token's width until it is measured. */
const GUESS = 120;

const STEP_ICONS: Record<string, IconType> = {
  sanitize: IconShieldCheck,
  compaction: IconArrowsMinimize,
  stream: IconCloud,
  tools: IconRepeat,
  egress: IconShieldCheck,
  trace: IconTimeline,
  loop: IconRotateClockwise,
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
  if (feed.kind === 'vault') return IconVault;
  if (feed.kind === 'model') return IconCpu;
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

export interface StudioTreeMapProps {
  workspace: StudioWorkspace;
  /** The keys of the agents to draw, in the workspace's order; every agent when unset. */
  agents?: readonly string[] | undefined;
  /**
   * How far the tree has grown, from 0 to 1. As it grows the map grows to its size, then draws out
   * from the tree's agents as one pen would, at an even pace: each line runs out from the node it
   * leaves, and the node at its end shows as the line reaches it, drifting the last of the way along
   * it. Nothing moves before the drawing comes to it: what the map shows closed waits, clear of what
   * will show where it stands, until its line reaches it, then glides into place with its line.
   * Shrinking takes it all back the same way.
   */
  grow?: number | undefined;
  /**
   * The box the map fills grown: its rows and gaps stretch to fill it, and it stands in the middle
   * of it.
   */
  fit?: Box | undefined;
  /**
   * The box the map stands in now, when it changes as the map grows: closed and grown, the map
   * stands in the middle of it, eased smaller where it would not fit. `fit` by default.
   */
  room?: Box | undefined;
  /**
   * The keys of the agents the map shows closed, when not `agents`. Growing takes away what the
   * tree does not draw, and an agent the tree draws as an agent tool's agent glides into it.
   */
  still?: readonly string[] | undefined;
  /**
   * Where the tokens the map shows closed stand, by id, in the map's own pixels, for a map that
   * grows out of something else: closed, the map stands at its own size from the top left of what
   * holds it, these tokens where they are given and nothing else; growing, the tree draws out round
   * them, and each glides to where it stands grown as the drawing comes to it. In place of `still`.
   */
  closed?: ReadonlyMap<string, MapPlace> | undefined;
  /** A token dragged moves to where it is dropped, its lines with it; the field dragged moves the whole map. */
  draggable?: boolean | undefined;
}

type Shift = { x: number; y: number };
const NONE: Shift = { x: 0, y: 0 };

/**
 * How large the map stands, and where in `room`, this far settled: closed and grown alike it fits
 * the box it stands in, never larger than itself, in the middle of it, easing from the one to the
 * other. Closed at given places, which are its own pixels, it stands at its own size from the top left.
 */
function frameAt(
  closed: Box,
  grown: Box,
  room: Box | undefined,
  settled: number,
  given: boolean,
): { scale: number; centre: Shift } {
  const fitting = (size: Box) =>
    room ? Math.min(1, room.width / size.width, room.height / size.height) : 1;
  const middle = (size: Box) =>
    room
      ? {
          x: Math.max(0, room.width - size.width * fitting(size)) / 2,
          y: Math.max(0, room.height - size.height * fitting(size)) / 2,
        }
      : NONE;
  const closedScale = given ? 1 : fitting(closed);
  const [from, to] = [given ? NONE : middle(closed), middle(grown)];
  return {
    scale: closedScale + (fitting(grown) - closedScale) * settled,
    centre: { x: from.x + (to.x - from.x) * settled, y: from.y + (to.y - from.y) * settled },
  };
}

export function StudioTreeMap({
  workspace,
  agents,
  grow = 0,
  fit,
  room = fit,
  still,
  closed: given,
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
        still,
        given,
      ),
    [workspace, agents, widths, fitWidth, fitHeight, still, given],
  );
  const width = (id: string) => widths[id] ?? GUESS;
  const drafts = new Map(
    workspace.agents.map((agent) => [
      agent.key,
      libraryDraft(workspace, agent.key) ?? createBlankDraft(),
    ]),
  );
  const { rows, feeds, leaving } = layout;
  const gone = goneAt(grow);
  const at = (id: string) => {
    const place = placeAt(layout, id, grow);
    const by = moved[id] ?? NONE;
    return { ...place, x: place.x + by.x, y: place.y + by.y };
  };
  // why: What growing adds draws as the growing goes, and goes back as it comes back: no clock of its own.
  const drawn = (id: string) => drawnAt(layout, id, grow);
  const on = (id: string) => (drawn(id) ?? 1) > 0;
  /**
   * A line drawing runs out from its source at the drawing's pace, as a pen draws it, the loader's
   * map's way: the length of it drawn so far shows, and the rest is still to come.
   */
  const lineDrawn = (source: string, target: string) => {
    const run = lineAt(layout, source, target, grow);
    if (run <= 0) return undefined;
    if (run >= 1) return { className: 'map-line' };
    return {
      className: 'map-line',
      pathLength: 1,
      style: { strokeDasharray: 1, strokeDashoffset: 1 - run },
    };
  };
  /** A token, as solid as it has shown since the drawing reached it. */
  const tokenDrawn = (id: string) => {
    const out = drawn(id) ?? 1;
    const zIndex = atRest(layout, id, grow) ? 2 : 1;
    return { style: out < 1 ? { opacity: settling(out), zIndex } : { zIndex } };
  };
  const shown = feeds.filter((feed) => on(feed.id));

  const right = (id: string) => at(id).x + width(id);
  // why: A model wears its family's mark, the Gemini sparkle or the provider's, as the editor's tree does.
  const iconOf = (feed: Feed) =>
    (feed.kind === 'model' && feed.of !== undefined && modelFamilyMark(feed.of)) || feedIcon(feed);
  /**
   * The rail the lines from a source to feeds in its own column run down, right of it: clear of every
   * token they pass, and one for all of them, so they leave the source as one line.
   */
  const railOf = (source: string) => {
    const ends = feeds.filter((feed) => feed.from.includes(source) && beside(layout, source, feed));
    const ys = [at(source).y, ...ends.map((feed) => at(feed.id).y)];
    const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
    const column = ends[0]?.column;
    const passed = feeds
      .filter((each) => each.column === column)
      .filter((each) => at(each.id).y >= top && at(each.id).y <= bottom)
      .map((each) => right(each.id) + LINE_GAP);
    return Math.max(right(source) + LINE_GAP, ...passed) + BOW;
  };
  // why: Closed, a row's lines run down one trunk to what it shows; grown, each runs down its feed's
  // lane like the tree's, its steps aside growing out of its row.
  const square = settledAt(grow);
  const toward = (from: MapPlace, to: MapPlace, at: number) => ({
    x: from.x + (to.x - from.x) * at,
    y: from.y + (to.y - from.y) * at,
  });
  const lines = feeds.flatMap((feed) => {
    return [...feed.from, ...(feed.late ?? [])].flatMap((source) => {
      if (!on(source) || lineAt(layout, source, feed.id, grow) <= 0) return [];
      const end = at(feed.id);
      const start = { x: right(source) + LINE_GAP, y: at(source).y };
      if (beside(layout, source, feed)) {
        const into = { x: end.x + width(feed.id) + LINE_GAP, y: end.y };
        return [
          {
            key: lineKey(source, feed.id),
            d: mapBracket(start, into, railOf(source), TURN),
            target: feed.id,
            source,
          },
        ];
      }
      const lane = layout.lanes.get(lineKey(source, feed.id));
      const grownRail = lane ? at(lane.of).x - lane.by : (start.x + end.x) / 2;
      const trunk = layout.trunks.get(source);
      const steps = (layout.jogs.get(lineKey(source, feed.id)) ?? []).map((jog) => ({
        x: at(jog.lane.of).x - jog.lane.by,
        y: at(jog.near).y + (jog.side * layout.row) / 2,
      }));
      const into = { x: end.x - LINE_GAP, y: end.y };
      const d =
        trunk === undefined
          ? mapRoute(start, into, steps, grownRail, TURN, square)
          : mapRoute(
              start,
              into,
              steps.map((step) => toward(start, step, square)),
              trunk + (grownRail - trunk) * square,
              TURN,
              1,
            );
      return [{ key: lineKey(source, feed.id), d, source, target: feed.id }];
    });
  });
  const agentsOf = new Set(layout.becomes.values());
  /**
   * The line from an agent tool to the agent of the still it grows into. why: Closed, the agent
   * stands as its own in the tree, so the line leaves the tool's right, runs down right of what
   * stands between, and comes back into the agent's right; grown, it is the line from under the
   * tool's icon into the agent in its slot. Each corner eases from the one to the other.
   */
  const backPath = (holder: string, agent: string) => {
    const [tool, to] = [at(holder), at(agent)];
    const [top, bottom] = [Math.min(tool.y, to.y), Math.max(tool.y, to.y)];
    const passed = [...shown.map((feed) => feed.id), ...leaving.feeds.map((feed) => feed.id)]
      .filter((id) => at(id).y >= top && at(id).y <= bottom)
      .map((id) => right(id) + LINE_GAP);
    const rail = Math.max(right(holder) + LINE_GAP, right(agent) + LINE_GAP, ...passed) + BOW;
    const closed = [
      { x: right(holder) + LINE_GAP, y: tool.y },
      { x: rail, y: tool.y },
      { x: rail, y: (tool.y + to.y) / 2 },
      { x: rail, y: to.y },
      { x: right(agent) + LINE_GAP, y: to.y },
    ];
    const trunk = to.x - INDENT + TRUNK;
    const across = tool.y + HALF + LINE_GAP;
    const grown = [
      { x: tool.x + TRUNK, y: tool.y + HALF },
      { x: tool.x + TRUNK, y: across },
      { x: trunk, y: across },
      { x: trunk, y: to.y },
      { x: to.x - LINE_GAP, y: to.y },
    ];
    return mapPolyline(
      closed.map((point, index) => toward(point, grown[index] ?? point, square)),
      TURN,
    );
  };
  // What growing takes away goes under the rest: a row folding into its agent, a feed drifting off.
  const going = gone < 1;
  const leavingStyle = { opacity: 1 - gone, zIndex: 0 };
  const parentOf = (id: string) => layout.becomes.get(id) ?? id;
  const leavingLines = going
    ? leaving.lines.map(({ source, feed }) => {
        const end = at(feed);
        const start = { x: right(source) + LINE_GAP, y: at(source).y };
        const rail = layout.trunks.get(source) ?? (start.x + end.x) / 2;
        return {
          key: lineKey(source, feed),
          d: mapRoute(start, { x: end.x - LINE_GAP, y: end.y }, [], rail, TURN, 1),
        };
      })
    : [];
  // why: What growing takes away holds the map open until it has gone.
  const places = [
    ...rows.map(rowId),
    ...shown.map((feed) => feed.id),
    ...(going ? [...leaving.rows.map(rowId), ...leaving.feeds.map((feed) => feed.id)] : []),
  ];
  // why: An agent tool's line back to its agent runs down right of the feeds.
  const back = layout.becomes.size > 0 ? LINE_GAP + BOW : 0;
  const mapWidth = Math.max(GUESS, ...places.map(right)) + back + PAD;
  const height = Math.max(...places.map((id) => at(id).y)) + HALF + PAD;
  const grown = useMemo(() => {
    const ids = [...layout.rows.map(rowId), ...layout.feeds.map((feed) => feed.id)];
    const ends = ids.map((id) => ({ id, ...placeAt(layout, id, 1) }));
    return {
      width: Math.max(...ends.map((end) => end.x + (widths[end.id] ?? GUESS))) + PAD,
      height: Math.max(...ends.map((end) => end.y)) + HALF + PAD,
    };
  }, [layout, widths]);
  // why: The map eases to the size of the box it stands in with its nodes' move, so it never
  // outgrows it, and grows with it after.
  const closedSize = useMemo(() => {
    const ends = [...layout.closed];
    return {
      width: Math.max(...ends.map(([id, end]) => end.x + (widths[id] ?? GUESS))) + back + PAD,
      height: Math.max(...ends.map(([, end]) => end.y)) + HALF + PAD,
    };
  }, [layout, widths, back]);
  const settled = settledAt(grow);
  const { scale, centre } = frameAt(closedSize, grown, room, settled, given !== undefined);
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
  type Look = { style: CSSProperties };
  const rowToken = (row: Row, look: Look) => {
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
        {...look}
      />
    );
  };
  /** A feed's token, `drift` right of where it stands. */
  const feedToken = (feed: Feed, look: Look, drift = 0) => {
    const { x, y } = at(feed.id);
    return (
      <MapToken
        key={feed.id}
        id={feed.id}
        label={feed.label}
        icon={iconOf(feed)}
        x={x + drift}
        y={y}
        {...look}
      />
    );
  };
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
        {rows.map((row) => {
          const drawing = row.parent !== undefined && lineDrawn(row.parent, rowId(row));
          return (
            row.parent &&
            drawing && (
              <path key={rowId(row)} d={linePath(at(row.parent), at(rowId(row)))} {...drawing} />
            )
          );
        })}
        {going &&
          leaving.rows.map(
            (row) =>
              row.parent && (
                <path
                  key={rowId(row)}
                  className="map-line"
                  d={linePath(at(parentOf(row.parent)), at(rowId(row)))}
                  style={leavingStyle}
                />
              ),
          )}
        {leavingLines.map(({ key, d }) => (
          <path key={key} className="map-line" d={d} style={leavingStyle} />
        ))}
        {lines.map(({ key, d, source, target }) => {
          const drawing = lineDrawn(source, target);
          return drawing && <path key={key} d={d} {...drawing} />;
        })}
        {feeds.map((feed) => {
          const holder = feed.under;
          const drawing = holder !== undefined && on(holder) && lineDrawn(holder, feed.id);
          return (
            holder !== undefined &&
            drawing && (
              <path
                key={underKey(feed.id)}
                d={
                  agentsOf.has(feed.id)
                    ? backPath(holder, feed.id)
                    : underPath(at(holder), at(feed.id))
                }
                {...drawing}
              />
            )
          );
        })}
      </svg>
      {/* The column headings show as the map moves into its columns. */}
      {settled > 0 &&
        layout.headings.map(({ label, note, x, y }) => (
          <div
            key={label}
            className="studio-tree-map-heading"
            style={{ left: x, top: y, opacity: settled }}
          >
            <Text type="supporting" color="secondary" weight="semibold">
              {label}
            </Text>
            <Text type="supporting" color="placeholder">
              {note}
            </Text>
          </div>
        ))}
      {rows.map((row) => rowToken(row, tokenDrawn(rowId(row))))}
      {going && leaving.rows.map((row) => rowToken(row, { style: leavingStyle }))}
      {going && leaving.feeds.map((feed) => feedToken(feed, { style: leavingStyle }, DRIFT * gone))}
      {feeds.map((feed) => feedToken(feed, tokenDrawn(feed.id)))}
    </div>
  );
}
