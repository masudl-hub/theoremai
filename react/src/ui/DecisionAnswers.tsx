import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { useLocale } from '@astryxdesign/core/i18n';
import { Lightbox } from '@astryxdesign/core/Lightbox';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { IconPencil } from '@tabler/icons-react';
import type {
  DecisionAnswer,
  DecisionAsset,
  DecisionJson,
  DecisionResult,
} from '@theoremjs/agents';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  boxSource,
  cropOf,
  type DecisionImages,
  imageSrc,
  markedBox,
} from '../client/decision-images.ts';
import type { DecisionInterface, DecisionQuestionView } from '../client/decision-transport.ts';
import { Arrive, Stream } from './arrive.tsx';
import { CardWall } from './CardWall.tsx';
import { resultMeta } from './labels.ts';
import { useLabels } from './labels-provider.tsx';
import { ChartCard, TRACE_RADIUS, traceFill } from './trace-patterns.tsx';

export type TheoremDecisionAnswersProps = {
  iface: DecisionInterface;
  result: DecisionResult;
  /** The round trip, for the line under the answers. */
  elapsedMs?: number | null;
  /** A newer decision is running: the answers dim until it lands. */
  isStale?: boolean;
  /** The images and state the answers were asked about, which box answers are cut from. Without an image, a box is drawn in a plain frame. */
  asked?: { images: DecisionImages; state: DecisionJson };
  /** Opens a question where it is set up. Each answer then has a button that calls it with the question's id. */
  onQuestion?: (id: string) => void;
};

const EASE = 'var(--duration-medium) var(--ease-standard)';
/** Height of a share bar, as the trace draws one. */
const SHARE_PX = 12;

/** The reader's locale's percent, decimal and dollar formats. */
export function useNumbers() {
  const locale = useLocale();
  return useMemo(
    () => ({
      percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
      decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
      usd: new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        maximumSignificantDigits: 2,
      }),
    }),
    [locale],
  );
}

/** The pick in the trace's clear series, the rest in its shade. */
function answerFill(isLead: boolean): string {
  return traceFill(isLead ? 'clear' : 'shade2');
}

/** The option's share as a bar, drawn like the trace's. */
export function Share({ value, isLead }: { value: number; isLead: boolean }) {
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

function ChoiceAnswer({
  title,
  aside,
  answer,
}: {
  title: string;
  aside?: ReactNode;
  answer: Extract<DecisionAnswer, { type: 'choice' }>;
}) {
  const t = useLabels();
  const n = useNumbers();
  const options = Object.entries(answer.probabilities).sort(([, a], [, b]) => b - a);
  return (
    <ChartCard
      title={title}
      aside={aside}
      value={answer.choice}
      note={t('@theorem.decision.confidence', { percent: n.percent.format(answer.confidence) })}
    >
      <VStack gap={2} role="list">
        {options.map(([label, p]) => (
          <VStack
            key={label}
            gap={1}
            role="listitem"
            aria-label={t('@theorem.decision.option', { label, percent: n.percent.format(p) })}
          >
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
function ScoreAnswer({
  title,
  aside,
  answer,
  labels,
}: {
  title: string;
  aside?: ReactNode;
  answer: Extract<DecisionAnswer, { type: 'score' }>;
  labels: string[];
}) {
  const t = useLabels();
  const n = useNumbers();
  const levels = labels.length;
  const nearest = Math.min(levels - 1, Math.max(0, Math.round(answer.score)));
  return (
    <ChartCard
      title={title}
      aside={aside}
      value={
        labels[nearest] === undefined ? n.decimal.format(answer.score) : levelName(labels[nearest])
      }
      note={[
        t('@theorem.decision.score_of', {
          score: n.decimal.format(answer.score),
          max: n.decimal.format(levels - 1),
        }),
        t('@theorem.decision.confidence', { percent: n.percent.format(answer.confidence) }),
      ].join(' · ')}
    >
      <VStack gap={1}>
        <div
          aria-hidden
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 4,
            height: SCALE_HEIGHT,
          }}
        >
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
        <span
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clipPath: 'inset(50%)',
          }}
        >
          {labels
            .map((label, level) =>
              t('@theorem.decision.option', {
                label,
                percent: n.percent.format(answer.probabilities[String(level)] ?? 0),
              }),
            )
            .join('; ')}
        </span>
      </VStack>
    </ChartCard>
  );
}

function NumberAnswer({
  title,
  aside,
  answer,
}: {
  title: string;
  aside?: ReactNode;
  answer: Extract<DecisionAnswer, { type: 'noul' }>;
}) {
  const n = useNumbers();
  return <ChartCard title={title} aside={aside} value={n.decimal.format(answer.noul)} />;
}

const BOX_FRAME_HEIGHT = 72;
const CROP_HEIGHT = 168;

/** An image's natural size, once the page has loaded it. */
function useImageSize(src: string): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = src;
  }, [src]);
  return size;
}

