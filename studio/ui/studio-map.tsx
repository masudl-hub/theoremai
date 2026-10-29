/**
 * The map: the providers, models, shared settings, profiles, and tools as tokens in columns, with a
 * line from each to what it feeds. It changes nothing; a node opens what it stands for. `Expand`
 * shows each profile as a card of its sections and each tool with its description. A node can be
 * dragged to where it reads best, and the field dragged to pan it; `Tidy` puts every node back. A
 * right click on a node shows its family alone: what feeds it and what it feeds. A search shows the
 * family of every node it finds.
 */

import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { ContextMenu, type ContextMenuOption } from '@astryxdesign/core/ContextMenu';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconCloud,
  IconCode,
  IconExternalLink,
  IconEye,
  IconFocus2,
  IconLayoutGrid,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type MapLayout,
  type MapLink,
  type MapNode,
  type MapPlace,
  type MapSizes,
  mapFamily,
  mapFound,
  mapLayout,
  mapLinkWords,
  mapNoteLines,
  type SharedEntry,
  type StudioWorkspace,
  type WorkspaceMap,
  workspaceMap,
} from '../mod.ts';
import { modelFamilyMark } from './brand-icons.tsx';
import { FACET_ICON } from './lib/facet-icons.ts';
import { type KeptMap, type MapPlaces, readKeptMap, writeKeptMap } from './lib/studio-map-kept.ts';
import { useProject } from './lib/studio-project.ts';
import { PROFILE_TYPE_ICON, profileTypeIcon, toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import { drags, fieldStart, follow, scrollOnce, usePan } from './pan.ts';
import './studio-map.css';

/** A token's slot: as wide as the longest name it shows in full. */
const TOKEN_SIZES: MapSizes = {
  node: { width: 240, height: 24 },
  card: { head: 60, row: 28, foot: 4 },
  columnGap: 96,
  rowGap: 6,
  heading: 24,
  groupGap: 16,
  padding: 24,
  lineGap: 8,
};

/** With detail a node is its token grown to hold its note: the same slot and the same gaps. */
const DETAIL_SIZES: MapSizes = { ...TOKEN_SIZES, node: { width: 240, height: 84 } };
const TOKEN_LABEL = 28;

/** A long name keeps its start. */
function clipped(label: string): string {
  return label.length > TOKEN_LABEL ? `${label.slice(0, TOKEN_LABEL - 1)}…` : label;
}

function nodeIcon({ kind, type, note }: MapNode): IconType {
  const agent = kind === 'agent' ? profileTypeIcon(type) : undefined;
  if (agent) return agent;
  if (kind === 'tool') return toolTypeIcon(type ?? '');
  // A model's note is its API model id, which names the family.
  if (kind === 'model') return modelFamilyMark(note) ?? FACET_ICON.modelBinding;
  if (kind === 'provider') return IconCloud;
  if (kind === 'shared' && type && Object.hasOwn(FACET_ICON, type)) {
    return FACET_ICON[type as keyof typeof FACET_ICON];
  }
  return kind === 'agent' ? PROFILE_TYPE_ICON.text : IconCode;
}

function rowIcon(type: string): IconType {
  return Object.hasOwn(FACET_ICON, type) ? FACET_ICON[type as keyof typeof FACET_ICON] : IconCode;
}

/** Whether `selected`, the open node, is `node` or a section under it. */
function isOpen(node: MapNode, selected: string): boolean {
  if (node.kind === 'agent') return selected === node.id || selected.startsWith(`${node.id}/`);
  if (node.kind === 'model') return node.holds?.includes(selected) ?? false;
  return node.kind === 'tool' && selected === node.id;
}

/** How far the pointer goes before a press is a drag, and how far an arrow key moves a node. */
const DRAG_FROM = 4;
const NUDGE = 24;

const ARROWS: Record<string, MapPlace> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** How the map was left, and what it shows for it: every node, or one node's family. */
function useKept(whole: WorkspaceMap) {
  const project = useProject()?.name;
  const [kept, setKept] = useState<KeptMap>(() => readKeptMap(project));
  const keep = (next: KeptMap) => {
    setKept(next);
    writeKeptMap(project, next);
  };
  const { expanded } = kept;
  const known = whole.columns
    .flat()
    .some((group) => group.nodes.some((node) => node.id === kept.family));
  const family = known ? kept.family : undefined;
  const map = useMemo(
    () => (family === undefined ? whole : mapFamily(whole, family)),
    [whole, family],
  );
  // A family is laid out afresh from the top. Where its nodes are dragged lasts while it shows.
  const [lens, setLens] = useState<MapPlaces>({});
  const places = expanded ? 'detail' : 'tokens';
  return {
    expanded,
    family,
    map,
    moved: family === undefined ? kept[places] : lens,
    /** Puts dragged nodes at `next`. They are kept when a drag ends, not at every step of it. */
    put(next: MapPlaces, ended: boolean) {
      if (family !== undefined) setLens(next);
      else if (ended) keep({ ...kept, [places]: next });
      else setKept({ ...kept, [places]: next });
    },
    showFamily(id: string | undefined) {
      setLens({});
      const { tokens, detail } = kept;
      keep({ tokens, detail, expanded, ...(id === undefined ? {} : { family: id }) });
    },
    expand() {
      keep({ ...kept, expanded: !expanded });
    },
  };
}

type Put = (next: MapPlaces, ended: boolean) => void;

/** What makes a node draggable, and movable with Alt and the arrow keys. */
function useDrag(layout: MapLayout, moved: MapPlaces, put: Put) {
  /** A drag just ended on this node: the click that follows it opens nothing. */
  const dropped = useRef(false);
  const [dragging, setDragging] = useState<string>();
  const draggable = (id: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      dropped.current = false;
      const from = layout.nodes[id];
      if (!from || !drags(event)) return;
      let next: MapPlaces | undefined;
      follow(
        event,
        (x, y) => {
          // A press that barely moves is a click.
          if (!next && Math.hypot(x, y) < DRAG_FROM) return;
          if (!next) setDragging(id);
          next = { ...moved, [id]: { x: Math.max(from.x + x, 0), y: Math.max(from.y + y, 0) } };
          put(next, false);
        },
        (lifted) => {
          if (!next) return;
          dropped.current = lifted;
          // The click, if one follows, comes at once; a drop off the node leaves none to wait for.
          globalThis.setTimeout(() => {
            dropped.current = false;
          }, 0);
          setDragging(undefined);
          put(next, true);
        },
      );
    },
    onClickCapture: (event: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (!dropped.current) return;
      dropped.current = false;
      event.stopPropagation();
      event.preventDefault();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.altKey ? ARROWS[event.key] : undefined;
      const place = layout.nodes[id];
      if (!step || !place) return;
      event.preventDefault();
      const x = Math.max(place.x + step.x * NUDGE, 0);
      const y = Math.max(place.y + step.y * NUDGE, 0);
      put({ ...moved, [id]: { x, y } }, true);
    },
  });
  return { dragging, draggable };
}

