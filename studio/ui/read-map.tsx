/**
 * The loader's map of a project being read: the setup file at the left, a line to each folder
 * its imports reach with a dot for each file read there, and the agents and tools found. It
 * draws the steps in the order they happened, no faster than can be followed.
 */
import type { IconType } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { IconBrain, IconFileCode, IconFolder } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mapCurve } from '../map-line.ts';
import type { ReadStep } from '../read-steps.ts';
import { type ReadNode, type ReadNodeKind, readMap } from './lib/read-map.ts';
import { profileTypeIcon, toolTypeIcon } from './lib/type-icons.ts';
import { MapToken, useTokenWidths } from './map-token.tsx';
import type { Reading } from './lib/read-progress.ts';
import './read-map.css';

/** The slowest the map draws: one step in this long. */
const STEP_MS = 70;
/** While steps still arrive, the map stays about this far behind them. */
const LAG_MS = 500;
/** Once the project has arrived, the rest is drawn within this long. */
const CATCH_UP_MS = 900;
/** The map shows for at least this long, so a quick read can still be seen. */
const SHOWN_MS = 2000;

/** The panel's own padding, step 4. */
const PAD = 16;
const ROW = 30;
/** Room kept for the last column's tokens and for the line of words under the map. */
const LAST_COL = 190;
const FOOT = 44;
const GAP = 8;
const DOTS = 8;
const LABEL = 30;

const NODE_ICON: Record<ReadNodeKind, IconType | undefined> = {
	entry: IconFileCode,
	folder: IconFolder,
	profile: IconBrain,
	tool: undefined,
	more: undefined,
};

/** An agent or a tool has its type's icon, the one the tree gives it. */
function nodeIcon({ kind, type }: ReadNode): IconType | undefined {
	if (kind === 'profile') return profileTypeIcon(type) ?? NODE_ICON.profile;
	if (kind === 'tool') return toolTypeIcon(type ?? '');
	return NODE_ICON[kind];
}

function isFile(step: ReadStep): step is { file: string; from?: string } {
	return 'file' in step && !('found' in step);
}

/** A long name keeps its end, which is what tells two paths apart. */
function short(label: string): string {
	return label.length > LABEL ? `…${label.slice(1 - LABEL)}` : label;
}

/** How far the map has drawn: the steps drawn, of the steps it is laid out from. */
function useDrawn(reading: Reading, onDrawn: () => void) {
	const [drawn, setDrawn] = useState({ steps: 0, known: 0 });
	const told = useRef(onDrawn);
	told.current = onDrawn;
	useEffect(() => {
		let frame = 0;
		const start = performance.now();
		let at = start;
		let cursor = 0;
		let pace: number | undefined;
		const tick = (now: number) => {
			const known = reading.steps().length;
			const left = known - cursor;
			if (reading.done()) pace ??= Math.max(1 / STEP_MS, left / Math.max(CATCH_UP_MS, SHOWN_MS - (now - start)));
			const rate = pace ?? Math.max(1 / STEP_MS, left / LAG_MS);
			cursor = Math.min(known, cursor + (now - at) * rate);
			at = now;
			const steps = Math.floor(cursor);
			setDrawn((last) => (last.steps === steps && last.known === known ? last : { steps, known }));
			if (reading.done() && cursor >= known && now - start >= SHOWN_MS) {
				told.current();
				return;
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [reading]);
	return drawn;
}

function useSize() {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ width: number; height: number }>();
	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const measure = () => setSize({ width: root.clientWidth, height: root.clientHeight });
		measure();
		const watch = new ResizeObserver(measure);
		watch.observe(root);
		return () => watch.disconnect();
	}, []);
	return { ref, size };
}

/** What the line of words under the map says of the step being drawn. */
function saying(steps: readonly ReadStep[], drawn: number): string {
	const last = steps[Math.max(0, drawn - 1)];
	if (!last) return 'Reading your project';
	if ('again' in last) return 'Your files changed. Loading the project again.';
	if (isFile(last)) return `Reading ${last.file}`;
	return drawn < steps.length ? 'Finding agents and tools' : 'Opening';
}