/** A theme colour as the page draws it, for a canvas that cannot read the theme's tokens. */
function themeColor(element: HTMLElement, token: string): string {
  const shown = element.style.color;
  element.style.color = `var(${token})`;
  const color = getComputedStyle(element).color;
  element.style.color = shown;
  return color;
}

/** The part of the image the box covers, cut out at its own proportions. It opens the whole image with the box outlined. */
function BoxCrop({
  source,
  box,
  caption,
}: {
  source: DecisionAsset;
  box: Extract<DecisionAnswer, { type: 'box' }>['box'];
  caption: string;
}) {
  const t = useLabels();
  const src = imageSrc(source);
  const size = useImageSize(src);
  const [marked, setMarked] = useState<string | null>(null);
  if (!size) return null;
  const crop = cropOf(box);
  const ratio = (size.width * (box.right - box.left)) / (size.height * (box.bottom - box.top));
  const open = t('@theorem.decision.open_box');
  return (
    <>
      <Tooltip content={open}>
        <ClickableCard
          label={open}
          padding={0}
          width="fit-content"
          maxWidth="100%"
          onClick={(event) => {
            const marks = {
              outline: themeColor(event.currentTarget, '--color-accent'),
              shade: themeColor(event.currentTarget, '--color-overlay'),
            };
            void markedBox(src, box, marks).then(setMarked);
          }}
        >
          <div
            role="img"
            aria-label={t('@theorem.decision.box_in')}
            style={{
              position: 'relative',
              overflow: 'hidden',
              aspectRatio: String(ratio),
              height: CROP_HEIGHT,
              maxWidth: '100%',
              borderRadius: TRACE_RADIUS,
            }}
          >
            <img
              src={src}
              alt=""
              style={{
                position: 'absolute',
                width: `${String(crop.width)}%`,
                height: `${String(crop.height)}%`,
                left: `${String(crop.left)}%`,
                top: `${String(crop.top)}%`,
                maxWidth: 'none',
              }}
            />
          </div>
        </ClickableCard>
      </Tooltip>
      <Lightbox
        isOpen={marked !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setMarked(null);
        }}
        media={{ src: marked ?? src, alt: t('@theorem.decision.box_marked'), caption }}
        hasZoom
      />
    </>
  );
}

/** The box cut from the image its question names, or drawn in a frame that stands for the whole image. */
function BoxAnswer({
  title,
  aside,
  answer,
  field,
  asked,
}: {
  title: string;
  aside?: ReactNode;
  answer: Extract<DecisionAnswer, { type: 'box' }>;
  field?: string;
  asked?: TheoremDecisionAnswersProps['asked'];
}) {
  const t = useLabels();
  const source = asked && boxSource(asked.images, asked.state, field);
  const n = useNumbers();
  const { top, bottom, left, right } = answer.box;
  const edges = t('@theorem.decision.box_edges', {
    left: n.percent.format(left),
    top: n.percent.format(top),
    right: n.percent.format(right),
    bottom: n.percent.format(bottom),
  });
  return (
    <ChartCard
      title={title}
      aside={aside}
      value={edges}
      note={t('@theorem.decision.confidence', { percent: n.percent.format(answer.confidence) })}
    >
      {source ? (
        <BoxCrop source={source} box={answer.box} caption={`${title}: ${edges}`} />
      ) : (
        <div
          aria-hidden
          style={{
            position: 'relative',
            height: BOX_FRAME_HEIGHT,
            borderRadius: TRACE_RADIUS,
            border: '1px solid var(--color-border)',
          }}
        >
          <div
            style={{
              position: 'absolute',
              insetInlineStart: `${String(left * 100)}%`,
              insetBlockStart: `${String(top * 100)}%`,
              width: `${String((right - left) * 100)}%`,
              height: `${String((bottom - top) * 100)}%`,
              borderRadius: 2,
              background: answerFill(true),
              transition: `all ${EASE}`,
            }}
          />
        </div>
      )}
    </ChartCard>
  );
}

