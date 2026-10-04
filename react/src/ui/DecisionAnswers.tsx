import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { useMemo } from 'react';
import type { DecisionAnswer, DecisionResult } from '@theoremjs/agents';
import type { DecisionInterface, DecisionQuestionView } from '../client/decision-transport.ts';
import { workDuration } from './labels.ts';
import { ChartCard, TRACE_RADIUS, traceFill } from './trace-patterns.tsx';
import { useLabels } from './labels-provider.tsx';

export type TheoremDecisionAnswersProps = {
	iface: DecisionInterface;
	result: DecisionResult;
	/** The round trip, for the line under the answers. */
	elapsedMs?: number | null;
	/** A newer decision is running: the answers dim until it lands. */
	isStale?: boolean;
};

const EASE = 'var(--duration-medium) var(--ease-standard)';
/** Height of a share bar, as the trace draws one. */
const SHARE_PX = 12;

function useNumbers() {
	const locale = useLocale();
	return useMemo(
		() => ({
			percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
			decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
			usd: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 }),
		}),
		[locale],
	);
}

/** The pick in the trace's clear series, the rest in its shade. */
function answerFill(isLead: boolean): string {
	return traceFill(isLead ? 'clear' : 'shade2');
}

/** The option's share as a bar, drawn like the trace's. */
function Share({ value, isLead }: { value: number; isLead: boolean }) {
	return (
		<div
			style={{
				height: SHARE_PX,
				width: `${String(Math.max(value, 0.01) * 100)}%`,
				borderRadius: TRACE_RADIUS,
				background: answerFill(isLead),
				transition: `width ${EASE}`,
			}}
		/>
	);
}

function ChoiceAnswer({ title, answer }: { title: string; answer: Extract<DecisionAnswer, { type: 'choice' }> }) {
	const t = useLabels();
	const n = useNumbers();
	const options = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a);
	return (
		<ChartCard title={title} value={answer.choice} note={t('@theorem.decision.confidence', { percent: n.percent.format(answer.confidence) })}>
			<VStack gap={2} role="list">
				{options.map(([label, p]) => (
					<VStack key={label} gap={1} role="listitem" aria-label={t('@theorem.decision.option', { label, percent: n.percent.format(p) })}>
						<HStack gap={2} hAlign="between" aria-hidden>
							<Text type="supporting" color="secondary" maxLines={1}>
								{label}
							</Text>
							<Text type="supporting" hasTabularNumbers>
								{n.percent.format(p)}
							</Text>
						</HStack>
						<Share value={p} isLead={label === answer.choice} />
					</VStack>
				))}
			</VStack>
		</ChartCard>
	);
}

const SCALE_HEIGHT = 56;

/** A level's short name: the words before its colon or dash ("Low: reversible…" → "Low"), when there are few. */
function levelName(label: string): string {
	const head = label.split(/[:—–]\s/)[0]?.trim() ?? '';
	return head && head.length <= 32 && head !== label ? head : label;
}

/** Each level's probability as a column, with a mark where the score falls between them. */
function ScoreAnswer({ title, answer, labels }: { title: string; answer: Extract<DecisionAnswer, { type: 'score' }>; labels: string[] }) {
	const t = useLabels();
	const n = useNumbers();
	const levels = labels.length;
	const nearest = Math.min(levels - 1, Math.max(0, Math.round(answer.score)));
	return (
		<ChartCard
			title={title}
			value={labels[nearest] === undefined ? n.decimal.format(answer.score) : levelName(labels[nearest])}
			note={[
				t('@theorem.decision.score_of', { score: n.decimal.format(answer.score), max: n.decimal.format(levels - 1) }),
				t('@theorem.decision.confidence', { percent: n.percent.format(answer.confidence) }),
			].join(' · ')}
		>
			<VStack gap={1}>
				<div aria-hidden style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 4, height: SCALE_HEIGHT }}>
					{labels.map((label, level) => (
						<div
							key={`${String(level)}:${label}`}
							style={{
								flex: 1,
								height: `${String(Math.max(0.04, answer.probabilities[String(level)] ?? 0) * 100)}%`,
								borderRadius: TRACE_RADIUS,
								background: answerFill(level === nearest),
								transition: `height ${EASE}`,
							}}
						/>
					))}
					<div
						style={{
							position: 'absolute',
							insetBlock: -4,
							left: `${String(((answer.score + 0.5) / levels) * 100)}%`,
							width: 0,
							borderInlineStart: '1.5px dashed var(--color-text-secondary)',
							transition: `left ${EASE}`,
						}}
					/>
				</div>
				<div style={{ display: 'flex', gap: 4 }}>
					{labels.map((label, level) => (
						<div key={`${String(level)}:${label}`} style={{ flex: 1, minWidth: 0 }} title={label}>
							<Text type="supporting" color="secondary" maxLines={1}>
								{levelName(label)}
							</Text>
						</div>
					))}
				</div>
				<span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>
					{labels.map((label, level) => t('@theorem.decision.option', { label, percent: n.percent.format(answer.probabilities[String(level)] ?? 0) })).join('; ')}
				</span>
			</VStack>
		</ChartCard>
	);
}

function NumberAnswer({ title, answer }: { title: string; answer: Extract<DecisionAnswer, { type: 'noul' }> }) {
	const n = useNumbers();
	return <ChartCard title={title} value={n.decimal.format(answer.noul)} />;
}

/** One question's answer in the trace's chart card, titled by the question and its kind. */
function AnswerCard({ question, answer }: { question: DecisionQuestionView; answer: DecisionAnswer | undefined }) {
	const t = useLabels();
	const title = `${question.id} · ${t(`@theorem.decision.type.${question.type}`)}`;
	if (answer?.type === 'choice') return <ChoiceAnswer title={title} answer={answer} />;
	if (answer?.type === 'score') return <ScoreAnswer title={title} answer={answer} labels={question.labels} />;
	if (answer?.type === 'noul') return <NumberAnswer title={title} answer={answer} />;
	return null;
}

/**
 * A decision's answers, one card per question in the order the profile asks
 * them, and one quiet line for the model, time, tokens, and cost.
 */
export function TheoremDecisionAnswers({ iface, result, elapsedMs, isStale }: TheoremDecisionAnswersProps) {
	const t = useLabels();
	const n = useNumbers();
	const meta = [
		result.model,
		elapsedMs == null ? null : workDuration(t, elapsedMs),
		result.usage ? t('@theorem.decision.tokens', { count: result.usage.inputTokens }) : null,
		result.usage?.costUsd === undefined ? null : n.usd.format(result.usage.costUsd),
	].filter(Boolean);
	return (
		<VStack gap={3} style={{ opacity: isStale ? 0.5 : 1, transition: `opacity ${EASE}` }} aria-busy={isStale}>
			<Grid columns={{ minWidth: 260, repeat: 'fill' }} gap={3}>
				{iface.questions.map((question) => (
					<AnswerCard key={question.id} question={question} answer={result.answers[question.id]} />
				))}
			</Grid>
			<Text type="supporting" color="secondary" hasTabularNumbers>
				{meta.join(' · ')}
			</Text>
		</VStack>
	);
}
