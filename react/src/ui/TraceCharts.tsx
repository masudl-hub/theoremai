import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { type ReactNode, useMemo } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, type TooltipContentProps, XAxis, YAxis } from 'recharts';
import { isCallTrace, type TraceTimeSplit, type TraceTurn, traceActor } from '../client/trace-story.ts';
import { type TraceNode, traceSpans } from '../client/trace-view.ts';
import { ChartFrame, ChartTip, FIRST_WIDTH_PX } from './TraceOverview.tsx';
import { ACTOR_FILL, ChartCard, TRACE_GAP, TRACE_RADIUS, type TraceFill, TraceSwatch, traceFill } from './trace-patterns.tsx';
import { useTraceFormat } from './TraceValues.tsx';

/** Height of each column chart's plot, in pixels. */
const CHART_PX = 120;
/** Height of a share bar, in pixels. */
const SHARE_PX = 12;
/** Height of one row of the slowest-steps chart, in pixels. */
const SLOW_ROW_PX = 22;
/** Most steps the slowest-steps chart ranks. */
const SLOWEST = 5;
const TICK = { fill: 'var(--color-text-secondary)', fontSize: 11 } as const;
/** Every bar: rounded, and parted from its neighbours by the card's background. */
const BAR = { radius: TRACE_RADIUS, stroke: TRACE_GAP, strokeWidth: 2, isAnimationActive: false } as const;

const MODEL_CALLS: ReadonlySet<string> = new Set(['call', 'response']);
const SPLIT_KEYS = ['model', 'tools', 'guardrails', 'hooks', 'other'] as const;
const SPLIT_FILL: Readonly<Record<(typeof SPLIT_KEYS)[number], TraceFill>> = {
	model: 'clear',
	tools: 'hatch',
	guardrails: 'shade1',
	hooks: 'shade3',
	other: 'shade2',
};
const TOKEN_KEYS = ['fresh', 'cached', 'output'] as const;
const TOKEN_FILL: Readonly<Record<(typeof TOKEN_KEYS)[number], TraceFill>> = { fresh: 'clear', cached: 'hatch', output: 'shade1' };

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(undefined, { style: 'percent' });

function numberAt(node: TraceNode, key: string): number | undefined {
	const value = node.span.attributes[key];
	return typeof value === 'number' ? value : undefined;
}

/** A turn's model calls, in the order they started. */
function modelCalls(root: TraceNode): TraceNode[] {
	return traceSpans([root])
		.filter((node) => MODEL_CALLS.has(node.meta.type))
		.sort((a, b) => a.startMs - b.startMs);
}

/** A chart's key: each series' swatch and name, with its total at the end. */
function Legend({ items }: { items: readonly { fill: TraceFill; label: string; value: string }[] }) {
	return (
		<VStack gap={1}>
			{items.map((item) => (
				<HStack key={item.label} gap={2} align="center" justify="between">
					<HStack gap={2} align="center">
						<TraceSwatch fill={item.fill} />
						<Text type="supporting" color="secondary">
							{item.label}
						</Text>
					</HStack>
					<Text type="supporting" hasTabularNumbers>
						{item.value}
					</Text>
				</HStack>
			))}
		</VStack>
	);
}

/** One bar split into shares, each rounded and parted from the next. */
function ShareBar({ parts }: { parts: readonly { key: string; fill: TraceFill; value: number }[] }) {
	const total = parts.reduce((sum, part) => sum + part.value, 0);
	return (
		<ChartFrame>
			<ResponsiveContainer width="100%" height={SHARE_PX} initialDimension={{ width: FIRST_WIDTH_PX, height: SHARE_PX }}>
				<BarChart
					data={[Object.fromEntries(parts.map((part) => [part.key, part.value]))]}
					layout="vertical"
					margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
					barCategoryGap={0}
					accessibilityLayer={false}
				>
					<XAxis type="number" domain={[0, total]} hide />
					<YAxis type="category" hide />
					{parts.map((part) => (
						<Bar key={part.key} dataKey={part.key} stackId="share" fill={traceFill(part.fill)} {...BAR} />
					))}
				</BarChart>
			</ResponsiveContainer>
		</ChartFrame>
	);
}

/** A share as a legend reads it; a sliver too thin to round up still says it is there. */
function shareText(share: number): string {
	return share > 0 && share < 0.01 ? `<${percent.format(0.01)}` : percent.format(share);
}

function sumOf(split: TraceTimeSplit): number {
	return SPLIT_KEYS.reduce((total, key) => total + split[key], 0);
}

