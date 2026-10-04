import { Badge } from '@astryxdesign/core/Badge';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconAlertTriangle,
	IconBolt,
	IconInputAi,
	IconMessageCircle,
	IconServer,
	IconTool,
	IconUser,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { type TraceActor, type TraceStep, toolArguments, traceActor, traceOutcome } from '../client/trace-story.ts';
import type { TraceNode } from '../client/trace-view.ts';
import { useTraceFormat } from './TraceValues.tsx';

/** Each actor's mark, shared by the story and the turn list. */
const ACTOR_ICON: Readonly<Record<TraceActor, typeof IconUser>> = {
	user: IconUser,
	model: IconInputAi,
	tool: IconTool,
	host: IconServer,
	theorem: IconBolt,
	error: IconAlertTriangle,
};

/** An actor's icon, in the text's own colour. */
export function ActorMark({ actor, icon }: { actor: TraceActor; icon?: typeof IconUser }) {
	return <Icon icon={icon ?? ACTOR_ICON[actor]} size="sm" color="secondary" />;
}

/** "city: Lisbon · to: USD": a tool call's plain arguments on one line. */
function argumentsLine(node: TraceNode, separator: string): string {
	return toolArguments(node)
		.map(([key, value]) => (key ? `${key}: ${value}` : value))
		.join(separator);
}

/** Duration, then cost when the span reported one. */
function StepMeasure({ node }: { node: TraceNode }) {
	const format = useTraceFormat();
	const cost = node.span.attributes['theorem.usage.cost_usd'];
	return (
		<VStack gap={0} hAlign="end">
			<Text type="supporting" hasTabularNumbers>
				{format.duration(node.durationMs)}
			</Text>
			{typeof cost === 'number' ? (
				<Text type="supporting" color="secondary" hasTabularNumbers>
					{format.usd(cost)}
				</Text>
			) : null}
		</VStack>
	);
}

function Offset({ ms }: { ms: number }) {
	const format = useTraceFormat();
	return (
		<Text type="supporting" color="secondary" hasTabularNumbers>
			{format.t('@theorem.panel.trace.offset', { duration: format.duration(ms) })}
		</Text>
	);
}

/** A span step's line: the tools a call asked for or that it wrote, a tool's arguments, else the span's own label. */
function spanLine(step: Extract<TraceStep, { kind: 'span' }>, format: ReturnType<typeof useTraceFormat>): string {
	const { node } = step;
	if (node.meta.type === 'tool') return argumentsLine(node, format.t('@theorem.panel.trace.separator'));
	if (node.meta.type !== 'call' && node.meta.type !== 'response') return node.meta.label;
	return step.requested > 0
		? format.t('@theorem.panel.trace.story.requested', { count: step.requested })
		: format.t('@theorem.panel.trace.story.wrote');
}

/** What a span step says under its name: how it ended when that is news, then its line. */
function spanDescription(step: Extract<TraceStep, { kind: 'span' }>, format: ReturnType<typeof useTraceFormat>): ReactNode {
	const outcome = traceOutcome(step.node);
	const line = spanLine(step, format);
	if (!outcome) return line;
	return (
		<HStack gap={1} align="center" wrap="wrap">
			<Tooltip content={outcome.doc ?? outcome.label}>
				<Badge variant={outcome.tone} label={outcome.label} />
			</Tooltip>
			{line ? <Text type="supporting">{line}</Text> : null}
		</HStack>
	);
}

function Quote({ text }: { text: string }) {
	return (
		<Text color="secondary" maxLines={3} hasTruncateTooltip={false}>
			{text}
		</Text>
	);
}

type StepProps<Kind extends TraceStep['kind']> = { step: Extract<TraceStep, { kind: Kind }>; isSelected: boolean; select: () => void };

function AskItem({ step, isSelected, select }: StepProps<'ask'>) {
	const { t } = useTraceFormat();
	return (
		<Item
			startContent={<ActorMark actor="user" />}
			label={<Text weight="medium">{t('@theorem.panel.trace.story.asked')}</Text>}
			description={<Quote text={step.text} />}
			endContent={<Offset ms={0} />}
			align="start"
			density="compact"
			onClick={select}
			isSelected={isSelected}
		/>
	);
}

