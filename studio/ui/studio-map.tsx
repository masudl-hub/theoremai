/**
 * The map: each profile as a card of its sections, with the providers, models, shared settings and
 * tools that feed it beside it and an arrow from each to the section it feeds. It changes nothing; a
 * node or a section opens what it stands for. A node can be dragged to where it reads best, and the
 * field dragged to pan it; `Tidy` puts every node back.
 */

import { Button } from '@astryxdesign/core/Button';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { IconCloud, IconCode, IconLayoutGrid } from '@tabler/icons-react';
import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	type MapLink,
	type MapNode,
	type MapPlace,
	type MapSizes,
	mapLayout,
	mapLinkWords,
	mapNoteLines,
	type SharedEntry,
	type StudioWorkspace,
	workspaceMap,
} from '../mod.ts';
import { FACET_ICON } from './lib/facet-icons.ts';
import { type MapPlaces, readMapPlaces, writeMapPlaces } from './lib/studio-map-places.ts';
import { useProject } from './lib/studio-project.ts';
import { PROFILE_TYPE_ICON, toolTypeIcon } from './profile-editor.tsx';
import './studio-map.css';

/** A node holds its icon, its name and two lines of its note; a card's head, one; a row, a section. */
const MAP_SIZES: MapSizes = {
	node: { width: 240, height: 84 },
	card: { head: 64, row: 32, foot: 8 },
	columnGap: 112,
	rowGap: 12,
	heading: 28,
	groupGap: 24,
	padding: 24,
};