/** Every place time went, however small: a guardrail's few milliseconds still get their line. */
function SplitLegend({ split, total }: { split: TraceTimeSplit; total: number }) {
	const format = useTraceFormat();
	const { t } = format;
	return (
		<Legend
			items={SPLIT_KEYS.filter((key) => split[key] > 0).map((key) => ({
				fill: SPLIT_FILL[key],
				label: t(`@theorem.panel.trace.time.${key}`),
				value: [format.duration(split[key]), shareText(split[key] / total)].join(t('@theorem.panel.trace.separator')),
			}))}
		/>
	);
}

/** A turn's time by where it went: what share went to the model, the bar, and each share. */
function TimeCard({ split }: { split: TraceTimeSplit }) {
	const format = useTraceFormat();
	const { t } = format;
	const total = sumOf(split);
	if (total <= 0) return null;
	// A share under half a percent is too thin to draw; the legend still lists it.
	const keys = SPLIT_KEYS.filter((key) => split[key] / total >= 0.005);
	return (
		<ChartCard
			title={t('@theorem.panel.trace.time')}
			value={format.duration(total)}
			note={split.model > 0 ? t('@theorem.panel.trace.charts.modelShare', { share: percent.format(split.model / total) }) : undefined}
		>
			<ShareBar parts={keys.map((key) => ({ key, fill: SPLIT_FILL[key], value: split[key] }))} />
			<SplitLegend split={split} total={total} />
		</ChartCard>
	);
}

/** One column of a tokens chart: a model call, or a whole turn. */
type TokenRow = { index: number; title: string; ms: number; cached: number; fresh: number; output: number; cost?: number; open: () => void };

/** A bar's tokens: read from cache, read fresh, written, and its cost when known. */
function tokenSplit(usage: { input?: number; cached?: number; output?: number; cost?: number }): Pick<TokenRow, 'cached' | 'fresh' | 'output' | 'cost'> {
	const cached = usage.cached ?? 0;
	return {
		cached,
		fresh: Math.max(0, (usage.input ?? 0) - cached),
		output: usage.output ?? 0,
		...(usage.cost !== undefined && { cost: usage.cost }),
	};
}

function TokenTip({ active, payload }: TooltipContentProps) {
	const format = useTraceFormat();
	const { t } = format;
	const row = payload?.[0]?.payload as TokenRow | undefined;
	if (!active || !row) return null;
	return (
		<ChartTip>
			<VStack gap={0}>
				<Text weight="medium">{row.title}</Text>
				<Text type="supporting" hasTabularNumbers>
					{[format.duration(row.ms), ...(row.cost === undefined ? [] : [format.usd(row.cost)])].join(t('@theorem.panel.trace.separator'))}
				</Text>
				<Text type="supporting" color="secondary" hasTabularNumbers>
					{t('@theorem.panel.trace.charts.tokens', {
						cached: format.number(row.cached),
						fresh: format.number(row.fresh),
						output: format.number(row.output),
					})}
				</Text>
			</VStack>
		</ChartTip>
	);
}

/** Columns of stacked series, one per row; a column opens its row. */
function Columns<Row extends { index: number; open: () => void }>({
	rows,
	keys,
	fills,
	tip,
}: {
	rows: readonly Row[];
	keys: readonly string[];
	fills: Readonly<Record<string, TraceFill>>;
	tip: (props: TooltipContentProps) => ReactNode;
}) {
	return (
		<ChartFrame>
			<ResponsiveContainer width="100%" height={CHART_PX} initialDimension={{ width: FIRST_WIDTH_PX, height: CHART_PX }}>
				<BarChart
					data={rows}
					margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
					accessibilityLayer={false}
					barCategoryGap="24%"
					maxBarSize={24}
					onClick={(state) => rows[Number(state?.activeIndex)]?.open()}
					style={{ cursor: 'pointer' }}
				>
					<XAxis dataKey="index" tick={TICK} tickLine={false} axisLine={false} height={18} />
					<YAxis hide />
					<Tooltip content={tip} cursor={{ fill: 'var(--color-overlay-hover)', radius: TRACE_RADIUS }} isAnimationActive={false} />
					{keys.map((key) => (
						<Bar key={key} dataKey={key} stackId="stack" fill={traceFill(fills[key] ?? 'clear')} {...BAR} />
					))}
				</BarChart>
			</ResponsiveContainer>
		</ChartFrame>
	);
}

