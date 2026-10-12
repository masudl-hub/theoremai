/**
 * The loader's map of a project being read: the setup file at the left, a line to each folder
 * its imports reach with a dot for each file read there, and the agents and tools found. It
 * draws the steps in the order they happened, no faster than can be followed.
 */
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { IconFileCode, IconFolder, IconRobot, IconTool } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReadStep } from '../read-steps.ts';
import { type ReadNode, type ReadNodeKind, readMap } from './lib/read-map.ts';
import type { Reading } from './lib/read-progress.ts';
import './read-map.css';

/** The slowest the map draws: one step in this long. */
const STEP_MS = 70;
/** While steps still arrive, the map stays about this far behind them. */
const LAG_MS = 500;
/** Once the project has arrived, the rest is drawn within this long. */
const CATCH_UP_MS = 900;

const PAD = 24;
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
	profile: IconRobot,
	tool: IconTool,
	more: undefined,
};

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
		let at = performance.now();
		let cursor = 0;
		let pace: number | undefined;
		const tick = (now: number) => {
			const known = reading.steps().length;
			const left = known - cursor;
			if (reading.done()) pace ??= Math.max(1 / STEP_MS, left / CATCH_UP_MS);
			const rate = pace ?? Math.max(1 / STEP_MS, left / LAG_MS);
			cursor = Math.min(known, cursor + (now - at) * rate);
			at = now;
			const steps = Math.floor(cursor);
			setDrawn((last) => (last.steps === steps && last.known === known ? last : { steps, known }));
			if (reading.done() && cursor >= known) {
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

/** The curve from a node's right edge to the next node's left, and the dots along it. */
function lineTo(from: Placed, fromWidth: number, to: Placed, dots: number) {
	const [x0, x1] = [from.x + fromWidth + GAP, to.x - GAP];
	const mid = (x0 + x1) / 2;
	const d = `M ${String(x0)} ${String(from.y)} C ${String(mid)} ${String(from.y)}, ${String(mid)} ${String(to.y)}, ${String(x1)} ${String(to.y)}`;
	const at = (t: number): [number, number] => {
		const u = 1 - t;
		const x = u ** 3 * x0 + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * x1;
		const y = u ** 3 * from.y + 3 * u * u * t * from.y + 3 * u * t * t * to.y + t ** 3 * to.y;
		return [x, y];
	};
	return { d, dots: Array.from({ length: dots }, (_, index) => at((index + 1) / (dots + 1))) };
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
	const [widths, setWidths] = useState<Record<string, number>>({});

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

	useLayoutEffect(() => {
		const root = ref.current;
		if (!root) return;
		const next: Record<string, number> = {};
		for (const each of root.querySelectorAll<HTMLElement>('[data-read-node]')) {
			next[each.dataset.readNode ?? ''] = each.offsetWidth;
		}
		setWidths((last) =>
			Object.keys(next).length === Object.keys(last).length && Object.entries(next).every(([id, width]) => last[id] === width)
				? last
				: next,
		);
	}, [placed, ref]);

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
							<path className="read-map-line" d={line.d} pathLength={1} />
							{line.dots.slice(0, dots).map(([x, y], index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a dot is its place along the line.
								<circle key={index} className="read-map-dot" cx={x} cy={y} r={2.5} />
							))}
						</g>
					);
				})}
			</svg>
			{placed.map(({ node, x, y }) => {
				const icon = NODE_ICON[node.kind];
				return (
					<div key={node.id} className="read-map-node" data-read-node={node.id} data-kind={node.kind} style={{ left: x, top: y }}>
						<Token size="sm" label={short(node.label)} icon={icon && <Icon icon={icon} size="sm" />} />
					</div>
				);
			})}
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
