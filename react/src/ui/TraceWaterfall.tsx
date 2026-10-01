import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { IconZoomOut } from '@tabler/icons-react';
import { type PointerEvent, useMemo, useRef, useState } from 'react';
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ReferenceArea,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from 'recharts';
import { type TraceBar, traceActivity, traceActor, traceBars, traceOutcome } from '../client/trace-story.ts';
import type { TraceNode } from '../client/trace-view.ts';
import { ChartFrame, ChartTip, FIRST_WIDTH_PX } from './TraceOverview.tsx';
import { TRACE_HUE } from './trace-palette.ts';
import { ACTOR_FILL, TRACE_RADIUS, type TraceFill, traceFill } from './trace-patterns.tsx';
import { useTraceFormat } from './TraceValues.tsx';

/** Slices in the activity strip. */
const BUCKETS = 120;
/** Height of one span's row, in pixels. */
const ROW_PX = 22;
/** Height of the time axis under the rows. */
const AXIS_PX = 24;
/** Height of the activity strip. */
const STRIP_PX = 36;
/** Room right of the plot, so the last tick's label fits. */
const PLOT_RIGHT_PX = 4;
/** Width of the name column, in pixels. */
const NAME_PX = 132;
/** Indent per level of nesting in the name column. */
const INDENT_PX = 8;

type Row = { id: string; bar: TraceBar; range: [number, number]; name: string };

function barHatch(node: TraceNode): TraceFill {
	return ACTOR_FILL[traceActor(node)];
}

function BarTip({ active, payload }: TooltipContentProps) {
	const format = useTraceFormat();
	const row = payload?.[0]?.payload as Row | undefined;
	if (!active || !row) return null;
	const { node, from } = row.bar;
	const outcome = traceOutcome(node);
	const cost = node.span.attributes['theorem.usage.cost_usd'];
	return (
		<ChartTip>
			<VStack gap={0}>
				<Text weight="medium">{row.name}</Text>
				<Text type="supporting" color="secondary">
					{node.meta.label}
				</Text>
				<Text type="supporting" hasTabularNumbers>
					{[
						format.duration(node.durationMs),
						format.t('@theorem.panel.trace.offset', { duration: format.duration(from) }),
						...(typeof cost === 'number' ? [format.usd(cost)] : []),
					].join(format.t('@theorem.panel.trace.separator'))}
				</Text>
				{outcome ? (
					<Text type="supporting">
						<span style={{ color: outcome.tone === 'error' ? TRACE_HUE.oxblood : 'var(--color-text-secondary)' }}>{outcome.label}</span>
					</Text>
				) : null}
			</VStack>
		</ChartTip>
	);
}

/** A row's name, from the chart's left edge, set in by its depth and cut to the column. */
function NameTick({
	y: rawY,
	payload,
	rows,
}: { y?: number | string; payload?: { value: unknown }; rows: ReadonlyMap<string, Row> }) {
	const row = typeof payload?.value === 'string' ? rows.get(payload.value) : undefined;
	const y = Number(rawY);
	if (!row || Number.isNaN(y)) return null;
	const indent = Math.min(row.bar.depth, 4) * INDENT_PX;
	const room = Math.floor((NAME_PX - indent - 10) / 6.2);
	const name = row.name.length > room ? `${row.name.slice(0, Math.max(1, room - 1))}…` : row.name;
	return (
		<text
			x={indent}
			y={y}
			dy="0.35em"
			fontSize={11}
			fill={row.bar.node.span.status.code === 'ERROR' ? TRACE_HUE.oxblood : 'var(--color-text-secondary)'}
		>
			<title>{row.name}</title>
			{name}
		</text>
	);
}

/** A time window on the turn, in ms from its start. */
type Window = { root: string; from: number; to: number };

/** How busy the model and tools were over the turn; a drag across it picks the window to zoom into. */
function ActivityStrip({ root, zoom, onZoom }: { root: TraceNode; zoom: Window | null; onZoom: (window: Window) => void }) {
	const activity = useMemo(() => traceActivity(root, BUCKETS), [root]);
	const total = Math.max(root.durationMs, 1);
	const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
	// Pointer events can outrun a render; the ref always holds the drag so far.
	const dragRef = useRef<{ from: number; to: number } | null>(null);
	const moveDrag = (next: { from: number; to: number } | null) => {
		dragRef.current = next;
		setDrag(next);
	};
	/** The time under a pointer on the strip, in ms from the turn's start. */
	const timeAt = (event: PointerEvent<HTMLDivElement>) => {
		const box = event.currentTarget.getBoundingClientRect();
		const share = (event.clientX - box.left - NAME_PX) / Math.max(box.width - NAME_PX - PLOT_RIGHT_PX, 1);
		return Math.min(Math.max(share, 0), 1) * total;
	};
	const endDrag = () => {
		const done = dragRef.current;
		if (done) {
			const from = Math.min(done.from, done.to);
			const to = Math.max(done.from, done.to);
			// A click, not a drag: leave the zoom as it was.
			if (to - from >= total / BUCKETS) onZoom({ root: root.id, from, to });
		}
		moveDrag(null);
	};
	const shown = drag ?? zoom;
	return (
		<div
			style={{ cursor: 'col-resize', userSelect: 'none', touchAction: 'none' }}
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				const value = timeAt(event);
				moveDrag({ from: value, to: value });
			}}
			onPointerMove={(event) => {
				const current = dragRef.current;
				if (current) moveDrag({ from: current.from, to: timeAt(event) });
			}}
			onPointerUp={endDrag}
			onPointerCancel={() => moveDrag(null)}
			onMouseDown={(event) => event.preventDefault()}
		>
			<ResponsiveContainer width="100%" height={STRIP_PX} initialDimension={{ width: FIRST_WIDTH_PX, height: STRIP_PX }}>
				<AreaChart data={activity} margin={{ top: 2, right: PLOT_RIGHT_PX, bottom: 0, left: NAME_PX }} accessibilityLayer={false}>
					<XAxis dataKey="at" type="number" domain={[0, total]} hide />
					<YAxis hide domain={[0, 2]} />
					<Area
						type="monotone"
						dataKey="model"
						stackId="busy"
						activeDot={false}
						stroke="none"
						fill={traceFill('clear')}
						fillOpacity={1}
						isAnimationActive={false}
					/>
					<Area
						type="monotone"
						dataKey="tools"
						stackId="busy"
						activeDot={false}
						stroke="none"
						fill={traceFill('hatch')}
						fillOpacity={1}
						isAnimationActive={false}
					/>
					{shown ? (
						<ReferenceArea
							x1={shown.from}
							x2={shown.to}
							fill="var(--color-text-primary)"
							fillOpacity={drag ? 0.12 : 0.08}
							stroke="var(--color-border-emphasized)"
						/>
					) : null}
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}

