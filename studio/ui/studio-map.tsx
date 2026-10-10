/**
 * The map: each profile as a card of its sections, with the providers, models, shared settings and
 * tools that feed it beside it and a line from each to the section it feeds. It changes nothing; a
 * node or a section opens what it stands for.
 */

import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { IconCloud, IconCode } from '@tabler/icons-react';
import { type CSSProperties, useMemo, useState } from 'react';
import {
	type MapLink,
	type MapNode,
	type MapSizes,
	mapLayout,
	mapLinkWords,
	type SharedEntry,
	type StudioWorkspace,
	workspaceMap,
} from '../mod.ts';
import { FACET_ICON } from './lib/facet-icons.ts';
import { PROFILE_TYPE_ICON, toolTypeIcon } from './profile-editor.tsx';
import './studio-map.css';

/** A node holds its icon, its name and a line of its note, as a card's head does; a row, a section. */
const MAP_SIZES: MapSizes = {
	node: { width: 240, height: 64 },
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
	const map = useMemo(() => workspaceMap(workspace, shared), [workspace, shared]);
	const layout = useMemo(() => mapLayout(map, MAP_SIZES), [map]);
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

	return (
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
				data-lit={lit === undefined ? undefined : ''}
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
					{layout.lines.map(({ link, d }) => (
						<path
							key={`${link.kind}:${link.from}:${link.to}`}
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
									<Text type="supporting" color="secondary" maxLines={1}>
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
								className="studio-map-node"
								style={{ left: place.x, top: place.y, ...MAP_SIZES.node }}
								aria-current={isOpen(node, selected) ? 'true' : undefined}
								data-on={isLit ? '' : undefined}
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
	);
}