/** Tokens stacked new, cached and written per row: the total, the columns, and each series' sum. */
function TokensCard({ title, rows }: { title: string; rows: readonly TokenRow[] }) {
	const format = useTraceFormat();
	const { t } = format;
	const sums = { fresh: 0, cached: 0, output: 0 };
	for (const row of rows) for (const key of TOKEN_KEYS) sums[key] += row[key];
	const total = sums.fresh + sums.cached + sums.output;
	if (total === 0) return null;
	const input = sums.fresh + sums.cached;
	const labels = { fresh: 'input', cached: 'cached', output: 'output' } as const;
	return (
		<ChartCard
			title={title}
			value={format.number(total)}
			{...(sums.cached > 0 && { note: t('@theorem.panel.trace.charts.cachedShare', { share: percent.format(sums.cached / input) }) })}
		>
			<Columns rows={rows} keys={TOKEN_KEYS.filter((key) => sums[key] > 0)} fills={TOKEN_FILL} tip={(props) => <TokenTip {...props} />} />
			<Legend
				items={TOKEN_KEYS.filter((key) => sums[key] > 0).map((key) => ({
					fill: TOKEN_FILL[key],
					label: t(`@theorem.panel.trace.charts.${labels[key]}`),
					value: compact.format(sums[key]),
				}))}
			/>
		</ChartCard>
	);
}

/** A turn's model calls as token rows. */
function useCallRows(root: TraceNode, onSelect: (node: TraceNode) => void): TokenRow[] {
	const { t } = useTraceFormat();
	return useMemo(
		() =>
			modelCalls(root).map((node, position) => ({
				index: position + 1,
				title: t('@theorem.panel.trace.charts.call', { index: position + 1 }),
				ms: node.durationMs,
				...tokenSplit({
					input: numberAt(node, 'gen_ai.usage.input_tokens'),
					cached: numberAt(node, 'gen_ai.usage.cache_read.input_tokens'),
					output: numberAt(node, 'gen_ai.usage.output_tokens'),
					cost: numberAt(node, 'theorem.usage.cost_usd'),
				}),
				open: () => onSelect(node),
			})),
		[root, onSelect, t],
	);
}

type SlowRow = { id: string; node: TraceNode; name: string; ms: number };

function SlowTip({ active, payload }: TooltipContentProps) {
	const format = useTraceFormat();
	const row = payload?.[0]?.payload as SlowRow | undefined;
	if (!active || !row) return null;
	return (
		<ChartTip>
			<VStack gap={0}>
				<Text weight="medium">{row.name}</Text>
				<Text type="supporting" hasTabularNumbers>
					{format.duration(row.ms)}
				</Text>
			</VStack>
		</ChartTip>
	);
}

/** The steps that took longest, longest first, filled by who acted. A bar opens its step. */
function SlowestCard({ root, onSelect }: { root: TraceNode; onSelect: (node: TraceNode) => void }) {
	const format = useTraceFormat();
	const { t } = format;
	const rows = useMemo<SlowRow[]>(() => {
		const calls = modelCalls(root);
		return traceSpans(root.children)
			.filter((node) => node.meta.type === 'tool' || MODEL_CALLS.has(node.meta.type))
			.sort((a, b) => b.durationMs - a.durationMs)
			.slice(0, SLOWEST)
			.map((node) => ({
				id: node.id,
				node,
				name:
					node.meta.type === 'tool'
						? (node.meta.subject ?? node.meta.label)
						: t('@theorem.panel.trace.charts.call', { index: calls.indexOf(node) + 1 }),
				ms: node.durationMs,
			}));
	}, [root, t]);
	const top = rows[0];
	if (!top) return null;
	const height = rows.length * SLOW_ROW_PX;
	return (
		<ChartCard title={t('@theorem.panel.trace.charts.slowest')} value={format.duration(top.ms)} note={top.name}>
			<ChartFrame>
				<ResponsiveContainer width="100%" height={height} initialDimension={{ width: FIRST_WIDTH_PX, height }}>
					<BarChart
						data={rows}
						layout="vertical"
						margin={{ top: 0, right: 48, bottom: 0, left: 0 }}
						accessibilityLayer={false}
						barCategoryGap={5}
						onClick={(state) => {
							const row = rows[Number(state?.activeIndex)];
							if (row) onSelect(row.node);
						}}
						style={{ cursor: 'pointer' }}
					>
						<XAxis type="number" hide />
						<YAxis
							type="category"
							dataKey="id"
							width={104}
							tick={TICK}
							tickLine={false}
							axisLine={false}
							interval={0}
							tickFormatter={(id: string) => {
								const name = rows.find((row) => row.id === id)?.name ?? '';
								return name.length > 15 ? `${name.slice(0, 14)}…` : name;
							}}
						/>
						<Tooltip content={(props) => <SlowTip {...props} />} cursor={false} isAnimationActive={false} />
						<Bar
							dataKey="ms"
							{...BAR}
							label={{ position: 'right', fill: 'var(--color-text-secondary)', fontSize: 11, formatter: (value) => format.duration(Number(value)) }}
						>
							{rows.map((row) => (
								<Cell key={row.id} fill={traceFill(ACTOR_FILL[traceActor(row.node)])} />
							))}
						</Bar>
					</BarChart>
				</ResponsiveContainer>
			</ChartFrame>
		</ChartCard>
	);
}