function nodeIcon({ kind, type }: MapNode): IconType {
	if (kind === 'agent' && type && Object.hasOwn(PROFILE_TYPE_ICON, type)) {
		return PROFILE_TYPE_ICON[type as keyof typeof PROFILE_TYPE_ICON];
	}
	if (kind === 'tool') return toolTypeIcon(type ?? '');
	if (kind === 'model') return FACET_ICON.modelBinding;
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

/** The box around `from` that scrolls, if one does. */
function scrollerOf(from: HTMLElement): HTMLElement | undefined {
	for (let each = from.parentElement; each; each = each.parentElement) {
		const { overflowX, overflowY } = getComputedStyle(each);
		if (/auto|scroll/.test(`${overflowX} ${overflowY}`)) return each;
	}
	return undefined;
}

/** A mouse or a pen drags; a finger scrolls the field as it always does. */
const drags = (event: ReactPointerEvent) => event.button === 0 && event.pointerType !== 'touch';

/**
 * Follow the pointer that pressed until it lifts, wherever it goes: `onMove` with how far it is
 * from where it pressed, then `onEnd`, with whether it lifted or the press was called off.
 */
function follow(
	press: ReactPointerEvent,
	onMove: (x: number, y: number) => void,
	onEnd: (lifted: boolean) => void,
): void {
	const { pointerId, clientX, clientY } = press;
	const move = (event: PointerEvent) => {
		if (event.pointerId === pointerId) onMove(event.clientX - clientX, event.clientY - clientY);
	};
	const end = (event: PointerEvent) => {
		if (event.pointerId !== pointerId) return;
		globalThis.removeEventListener('pointermove', move);
		globalThis.removeEventListener('pointerup', end);
		globalThis.removeEventListener('pointercancel', end);
		onEnd(event.type === 'pointerup');
	};
	globalThis.addEventListener('pointermove', move);
	globalThis.addEventListener('pointerup', end);
	globalThis.addEventListener('pointercancel', end);
}

export function StudioMap({
	workspace,
	shared,
	selected,
	onOpen,
}: {
	workspace: StudioWorkspace;
	shared: readonly SharedEntry[];
	/** The open node's id; its agent or tool is marked on the map. */
	selected: string;
	onOpen: (node: string) => void;
}) {
	const project = useProject()?.name;
	const map = useMemo(() => workspaceMap(workspace, shared), [workspace, shared]);
	// Where dragged nodes were put. They are kept when a drag ends, not at every step of it.
	const [moved, setMoved] = useState<MapPlaces>(() => readMapPlaces(project));
	const keep = (places: MapPlaces) => {
		setMoved(places);
		writeMapPlaces(project, places);
	};
	const layout = useMemo(() => mapLayout(map, MAP_SIZES, moved), [map, moved]);
	/** A drag just ended on this node: the click that follows it opens nothing. */
	const dropped = useRef(false);
	const [dragging, setDragging] = useState<string>();
	const [panning, setPanning] = useState(false);

	/** What makes `id`'s node draggable, and movable with Alt and the arrow keys. */
	const draggable = (id: string) => ({
		onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
			dropped.current = false;
			const from = layout.nodes[id];
			if (!from || !drags(event)) return;
			let places: MapPlaces | undefined;
			follow(
				event,
				(x, y) => {
					// A press that barely moves is a click.
					if (!places && Math.hypot(x, y) < DRAG_FROM) return;
					if (!places) setDragging(id);
					places = { ...moved, [id]: { x: Math.max(from.x + x, 0), y: Math.max(from.y + y, 0) } };
					setMoved(places);
				},
				(lifted) => {
					if (!places) return;
					dropped.current = lifted;
					// The click, if one follows, comes at once; a drop off the node leaves none to wait for.
					globalThis.setTimeout(() => {
						dropped.current = false;
					}, 0);
					setDragging(undefined);
					writeMapPlaces(project, places);
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
			keep({
				...moved,
				[id]: {
					x: Math.max(place.x + step.x * NUDGE, 0),
					y: Math.max(place.y + step.y * NUDGE, 0),
				},
			});
		},
	});

	/** A drag that starts on the field, off every node, pans it. */
	const pan = (event: ReactPointerEvent<HTMLElement>) => {
		if (!drags(event) || (event.target as Element).closest('.studio-map-node, .studio-map-card')) {
			return;
		}
		const scroller = scrollerOf(event.currentTarget);
		if (!scroller) return;
		const { scrollLeft, scrollTop } = scroller;
		setPanning(true);
		follow(
			event,
			(x, y) => {
				scroller.scrollTo({ left: scrollLeft - x, top: scrollTop - y, behavior: 'instant' });
			},
			() => {
				setPanning(false);
			},
		);
	};

	const nodes = map.columns.flat().flatMap((group) => group.nodes);
	// The node or section under the pointer or holding focus: its lines, and what they reach, stay lit.
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
	/** What lights `id` while the pointer or focus is on it. */
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

	const isMoved = nodes.some((node) => Object.hasOwn(moved, node.id));

	return (
		<div className="studio-map-frame">
			<ScrollableArea
				className="studio-map-scroll"
				axis="both"
				role="region"
				label="Map"
				height="100%"
				overscroll="allow"
			>
				<div
					className="studio-map"
					data-lit={lit === undefined || dragging !== undefined ? undefined : ''}
					data-panning={panning ? '' : undefined}
					onPointerDown={pan}
					style={
						{
							'--map-width': `${String(layout.width)}px`,
							'--map-height': `${String(layout.height)}px`,
						} as CSSProperties
					}
				>
					<svg
						className="studio-map-lines"
						width={layout.width}
						height={layout.height}
						aria-hidden="true"
					>
						{layout.lines.map(({ link, d, tip }) => (
							<g
								key={`${link.kind}:${link.from}:${link.to}`}
								data-kind={link.kind}
								data-on={onLines.has(link) ? '' : undefined}
							>
								<path className="studio-map-line" d={d} />
								<path
									className="studio-map-tip"
									d={`M ${String(tip.x)} ${String(tip.y)} l ${String(-7 * tip.heading)} -4 v 8 z`}
								/>
							</g>
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
						if (!place) return null;
						const { opens, rows = [] } = node;
						const isLit = on.has(node.id) || rows.some((row) => on.has(row.id));
						const head = (
							<>
								<Icon icon={nodeIcon(node)} size="sm" color="secondary" />
								<span className="studio-map-words">
									<Text weight="semibold" maxLines={1}>
										{node.label}
									</Text>
									{node.note && (
										<Text
											type="supporting"
											color="secondary"
											maxLines={rows.length > 0 ? 1 : mapNoteLines(node)}
										>
											{node.note}
										</Text>
									)}
								</span>
							</>
						);
						const button = {
							type: 'button' as const,
							title: node.note || undefined,
							'aria-description': mapLinkWords(map, node.id) || undefined,
							disabled: opens === undefined,
							onClick: () => {
								if (opens !== undefined) onOpen(opens);
							},
							...lights(node.id),
						};
						if (rows.length === 0) {
							return (
								<button
									key={node.id}
									{...button}
									{...draggable(node.id)}
									className="studio-map-node"
									style={{
										left: place.x,
										top: place.y,
										width: MAP_SIZES.node.width,
										height: place.height,
									}}
									aria-current={isOpen(node, selected) ? 'true' : undefined}
									data-on={isLit ? '' : undefined}
									data-dragging={dragging === node.id ? '' : undefined}
								>
									{head}
								</button>
							);
						}
						return (
							<div
								key={node.id}
								className="studio-map-card"
								style={{
									left: place.x,
									top: place.y,
									width: MAP_SIZES.node.width,
									height: place.height,
								}}
								data-open={isOpen(node, selected) ? '' : undefined}
								data-on={isLit ? '' : undefined}
								data-dragging={dragging === node.id ? '' : undefined}
								{...draggable(node.id)}
							>
								<button
									{...button}
									className="studio-map-head"
									style={{ height: MAP_SIZES.card.head }}
									aria-current={selected === node.id ? 'true' : undefined}
								>
									{head}
								</button>
								{rows.map((row) => (
									<button
										key={row.id}
										type="button"
										className="studio-map-row"
										style={{ height: MAP_SIZES.card.row }}
										aria-current={selected === row.id ? 'true' : undefined}
										data-on={on.has(row.id) ? '' : undefined}
										onClick={() => {
											onOpen(row.opens);
										}}
										{...lights(row.id)}
									>
										<Icon icon={rowIcon(row.type)} size="sm" color="secondary" />
										<Text maxLines={1}>{row.label}</Text>
										{row.note && (
											<span className="studio-map-row-note">
												<Text type="supporting" color="secondary" maxLines={1}>
													{row.note}
												</Text>
											</span>
										)}
									</button>
								))}
							</div>
						);
					})}
				</div>
			</ScrollableArea>
			{isMoved && (
				<div className="studio-map-tidy">
					<Button
						label="Tidy"
						variant="secondary"
						size="sm"
						icon={<Icon icon={IconLayoutGrid} size="sm" />}
						onClick={() => {
							keep({});
						}}
					/>
				</div>
			)}
		</div>
	);
}