/** The node or section under the pointer or holding focus: its lines, and what they reach, stay lit. */
function useLit(layout: MapLayout) {
  const [lit, setLit] = useState<string>();
  const [on, onLines] = useMemo(() => {
    const ids = new Set<string>();
    const lines = new Set<MapLink>();
    if (lit === undefined) return [ids, lines];
    ids.add(lit);
    for (const { link, from, to } of layout.lines) {
      if (![link.from, link.to, from, to].includes(lit)) continue;
      lines.add(link);
      for (const id of [link.from, link.to, from, to]) ids.add(id);
    }
    return [ids, lines];
  }, [layout, lit]);
  const lights = (id: string) => ({
    onPointerEnter: () => {
      setLit(id);
    },
    onPointerLeave: () => {
      setLit(undefined);
    },
    onFocus: () => {
      setLit(id);
    },
    onBlur: () => {
      setLit(undefined);
    },
  });
  return { lit, on, onLines, lights };
}

/**
 * A family starts from the top left. The map, opened or turned to or from detail, centres the node
 * that is open, or starts from the top left when none is.
 */
function useStart(
  field: RefObject<HTMLDivElement | null>,
  family: string | undefined,
  open: { place: MapLayout['nodes'][string] | undefined; sizes: MapSizes },
) {
  const latest = useRef(open.place);
  latest.current = open.place;
  // invariant: the sizes are one of two constants, so they change exactly when the detail does.
  const { sizes } = open;
  // why: Not on a click: the node clicked is already in view, and the map stays where the reader put it.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    const place = latest.current;
    const at = family === undefined ? place : undefined;
    // The field starts past the room around it.
    return scrollOnce(node, (scroller) => {
      const { left, top } = fieldStart(node, scroller);
      if (at === undefined) return { left, top };
      return {
        left: left + at.x + sizes.node.width / 2 - scroller.clientWidth / 2,
        top: top + at.y + at.height / 2 - scroller.clientHeight / 2,
      };
    });
  }, [field, family, sizes]);
}