/** A bar's opacity: faded when the search passed it over, the turn itself half-strength, and the rest dimmed around a selection. */
function barOpacity(row: Row, selectedId: string | undefined, matches: ReadonlySet<string> | undefined): number {
	if (matches && !matches.has(row.id)) return 0.25;
	if (row.bar.depth === 0) return 0.45;
	return !selectedId || row.id === selectedId ? 1 : 0.5;
}

/** One bar per span over the time window, named on the left. */
function SpanBars({
	root,
	domain,
	selectedId,
	matches,
	onSelect,
}: {
	root: TraceNode;
	domain: [number, number];
	selectedId: string | undefined;
	matches: ReadonlySet<string> | undefined;
	onSelect: (node: TraceNode) => void;
}) {
	const format = useTraceFormat();
	const rows = useMemo<Row[]>(
		() =>
			traceBars(root).map((bar) => ({
				id: bar.node.id,
				bar,
				range: [bar.from, bar.to],
				name: bar.node.meta.subject ?? bar.node.meta.label,
			})),
		[root],
	);
	const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
	const height = rows.length * ROW_PX + AXIS_PX;
	return (
		<ChartFrame>
			<ResponsiveContainer width="100%" height={height} initialDimension={{ width: FIRST_WIDTH_PX, height }}>
				<BarChart
					data={rows}
					layout="vertical"
					accessibilityLayer={false}
					margin={{ top: 0, right: PLOT_RIGHT_PX, bottom: 0, left: 0 }}
					barCategoryGap={4}
					onClick={(state) => {
						const row = rows[Number(state?.activeIndex)];
						if (row) onSelect(row.bar.node);
					}}
					style={{ cursor: 'pointer' }}
				>
					<CartesianGrid horizontal={false} stroke="var(--color-border)" strokeDasharray="2 4" />
					<XAxis
						type="number"
						domain={domain}
						allowDataOverflow
						tickFormatter={(value: number) => format.duration(value)}
						tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
						axisLine={{ stroke: 'var(--color-border)' }}
						tickLine={false}
						height={AXIS_PX}
						tickCount={5}
					/>
					<YAxis
						type="category"
						dataKey="id"
						width={NAME_PX}
						axisLine={false}
						tickLine={false}
						interval={0}
						tick={(props) => <NameTick {...props} rows={byId} />}
					/>
					<Tooltip content={(props) => <BarTip {...props} />} cursor={{ fill: 'var(--color-overlay-hover)' }} isAnimationActive={false} />
					<Bar dataKey="range" minPointSize={2} radius={TRACE_RADIUS} isAnimationActive={false} style={{ cursor: 'pointer' }}>
						{rows.map((row) => (
							<Cell key={row.id} fill={traceFill(barHatch(row.bar.node))} opacity={barOpacity(row, selectedId, matches)} />
						))}
					</Bar>
				</BarChart>
			</ResponsiveContainer>
		</ChartFrame>
	);
}

/**
 * Every span of the turn on one time axis, nested by depth and coloured by
 * who acted. Above it, how busy the model and tools were over the turn; drag
 * across that strip to zoom the rows into the window, as in a performance
 * profile. A bar opens its span.
 */
export function TraceWaterfall({
	root,
	selectedId,
	matches,
	onSelect,
}: {
	root: TraceNode;
	selectedId: string | undefined;
	matches: ReadonlySet<string> | undefined;
	onSelect: (node: TraceNode) => void;
}) {
	const { t } = useTraceFormat();
	const [picked, setPicked] = useState<Window | null>(null);
	const zoom = picked?.root === root.id ? picked : null;
	return (
		<VStack gap={2}>
			<HStack gap={2} align="center" justify="between">
				<Text type="supporting" color="secondary">
					{t('@theorem.panel.trace.timeline.zoom')}
				</Text>
				{zoom ? (
					<Button
						label={t('@theorem.panel.trace.timeline.reset')}
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconZoomOut} />}
						onClick={() => setPicked(null)}
					/>
				) : null}
			</HStack>
			<ActivityStrip root={root} zoom={zoom} onZoom={setPicked} />
			<SpanBars
				root={root}
				domain={zoom ? [zoom.from, zoom.to] : [0, Math.max(root.durationMs, 1)]}
				selectedId={selectedId}
				matches={matches}
				onSelect={onSelect}
			/>
		</VStack>
	);
}
