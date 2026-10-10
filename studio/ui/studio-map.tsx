/**
 * The map: the workspace's shared settings, models, agents and tools in columns, with a line for
 * everything that joins two of them. It changes nothing; a node opens what it stands for.
 */

import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Text } from '@astryxdesign/core/Text';
import { IconCode } from '@tabler/icons-react';
import { type CSSProperties, useMemo, useState } from 'react';
import {
	type MapNode,
	type MapSizes,
	mapLayout,
	mapLinkWords,
	mapNeighbours,
	type SharedEntry,
	type StudioWorkspace,
	workspaceMap,
} from '../mod.ts';
import { FACET_ICON } from './lib/facet-icons.ts';
import { PROFILE_TYPE_ICON, toolTypeIcon } from './profile-editor.tsx';
import './studio-map.css';

/** A node holds its icon, its name and two lines of its note. */
const MAP_SIZES: MapSizes = {
	node: { width: 240, height: 96 },
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
	if (kind === 'shared' && type && Object.hasOwn(FACET_ICON, type)) {
		return FACET_ICON[type as keyof typeof FACET_ICON];
	}
	return kind === 'agent' ? PROFILE_TYPE_ICON.text : IconCode;
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
	// The node under the pointer or holding focus: it and what it is joined to stay lit.
	const [lit, setLit] = useState<string>();
	const near = useMemo(() => (lit === undefined ? undefined : mapNeighbours(map, lit)), [map, lit]);
	const nodes = map.columns.flat().flatMap((group) => group.nodes);

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
							data-on={lit === link.from || lit === link.to ? '' : undefined}
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
					return (
						<button
							key={node.id}
							type="button"
							className="studio-map-node"
							style={{ left: place.x, top: place.y, ...MAP_SIZES.node }}
							title={node.note || undefined}
							aria-description={mapLinkWords(map, node.id) || undefined}
							aria-current={isOpen(node, selected) ? 'true' : undefined}
							data-on={near?.has(node.id) ? '' : undefined}
							disabled={opens === undefined}
							onClick={() => {
								if (opens !== undefined) onOpen(opens);
							}}
							onPointerEnter={() => {
								setLit(node.id);
							}}
							onPointerLeave={() => {
								setLit(undefined);
							}}
							onFocus={() => {
								setLit(node.id);
							}}
							onBlur={() => {
								setLit(undefined);
							}}
						>
							<Icon icon={nodeIcon(node)} size="sm" color="secondary" />
							<span className="studio-map-words">
								<Text weight="semibold" maxLines={1}>
									{node.label}
								</Text>
								{node.note && (
									<Text type="supporting" color="secondary" maxLines={2}>
										{node.note}
									</Text>
								)}
							</span>
						</button>
					);
				})}
			</div>
		</ScrollableArea>
	);
}