interface MapActions {
  family: string | undefined;
  expanded: boolean;
  isMoved: boolean;
  showFamily: (id: string | undefined) => void;
  expand: () => void;
  tidy: () => void;
}

/** What a right click offers: on a node, its family and what it opens; anywhere, the field's own. */
function menuOf(
  onNode: MapNode | undefined,
  onOpen: (node: string) => void,
  actions: MapActions,
): ContextMenuOption[] {
  const { family, expanded, isMoved, showFamily, expand, tidy } = actions;
  const forNode: ContextMenuOption[] = [];
  if (onNode && onNode.id !== family) {
    forNode.push({
      label: 'Show only its family',
      icon: IconFocus2,
      onClick: () => {
        showFamily(onNode.id);
      },
    });
  }
  const opens = onNode?.opens;
  if (opens !== undefined) {
    forNode.push({
      label: 'Open',
      icon: IconExternalLink,
      onClick: () => {
        onOpen(opens);
      },
    });
  }
  if (onNode) forNode.push({ type: 'divider' });
  const everything: ContextMenuOption = {
    label: 'Show everything',
    icon: IconEye,
    onClick: () => {
      showFamily(undefined);
    },
  };
  return [
    ...forNode,
    ...(family === undefined ? [] : [everything]),
    {
      label: expanded ? 'Collapse' : 'Expand',
      icon: expanded ? IconArrowsMinimize : IconArrowsMaximize,
      onClick: expand,
    },
    { label: 'Tidy', icon: IconLayoutGrid, isDisabled: !isMoved, onClick: tidy },
  ];
}

/** Over the field's corner: the search, what the right click offers, and Close. */
function MapTools({
  actions,
  query,
  onQuery,
  onClose,
}: {
  actions: MapActions;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
}) {
  const { family, expanded, isMoved, showFamily, expand, tidy } = actions;
  return (
    <div className="studio-map-tools">
      <TextInput
        label="Search the map"
        isLabelHidden
        size="sm"
        width={200}
        placeholder="Search"
        startIcon={IconSearch}
        hasClear
        value={query}
        onChange={onQuery}
      />
      {family !== undefined && (
        <Button
          label="Show everything"
          variant="ghost"
          size="sm"
          icon={<Icon icon={IconEye} size="sm" />}
          onClick={() => {
            showFamily(undefined);
          }}
        />
      )}
      {isMoved && (
        <Button
          label="Tidy"
          variant="ghost"
          size="sm"
          icon={<Icon icon={IconLayoutGrid} size="sm" />}
          onClick={tidy}
        />
      )}
      <IconButton
        label={expanded ? 'Collapse' : 'Expand'}
        variant="ghost"
        size="sm"
        icon={<Icon icon={expanded ? IconArrowsMinimize : IconArrowsMaximize} size="sm" />}
        tooltip={expanded ? 'Show each node as a token' : 'Show sections and descriptions'}
        onClick={expand}
      />
      <IconButton
        label="Close map"
        variant="ghost"
        size="sm"
        icon={<Icon icon={IconX} size="sm" />}
        tooltip="Close the map"
        onClick={onClose}
      />
    </div>
  );
}

interface NodeProps {
  node: MapNode;
  place: MapLayout['nodes'][string];
  /** What joins the node to the rest, in words. */
  joins: string;
  selected: string;
  on: ReadonlySet<string>;
  /** A search found it. */
  isFound: boolean;
  isDragging: boolean;
  onOpen: (node: string) => void;
  lights: ReturnType<typeof useLit>['lights'];
  drag: ReturnType<ReturnType<typeof useDrag>['draggable']>;
}

/** What marks a node on the field, whichever way it is drawn. */
function marks({ node, on, isFound, isDragging }: NodeProps) {
  const isLit = on.has(node.id) || (node.rows ?? []).some((row) => on.has(row.id));
  return {
    'data-map-node': node.id,
    'data-on': isLit ? '' : undefined,
    'data-found': isFound ? '' : undefined,
    'data-dragging': isDragging ? '' : undefined,
  };
}