function SpanItem({ step, isSelected, select }: StepProps<'span'>) {
	const format = useTraceFormat();
	return (
		<Item
			startContent={<ActorMark actor={traceActor(step.node)} />}
			label={
				<Text weight="medium" maxLines={1}>
					{step.node.meta.subject ?? step.node.meta.label}
				</Text>
			}
			description={spanDescription(step, format)}
			endContent={<StepMeasure node={step.node} />}
			align="start"
			density="compact"
			onClick={select}
			isSelected={isSelected}
		/>
	);
}

function EventItem({ step, isSelected, select }: StepProps<'event'>) {
	const { t } = useTraceFormat();
	return (
		<Item
			startContent={<ActorMark actor="theorem" />}
			label={
				<Tooltip content={step.doc}>
					<Text weight="medium">{step.label}</Text>
				</Tooltip>
			}
			description={step.detail.join(t('@theorem.panel.trace.separator'))}
			endContent={<Offset ms={step.offsetMs} />}
			align="start"
			density="compact"
			onClick={select}
			isSelected={isSelected}
		/>
	);
}

function AnswerItem({ step, isSelected, select }: StepProps<'answer'>) {
	const { t } = useTraceFormat();
	const failed = step.node.span.status.code === 'ERROR';
	const answer = step.text ? <Quote text={step.text} /> : undefined;
	return (
		<Item
			startContent={<ActorMark actor={failed ? 'error' : 'model'} icon={failed ? undefined : IconMessageCircle} />}
			label={<Text weight="medium">{t(failed ? '@theorem.panel.trace.story.failed' : '@theorem.panel.trace.story.answered')}</Text>}
			description={failed ? traceOutcome(step.node)?.label : answer}
			endContent={<Offset ms={step.offsetMs} />}
			align="start"
			density="compact"
			onClick={select}
			isSelected={isSelected}
		/>
	);
}

function StepBody({ step, isSelected, select }: { step: TraceStep; isSelected: boolean; select: () => void }) {
	switch (step.kind) {
		case 'ask':
			return <AskItem step={step} isSelected={isSelected} select={select} />;
		case 'span':
			return <SpanItem step={step} isSelected={isSelected} select={select} />;
		case 'event':
			return <EventItem step={step} isSelected={isSelected} select={select} />;
		case 'answer':
			return <AnswerItem step={step} isSelected={isSelected} select={select} />;
	}
}

function StepItem({
	step,
	isSelected,
	isDimmed,
	onSelect,
}: {
	step: TraceStep;
	isSelected: boolean;
	isDimmed: boolean;
	onSelect: (node: TraceNode) => void;
}) {
	return (
		<div
			style={{
				paddingInlineStart: step.kind === 'span' && step.nested ? 20 : 0,
				opacity: isDimmed ? 0.35 : 1,
				transition: 'opacity 120ms ease',
			}}
		>
			<StepBody step={step} isSelected={isSelected} select={() => onSelect(step.node)} />
		</div>
	);
}

/**
 * The turn, told in order: what the user asked, each model call with the tool
 * calls it asked for set in under it, what changed course, and how it ended.
 * A line opens its span.
 */
export function TraceStory({
	steps,
	selectedId,
	matches,
	onSelect,
}: {
	steps: readonly TraceStep[];
	selectedId: string | undefined;
	/** Spans the search matched; the others dim. Absent when nothing is searched. */
	matches: ReadonlySet<string> | undefined;
	onSelect: (node: TraceNode) => void;
}) {
	return (
		<VStack gap={0}>
			{steps.map((step) => (
				<StepItem
					key={step.id}
					step={step}
					isSelected={step.kind === 'span' ? step.node.id === selectedId : false}
					isDimmed={matches !== undefined && !matches.has(step.node.id)}
					onSelect={onSelect}
				/>
			))}
		</VStack>
	);
}