/** One question's answer in the trace's chart card, titled by the question and its kind. */
function AnswerCard({
  question,
  answer,
  asked,
  onQuestion,
}: {
  question: DecisionQuestionView;
  answer: DecisionAnswer | undefined;
  asked?: TheoremDecisionAnswersProps['asked'];
  onQuestion?: TheoremDecisionAnswersProps['onQuestion'];
}) {
  const t = useLabels();
  const title = `${question.id} · ${t(`@theorem.decision.type.${question.type}`)}`;
  if (!answer) return null;
  const edit = t('@theorem.decision.edit_question', { question: question.id });
  const head = {
    title,
    aside: onQuestion ? (
      <IconButton
        label={edit}
        tooltip={edit}
        size="sm"
        variant="ghost"
        icon={<Icon icon={IconPencil} size="xsm" color="secondary" />}
        onClick={() => {
          onQuestion(question.id);
        }}
      />
    ) : undefined,
  };
  if (answer.type === 'choice') return <ChoiceAnswer {...head} answer={answer} />;
  if (answer.type === 'score')
    return <ScoreAnswer {...head} answer={answer} labels={question.labels} />;
  if (answer.type === 'noul') return <NumberAnswer {...head} answer={answer} />;
  return <BoxAnswer {...head} answer={answer} field={question.field} asked={asked} />;
}

/**
 * A console's result as it streams in: dimmed while the next one runs, then
 * one quiet line for the model, time, tokens, and cost.
 */
export function ResultStack({
  model,
  usage,
  elapsedMs,
  isStale,
  tokens,
  children,
}: {
  model: string;
  usage?: { inputTokens?: number; costUsd?: number };
  elapsedMs?: number | null;
  isStale?: boolean;
  /** The tokens read, as the console words them. */
  tokens: (count: number) => string;
  children: ReactNode;
}) {
  const t = useLabels();
  const n = useNumbers();
  return (
    <Stream>
      <VStack
        key={elapsedMs ?? 0}
        gap={3}
        style={{ opacity: isStale ? 0.5 : 1, transition: `opacity ${EASE}` }}
        aria-busy={isStale}
      >
        {children}
        <Arrive>
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {resultMeta(t, n.usd, { model, usage, elapsedMs, tokens })}
          </Text>
        </Arrive>
      </VStack>
    </Stream>
  );
}

/**
 * A decision's answers, one card per question in the order the profile asks
 * them, and one quiet line for the model, time, tokens, and cost.
 */
export function TheoremDecisionAnswers({
  iface,
  result,
  elapsedMs,
  isStale,
  asked,
  onQuestion,
}: TheoremDecisionAnswersProps) {
  const t = useLabels();
  return (
    <ResultStack
      model={result.model}
      usage={result.usage}
      elapsedMs={elapsedMs}
      isStale={isStale}
      tokens={(count) => t('@theorem.decision.tokens', { count })}
    >
      <CardWall minWidth={260}>
        {iface.questions.map((question) => (
          <Arrive key={question.id}>
            <AnswerCard
              question={question}
              answer={result.answers[question.id]}
              asked={asked}
              onQuestion={onQuestion}
            />
          </Arrive>
        ))}
      </CardWall>
    </ResultStack>
  );
}