function TokenNode(props: NodeProps) {
  const { node, place, joins, selected, onOpen, lights, drag } = props;
  const { opens } = node;
  const open = isOpen(node, selected);
  return (
    <MapToken
      id={node.id}
      label={clipped(node.long ?? node.label)}
      icon={nodeIcon(node)}
      x={place.x}
      y={place.y + place.height / 2}
      color={open ? 'blue' : undefined}
      description={[node.note, joins].filter(Boolean).join('. ') || undefined}
      onOpen={
        opens === undefined
          ? undefined
          : () => {
              onOpen(opens);
            }
      }
      title={(node.long ?? node.label).length > TOKEN_LABEL ? (node.long ?? node.label) : undefined}
      aria-current={open ? 'true' : undefined}
      {...marks(props)}
      {...lights(node.id)}
      {...drag}
    />
  );
}

/** With detail: a node's icon, name and note, and under a profile's a row for each section. */
function DetailNode(props: NodeProps) {
  const { node, place, joins, selected, on, onOpen, lights, drag } = props;
  const { opens } = node;
  const rows = node.rows ?? [];
  const box = { left: place.x, top: place.y, height: place.height };
  const head = (
    <>
      <span className="studio-map-name">
        <Icon icon={nodeIcon(node)} size="sm" />
        <Text
          type="supporting"
          color="inherit"
          weight="medium"
          maxLines={1}
          hasTruncateTooltip={false}
        >
          {node.label}
        </Text>
      </span>
      {node.note && (
        <Text
          type="supporting"
          maxLines={rows.length > 0 ? 1 : mapNoteLines(node)}
          hasTruncateTooltip={false}
          className="studio-map-note"
        >
          {node.note}
        </Text>
      )}
    </>
  );
  const button = {
    type: 'button' as const,
    title: node.note || undefined,
    'aria-description': joins || undefined,
    disabled: opens === undefined,
    onClick: () => {
      if (opens !== undefined) onOpen(opens);
    },
    ...lights(node.id),
  };
  if (rows.length === 0) {
    return (
      <button
        {...button}
        {...drag}
        {...marks(props)}
        className="studio-map-node"
        data-map-token={node.id}
        style={box}
        aria-current={isOpen(node, selected) ? 'true' : undefined}
      >
        {head}
      </button>
    );
  }
  return (
    <div
      className="studio-map-card"
      data-map-token={node.id}
      style={box}
      data-open={isOpen(node, selected) ? '' : undefined}
      {...marks(props)}
      {...drag}
    >
      <button
        {...button}
        className="studio-map-head"
        aria-current={selected === node.id ? 'true' : undefined}
      >
        {head}
      </button>
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="studio-map-row"
          aria-current={selected === row.id ? 'true' : undefined}
          data-on={on.has(row.id) ? '' : undefined}
          onClick={() => {
            onOpen(row.opens);
          }}
          {...lights(row.id)}
        >
          <Icon icon={rowIcon(row.type)} size="sm" />
          <Text
            type="supporting"
            color="inherit"
            weight="medium"
            maxLines={1}
            hasTruncateTooltip={false}
          >
            {row.label}
          </Text>
          {row.note && (
            <Text
              type="supporting"
              maxLines={1}
              justify="end"
              hasTruncateTooltip={false}
              className="studio-map-row-note"
            >
              {row.note}
            </Text>
          )}
        </button>
      ))}
    </div>
  );
}