function counted(count: number, one: string): string | undefined {
	return count ? `${String(count)} ${one}${count === 1 ? '' : 's'}` : undefined;
}

/** What has been drawn so far, counted. */
function tally(steps: readonly ReadStep[], drawn: number): string {
	const seen = steps.slice(0, drawn);
	const found = (kind: 'profile' | 'tool') => seen.filter((step) => 'found' in step && step.found === kind).length;
	return [counted(seen.filter(isFile).length, 'file'), counted(found('profile'), 'agent'), counted(found('tool'), 'tool')]
		.filter((part) => part !== undefined)
		.join(' · ');
}

interface Placed {
	node: ReadNode;
	x: number;
	y: number;
}

/** The line from a node's right edge to the next node's left, and the dots along it. */
function lineTo(from: Placed, fromWidth: number, to: Placed, dots: number) {
	const curve = mapCurve({ x: from.x + fromWidth + GAP, y: from.y }, { x: to.x - GAP, y: to.y });
	return { d: curve.d, dots: Array.from({ length: dots }, (_, index) => curve.at((index + 1) / (dots + 1))) };
}

export interface ReadMapProps {
	reading: Reading;
	/** Called once every step is drawn and the project has arrived. */
	onDrawn: () => void;
}

export function ReadMap({ reading, onDrawn }: ReadMapProps) {
	const drawn = useDrawn(reading, onDrawn);
	const { ref, size } = useSize();
	const steps = reading.steps();
	const rows = size ? Math.floor((size.height - PAD * 2 - FOOT) / ROW) : 0;
	// Laid out from every step said so far, not only the ones drawn: drawing a node moves nothing.
	// A folder first said later does move the rows, and the tokens and lines move together.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `steps` is one list that grows; its length is what changes.
	const map = useMemo(() => readMap(steps.slice(0, drawn.known), rows), [drawn.known, rows]);

	const placed = useMemo(() => {
		if (!size) return [];
		const stride = map.cols > 1 ? (size.width - PAD * 2 - LAST_COL) / (map.cols - 1) : 0;
		return map.nodes
			.filter((node) => node.first < drawn.steps)
			.map((node): Placed => ({
				node,
				x: PAD + node.col * Math.max(stride, 0),
				y: size.height / 2 + (node.row - (map.rows - 1) / 2) * ROW,
			}));
	}, [map, size, drawn.steps]);

	const widths = useTokenWidths(ref, placed);

	const byId = new Map(placed.map((each) => [each.node.id, each]));
	return (
		<div ref={ref} className="read-map" aria-hidden="true">
			<svg className="read-map-lines" width={size?.width ?? 0} height={size?.height ?? 0}>
				{placed.map((to) => {
					const from = to.node.parent === undefined ? undefined : byId.get(to.node.parent);
					const width = from && widths[from.node.id];
					if (!from || width === undefined) return null;
					const read = to.node.own.filter((step) => step < drawn.steps).length;
					const dots = Math.ceil((Math.min(DOTS, to.node.own.length) * read) / Math.max(1, to.node.own.length));
					const line = lineTo(from, width, to, Math.min(DOTS, to.node.own.length));
					return (
						<g key={to.node.id}>
							<path className="map-line read-map-line" d={line.d} pathLength={1} />
							{line.dots.slice(0, dots).map(({ x, y }, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a dot is its place along the line.
								<circle key={index} className="read-map-dot" cx={x} cy={y} r={2.5} />
							))}
						</g>
					);
				})}
			</svg>
			{placed.map(({ node, x, y }) => (
				<MapToken key={node.id} className="read-map-node" id={node.id} label={short(node.label)} icon={nodeIcon(node)} x={x} y={y} />
			))}
			<div className="read-map-foot">
				<Text type="supporting" color="secondary" maxLines={1}>
					{saying(steps, drawn.steps)}
				</Text>
				<Text type="supporting" color="secondary" maxLines={1}>
					{tally(steps, drawn.steps)}
				</Text>
			</div>
		</div>
	);
}
