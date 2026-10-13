/**
 * The map: the providers, models, shared settings, profiles and tools as tokens in columns, with a
 * line from each to what it feeds. It changes nothing; a node opens what it stands for. `Expand`
 * shows each profile as a card of its sections and each tool with its description. A node can be
 * dragged to where it reads best, and the field dragged to pan it; `Tidy` puts every node back. A
 * right click on a node shows its family alone: what feeds it and what it feeds.
 */

import { Button } from '@astryxdesign/core/Button';
import { ContextMenu, type ContextMenuOption } from '@astryxdesign/core/ContextMenu';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import {
	IconArrowsMaximize,
	IconArrowsMinimize,
	IconCloud,
	IconCode,
	IconExternalLink,
	IconEye,
	IconFocus2,
	IconLayoutGrid,
	IconX,
} from '@tabler/icons-react';
import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	type MapLink,
	type MapNode,
	type MapPlace,
	type MapSizes,
	mapFamily,
	mapLayout,
	mapLinkWords,
	mapNoteLines,
	type SharedEntry,
	type StudioWorkspace,
	workspaceMap,
} from '../mod.ts';
import { FACET_ICON } from './lib/facet-icons.ts';
import { type KeptMap, type MapPlaces, readKeptMap, writeKeptMap } from './lib/studio-map-kept.ts';
import { useProject } from './lib/studio-project.ts';
import { PROFILE_TYPE_ICON, profileTypeIcon, toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import './studio-map.css';

/** With detail a node holds its icon, its name and two lines of its note; a card's head, one; a row, a section. */
const DETAIL_SIZES: MapSizes = {
	node: { width: 240, height: 84 },
	card: { head: 64, row: 32, foot: 8 },
	columnGap: 112,
	rowGap: 12,
	heading: 28,
	groupGap: 24,
	padding: 24,
	lineGap: 8,
};

/** A token's slot: as wide as the longest name it shows in full. */
const TOKEN_SIZES: MapSizes = {
	...DETAIL_SIZES,
	node: { width: 240, height: 24 },
	columnGap: 96,
	rowGap: 6,
	heading: 24,
	groupGap: 16,
};
const TOKEN_LABEL = 28;

/** A long name keeps its start. */
function clipped(label: string): string {
	return label.length > TOKEN_LABEL ? `${label.slice(0, TOKEN_LABEL - 1)}…` : label;
}

function nodeIcon({ kind, type }: MapNode): IconType {
	const agent = kind === 'agent' ? profileTypeIcon(type) : undefined;
	if (agent) return agent;
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
	onClose,
}: {
	workspace: StudioWorkspace;
	shared: readonly SharedEntry[];
	/** The open node's id; its agent or tool is marked on the map. */
	selected: string;
	onOpen: (node: string) => void;
	onClose: () => void;
}) {
	const project = useProject()?.name;
	const whole = useMemo(() => workspaceMap(workspace, shared), [workspace, shared]);
	const [kept, setKept] = useState<KeptMap>(() => readKeptMap(project));
	const keep = (next: KeptMap) => {
		setKept(next);
		writeKeptMap(project, next);
	};
	const { expanded } = kept;
	const family = whole.columns.flat().some((group) => group.nodes.some((node) => node.id === kept.family))
		? kept.family
		: undefined;
	const map = useMemo(() => (family === undefined ? whole : mapFamily(whole, family)), [whole, family]);
	// A family is laid out afresh from the top. Where its nodes are dragged lasts while it shows.
	const [lens, setLens] = useState<MapPlaces>({});
	const places = expanded ? 'detail' : 'tokens';
	const moved = family === undefined ? kept[places] : lens;
	/** Puts dragged nodes at `next`. They are kept when a drag ends, not at every step of it. */
	const put = (next: MapPlaces, ended: boolean) => {
		if (family !== undefined) setLens(next);
		else if (ended) keep({ ...kept, [places]: next });
		else setKept({ ...kept, [places]: next });
	};
	const showFamily = (id: string | undefined) => {
		setLens({});
		const { tokens, detail } = kept;
		keep({ tokens, detail, expanded, ...(id === undefined ? {} : { family: id }) });
	};

	const field = useRef<HTMLDivElement>(null);
	const sizes = expanded ? DETAIL_SIZES : TOKEN_SIZES;
	const widths = useTokenWidths(field, expanded ? undefined : map);
	const layout = useMemo(
		() => mapLayout(map, sizes, expanded ? { moved, detail: true } : { moved, widths }),
		[map, sizes, expanded, moved, widths],
	);
	// A family, and the map with or without detail, each start from the top left; the whole map with what is open in view.
	useEffect(() => {
		const root = field.current;
		if (!root) return;
		scrollerOf(root)?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
		if (family === undefined) {
			root.querySelector('[aria-current], [data-open]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}, [family, expanded]);
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
			put(
				{
					...moved,
					[id]: {
						x: Math.max(place.x + step.x * NUDGE, 0),
						y: Math.max(place.y + step.y * NUDGE, 0),
					},
				},
				true,
			);
		},
	});

	/** A drag that starts on the field, off every node, pans it. */
	const pan = (event: ReactPointerEvent<HTMLElement>) => {
		if (!drags(event) || (event.target as Element).closest('[data-map-node]')) {
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
	const tidy = () => {
		put({}, true);
	};
	const expand = () => {
		keep({ ...kept, expanded: !expanded });
	};
	/** The node the menu was opened on, if on one. */
	const [menuOn, setMenuOn] = useState<string>();
	const onNode = nodes.find((node) => node.id === menuOn);
	const menu: ContextMenuOption[] = [
		...(onNode && onNode.id !== family
			? [
					{
						label: 'Show only its family',
						icon: IconFocus2,
						onClick: () => {
							showFamily(onNode.id);
						},
					},
				]
			: []),
		...(onNode?.opens === undefined
			? []
			: [
					{
						label: 'Open',
						icon: IconExternalLink,
						onClick: () => {
							if (onNode.opens !== undefined) onOpen(onNode.opens);
						},
					},
				]),
		...(onNode ? [{ type: 'divider' as const }] : []),
		...(family === undefined
			? []
			: [
					{
						label: 'Show everything',
						icon: IconEye,
						onClick: () => {
							showFamily(undefined);
						},
					},
				]),
		{
			label: expanded ? 'Collapse' : 'Expand',
			icon: expanded ? IconArrowsMinimize : IconArrowsMaximize,
			onClick: expand,
		},
		{ label: 'Tidy', icon: IconLayoutGrid, isDisabled: !isMoved, onClick: tidy },
	];

	return (
		<div
			className="studio-map-frame"
			onKeyDown={(event) => {
				// Escape closes an open menu first; that one is not for the family.
				if (event.key !== 'Escape' || family === undefined) return;
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
				<ContextMenu items={menu} label="Map" data-map-field="">
					<div
						ref={field}
						className="studio-map"
						data-lit={lit === undefined || dragging !== undefined ? undefined : ''}
						data-panning={panning ? '' : undefined}
						onPointerDown={pan}
						onContextMenuCapture={(event) => {
							setMenuOn((event.target as Element).closest<HTMLElement>('[data-map-node]')?.dataset.mapNode);
						}}
						style={
							{
								'--map-width': `${String(layout.width)}px`,
								'--map-height': `${String(layout.height)}px`,
								'--map-slot': `${String(sizes.node.width)}px`,
							} as CSSProperties
						}
					>
						<svg
							className="studio-map-lines"
							width={layout.width}
							height={layout.height}
							aria-hidden="true"
						>
							{layout.lines.map(({ link, d }) => (
								<path
									key={`${link.kind}:${link.from}:${link.to}`}
									className="map-line"
									d={d}
									data-kind={link.kind}
									data-on={onLines.has(link) ? '' : undefined}
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
							if (!place) return null;
							const { opens } = node;
							const rows = node.rows ?? [];
							const isLit = on.has(node.id) || rows.some((row) => on.has(row.id));
							const open =
								opens === undefined
									? undefined
									: () => {
											onOpen(opens);
										};
							if (!expanded) {
								return (
									<MapToken
										key={node.id}
										id={node.id}
										label={clipped(node.label)}
										icon={nodeIcon(node)}
										x={place.x}
										y={place.y + place.height / 2}
										color={isOpen(node, selected) ? 'blue' : undefined}
										description={[node.note, mapLinkWords(map, node.id)].filter(Boolean).join('. ') || undefined}
										onOpen={open}
										title={node.label.length > TOKEN_LABEL ? node.label : undefined}
										data-map-node={node.id}
										aria-current={isOpen(node, selected) ? 'true' : undefined}
										data-on={isLit ? '' : undefined}
										data-dragging={dragging === node.id ? '' : undefined}
										{...lights(node.id)}
										{...draggable(node.id)}
									/>
								);
							}
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
								disabled: open === undefined,
								onClick: open,
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
											width: sizes.node.width,
											height: place.height,
										}}
										data-map-node={node.id}
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
										width: sizes.node.width,
										height: place.height,
									}}
									data-map-node={node.id}
									data-open={isOpen(node, selected) ? '' : undefined}
									data-on={isLit ? '' : undefined}
									data-dragging={dragging === node.id ? '' : undefined}
									{...draggable(node.id)}
								>
									<button
										{...button}
										className="studio-map-head"
										style={{ height: sizes.card.head }}
										aria-current={selected === node.id ? 'true' : undefined}
									>
										{head}
									</button>
									{rows.map((row) => (
										<button
											key={row.id}
											type="button"
											className="studio-map-row"
											style={{ height: sizes.card.row }}
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
				</ContextMenu>
			</ScrollableArea>
			<div className="studio-map-tools">
				{family !== undefined && (
					<Button
						label="Show everything"
						variant="secondary"
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
						variant="secondary"
						size="sm"
						icon={<Icon icon={IconLayoutGrid} size="sm" />}
						onClick={tidy}
					/>
				)}
				<IconButton
					label={expanded ? 'Collapse' : 'Expand'}
					variant="secondary"
					size="sm"
					icon={<Icon icon={expanded ? IconArrowsMinimize : IconArrowsMaximize} size="sm" />}
					tooltip={expanded ? 'Show each node as a token' : 'Show sections and descriptions'}
					onClick={expand}
				/>
				<IconButton
					label="Close map"
					variant="secondary"
					size="sm"
					icon={<Icon icon={IconX} size="sm" />}
					tooltip="Close the map"
					onClick={onClose}
				/>
			</div>
		</div>
	);
}