export function StudioMap({
  workspace,
  shared,
  selected,
  onOpen,
  onClose,
}: {
  workspace: StudioWorkspace;
  shared: readonly SharedEntry[];
  /** The open node's id; its agent or tool is marked on the map. */
  selected: string;
  onOpen: (node: string) => void;
  onClose: () => void;
}) {
  const whole = useMemo(() => workspaceMap(workspace, shared), [workspace, shared]);
  const { expanded, family, map: kept, moved, put, showFamily, expand } = useKept(whole);
  const [query, setQuery] = useState('');
  const found = useMemo(() => mapFound(kept, query), [kept, query]);
  const map = useMemo(
    () => (query.trim() === '' ? kept : mapFamily(kept, found)),
    [kept, query, found],
  );
  const isNothing = query.trim() !== '' && found.length === 0;
  const field = useRef<HTMLDivElement>(null);
  const sizes = expanded ? DETAIL_SIZES : TOKEN_SIZES;
  const drawn = useMemo(() => ({ map, expanded }), [map, expanded]);
  const widths = useTokenWidths(field, drawn);
  const layout = useMemo(
    () => mapLayout(map, sizes, { moved, widths, detail: expanded }),
    [map, sizes, expanded, moved, widths],
  );
  const nodes = map.columns.flat().flatMap((group) => group.nodes);
  const opened = nodes.find((node) => isOpen(node, selected))?.id;
  useStart(field, family, {
    place: opened === undefined ? undefined : layout.nodes[opened],
    sizes,
  });
  const { dragging, draggable } = useDrag(layout, moved, put);
  const { panning, pan } = usePan('[data-map-node]');
  const { lit, on, onLines, lights } = useLit(layout);

  const actions: MapActions = {
    family,
    expanded,
    isMoved: nodes.some((node) => Object.hasOwn(moved, node.id)),
    showFamily,
    expand,
    tidy: () => {
      put({}, true);
    },
  };
  /** The node the menu was opened on, if on one. */
  const [menuOn, setMenuOn] = useState<string>();
  const menu = menuOf(
    nodes.find((node) => node.id === menuOn),
    onOpen,
    actions,
  );
  const Node = expanded ? DetailNode : TokenNode;
  // The open node's lines are drawn over the rest, and the lit ones over those.
  const over = (line: MapLayout['lines'][number]) =>
    onLines.has(line.link) ? 2 : line.from === opened || line.to === opened ? 1 : 0;
  const lines = [...layout.lines].sort((a, b) => over(a) - over(b));

  return (
    <div
      className="studio-map-frame"
      // why: the frame only wraps the map; Escape from anywhere inside it leaves the family.
      role="none"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || family === undefined) return;
        // Escape closes an open menu first; that one is not for the family.
        if ((event.target as Element).closest('[role="menu"]')) return;
        event.stopPropagation();
        showFamily(undefined);
      }}
    >
      <ScrollableArea
        className="studio-map-scroll"
        axis="both"
        role="region"
        label="Map"
        height="100%"
        overscroll="allow"
      >
        <ContextMenu items={menu} label="Map actions" data-map-field="">
          <div
            ref={field}
            className="studio-map"
            data-lit={lit === undefined || dragging !== undefined ? undefined : ''}
            data-panning={panning ? '' : undefined}
            onPointerDown={pan}
            onContextMenuCapture={(event) => {
              setMenuOn(
                (event.target as Element).closest<HTMLElement>('[data-map-node]')?.dataset.mapNode,
              );
            }}
            style={
              {
                '--map-width': `${String(layout.width)}px`,
                '--map-height': `${String(layout.height)}px`,
                '--map-slot': `${String(sizes.node.width)}px`,
                '--map-line': `${String(sizes.card.row)}px`,
              } as CSSProperties
            }
          >
            <svg
              className="studio-map-lines"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {lines.map(({ link, from, to, d }) => (
                <path
                  key={`${link.kind}:${link.from}:${link.to}`}
                  className="map-line"
                  d={d}
                  data-kind={link.kind}
                  data-on={onLines.has(link) ? '' : undefined}
                  data-open={from === opened || to === opened ? '' : undefined}
                />
              ))}
            </svg>
            {layout.headings.map(({ label, x, y }) => (
              <div key={label} className="studio-map-heading" style={{ left: x, top: y }}>
                <Text type="supporting" color="secondary" weight="semibold">
                  {label}
                </Text>
              </div>
            ))}
            {nodes.map((node) => {
              const place = layout.nodes[node.id];
              return (
                place && (
                  <Node
                    key={node.id}
                    node={node}
                    place={place}
                    joins={mapLinkWords(map, node.id)}
                    selected={selected}
                    on={on}
                    isFound={found.includes(node.id)}
                    isDragging={dragging === node.id}
                    onOpen={onOpen}
                    lights={lights}
                    drag={draggable(node.id)}
                  />
                )
              );
            })}
          </div>
        </ContextMenu>
      </ScrollableArea>
      {isNothing && (
        <Center className="studio-map-nothing">
          <EmptyState
            headingLevel={2}
            icon={<Icon icon={IconSearch} size="lg" />}
            title="Nothing matches"
          />
        </Center>
      )}
      <MapTools actions={actions} query={query} onQuery={setQuery} onClose={onClose} />
    </div>
  );
}