/** Where a turn's time, tokens and slowest steps went. A bar opens its span. */
export function TraceCharts({
	root,
	split,
	onSelect,
}: {
	root: TraceNode;
	split: TraceTimeSplit;
	onSelect: (node: TraceNode) => void;
}) {
	const { t } = useTraceFormat();
	const callRows = useCallRows(root, onSelect);
	return (
		<Grid columns={{ minWidth: 260, repeat: 'fit' }} gap={3}>
			<TimeCard split={split} />
			<TokensCard title={t('@theorem.panel.trace.charts.calls')} rows={callRows} />
			<SlowestCard root={root} onSelect={onSelect} />
		</Grid>
	);
}

type TurnTimeRow = TraceTimeSplit & { index: number; title: string; open: () => void };

function TurnTimeTip({ active, payload }: TooltipContentProps) {
	const format = useTraceFormat();
	const { t } = format;
	const row = payload?.[0]?.payload as TurnTimeRow | undefined;
	if (!active || !row) return null;
	return (
		<ChartTip>
			<VStack gap={0}>
				<Text weight="medium">{row.title}</Text>
				{SPLIT_KEYS.filter((key) => row[key] > 0).map((key) => (
					<Text key={key} type="supporting" hasTabularNumbers>
						{[t(`@theorem.panel.trace.time.${key}`), format.duration(row[key])].join(t('@theorem.panel.trace.separator'))}
					</Text>
				))}
			</VStack>
		</ChartTip>
	);
}

/** Each turn's time by where it went, stacked: the conversation's total and each share's sum. */
function TurnTimeCard({ rows, isCalls }: { rows: readonly TurnTimeRow[]; isCalls: boolean }) {
	const format = useTraceFormat();
	const { t } = format;
	const sums: TraceTimeSplit = { model: 0, tools: 0, guardrails: 0, hooks: 0, other: 0 };
	for (const row of rows) for (const key of SPLIT_KEYS) sums[key] += row[key];
	const total = sumOf(sums);
	if (total <= 0) return null;
	return (
		<ChartCard
			title={t(isCalls ? '@theorem.panel.trace.charts.callTime' : '@theorem.panel.trace.charts.turnTime')}
			value={format.duration(total)}
			note={sums.model > 0 ? t('@theorem.panel.trace.charts.modelShare', { share: percent.format(sums.model / total) }) : undefined}
		>
			<Columns rows={rows} keys={SPLIT_KEYS} fills={SPLIT_FILL} tip={(props) => <TurnTimeTip {...props} />} />
			<SplitLegend split={sums} total={total} />
		</ChartCard>
	);
}

/** The whole conversation: each turn's time and tokens. A column opens its turn. */
export function ConversationCharts({ turns, onPick }: { turns: readonly TraceTurn[]; onPick: (index: number) => void }) {
	const { t } = useTraceFormat();
	const isCalls = isCallTrace(turns);
	const column = isCalls ? '@theorem.panel.trace.charts.hostCall' : '@theorem.panel.trace.charts.turn';
	const time = useMemo<TurnTimeRow[]>(
		() =>
			turns.map((turn, position) => ({
				index: position + 1,
				title: t(column, { index: position + 1 }),
				...turn.split,
				open: () => onPick(position),
			})),
		[turns, onPick, t, column],
	);
	const tokens = useMemo<TokenRow[]>(
		() =>
			turns.map(({ totals }, position) => ({
				index: position + 1,
				title: t(column, { index: position + 1 }),
				ms: totals.durationMs,
				...tokenSplit({
					input: totals.input?.value,
					cached: totals.cached?.value,
					output: totals.output?.value,
					cost: totals.cost?.value,
				}),
				open: () => onPick(position),
			})),
		[turns, onPick, t, column],
	);
	return (
		<Grid columns={{ minWidth: 260, repeat: 'fit' }} gap={3}>
			<TurnTimeCard rows={time} isCalls={isCalls} />
			<TokensCard title={t('@theorem.panel.trace.charts.turnTokens')} rows={tokens} />
		</Grid>
	);
}
