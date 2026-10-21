import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
  DETECTOR_BOUNDARIES,
  DETECTOR_META,
  DETECTORS,
  type Detector,
} from '@theoremjs/agents/guardrails';
import type { CSSProperties } from 'react';
import type { DatasetScore } from '../guardrail-bench.ts';
import { PROBE_READS } from '../guardrail-probe.ts';
import { PROBE_BOUNDARIES, PROBE_BOUNDARY_NOTES, type ProbeBoundary } from '../mod.ts';

export const MATRIX_FIGURES = ['recall', 'falseAlarms', 'p95'] as const;
export type MatrixFigure = (typeof MATRIX_FIGURES)[number];

export const MATRIX_FIGURE_LABELS: Record<MatrixFigure, string> = {
  recall: 'Recall',
  falseAlarms: 'False alarms',
  p95: 'p95 time',
};

/** Each figure's scale, from its worst (the darkest grey) through the middle (white) to its best (the darkest blue). */
const SCALE: Record<
  MatrixFigure,
  { worst: number; ends: [string, string, string]; note?: string }
> = {
  recall: { worst: 0, ends: ['0%', '50%', '100%'] },
  falseAlarms: { worst: 0.1, ends: ['10% or more', '5%', '0%'] },
  p95: {
    worst: 10,
    ends: ['10 ms or more', '5 ms', '0 ms'],
    note: 'Each cell is its slowest dataset.',
  },
};

type Cell = { value: number; goodness: number; datasets: number; of: string };

/** One boundary and detector, pooled over the datasets that cross there; undefined where none scores it. */
function cellOf(
  scores: readonly DatasetScore[],
  boundary: ProbeBoundary,
  detector: Detector,
  figure: MatrixFigure,
): Cell | undefined {
  const here = scores
    .filter((dataset) => dataset.boundary === boundary)
    .flatMap((dataset) => dataset.detectors.filter((score) => score.detector === detector));
  if (figure === 'recall') {
    const scored = here.filter((score) => score.attacks);
    const attacks = scored.reduce((sum, score) => sum + (score.attacks ?? 0), 0);
    if (attacks === 0) return undefined;
    const caught = scored.reduce((sum, score) => sum + (score.caught ?? 0), 0);
    const value = caught / attacks;
    return {
      value,
      goodness: value,
      datasets: scored.length,
      of: `${caught} of ${attacks} attacks`,
    };
  }
  if (figure === 'falseAlarms') {
    const benign = here.reduce((sum, score) => sum + score.benign, 0);
    if (benign === 0) return undefined;
    const fired = here.reduce((sum, score) => sum + score.falseAlarms, 0);
    const value = fired / benign;
    const goodness = 1 - Math.min(1, value / SCALE.falseAlarms.worst);
    return { value, goodness, datasets: here.length, of: `${fired} of ${benign} benign texts` };
  }
  const timed = here.flatMap((score) => (score.ms ? [score.ms.p95] : []));
  if (timed.length === 0) return undefined;
  const value = Math.max(...timed);
  const goodness = 1 - Math.min(1, value / SCALE.p95.worst);
  return { value, goodness, datasets: timed.length, of: 'the slowest dataset' };
}

function shown(figure: MatrixFigure, value: number): string {
  return figure === 'p95' ? `${value.toFixed(1)}` : `${(value * 100).toFixed(0)}`;
}

/** Good is blue and bad is grey, each darker the further it is from the middle. */
function tint(goodness: number): string {
  const ink = goodness >= 0.5 ? 'var(--color-text-blue)' : 'var(--color-text-gray)';
  return `color-mix(in srgb, ${ink} ${String(strengthOf(goodness))}%, var(--color-background-surface))`;
}

function strengthOf(goodness: number): number {
  return Math.round(Math.abs(goodness - 0.5) * 2 * 85);
}

function shade(goodness: number): CSSProperties {
  return {
    background: tint(goodness),
    color:
      strengthOf(goodness) > 50 ? 'var(--color-background-surface)' : 'var(--color-text-primary)',
  };
}

/** Whether `detector` can read `boundary` at all: a profile may set it there. */
function readsAt(boundary: ProbeBoundary, detector: Detector): boolean {
  return DETECTOR_BOUNDARIES[detector].includes(PROBE_READS[boundary]);
}

function MatrixCell({
  scores,
  boundary,
  detector,
  figure,
  onOpen,
}: {
  scores: readonly DatasetScore[];
  boundary: ProbeBoundary;
  detector: Detector;
  figure: MatrixFigure;
  onOpen: (boundary: ProbeBoundary, detector: Detector) => void;
}) {
  const cell = cellOf(scores, boundary, detector, figure);
  const name = `${DETECTOR_META[detector].label} at ${PROBE_BOUNDARY_NOTES[boundary].label}`;
  if (!cell) {
    const isOff = !readsAt(boundary, detector);
    return (
      <Tooltip
        content={`${name}: ${isOff ? 'it does not read this boundary' : 'no dataset scores it here'}`}
      >
        <span
          className={`studio-bench-cell ${isOff ? 'studio-bench-cell-off' : 'studio-bench-cell-empty'}`}
        />
      </Tooltip>
    );
  }
  return (
    <Tooltip
      content={`${name}: ${shown(figure, cell.value)}${figure === 'p95' ? ' ms' : '%'}, ${cell.of}, over ${String(cell.datasets)} datasets`}
    >
      <button
        type="button"
        className="studio-bench-cell"
        style={shade(cell.goodness)}
        onClick={() => {
          onOpen(boundary, detector);
        }}
      >
        {shown(figure, cell.value)}
      </button>
    </Tooltip>
  );
}

/** The figure's scale as a strip from grey through white to blue, with its ends and middle named. */
function ScaleStrip({ figure }: { figure: MatrixFigure }) {
  const { ends, note } = SCALE[figure];
  const label = MATRIX_FIGURE_LABELS[figure];
  return (
    <VStack gap={1}>
      <div
        role="img"
        aria-label={`${label} scale: ${ends[0]} is the darkest grey, ${ends[1]} white, ${ends[2]} the darkest blue.`}
        className="studio-bench-strip"
        style={{
          background: `linear-gradient(to right, ${tint(0)}, ${tint(0.5)}, ${tint(1)})`,
        }}
      />
      <HStack justify="between">
        {ends.map((end) => (
          <Text key={end} type="supporting" color="secondary">
            {end}
          </Text>
        ))}
      </HStack>
      <HStack gap={3} align="center" wrap="wrap">
        <HStack gap={1} align="center">
          <span className="studio-bench-cell studio-bench-cell-empty studio-bench-key" />
          <Text type="supporting" color="secondary">
            No dataset scores it
          </Text>
        </HStack>
        <HStack gap={1} align="center">
          <span className="studio-bench-cell studio-bench-cell-off studio-bench-key" />
          <Text type="supporting" color="secondary">
            Does not read here
          </Text>
        </HStack>
        {note && (
          <Text type="supporting" color="secondary">
            {note}
          </Text>
        )}
      </HStack>
    </VStack>
  );
}

/**
 * Every boundary against every detector, shaded by how the detector does there: blue where it is
 * good, grey where it is bad, white where no dataset scores it. A cell opens its rows in the table.
 */
export function GuardrailMatrix({
  scores,
  figure,
  onOpen,
}: {
  scores: readonly DatasetScore[];
  figure: MatrixFigure;
  onOpen: (boundary: ProbeBoundary, detector: Detector) => void;
}) {
  return (
    <VStack gap={3}>
      <div className="studio-bench-matrix-scroll">
        <div
          className="studio-bench-matrix"
          style={{ gridTemplateColumns: `max-content repeat(${String(DETECTORS.length)}, 44px)` }}
        >
          <span />
          {DETECTORS.map((detector) => (
            <span key={detector} className="studio-bench-matrix-head">
              <Text type="supporting" color="secondary">
                {DETECTOR_META[detector].label}
              </Text>
            </span>
          ))}
          {PROBE_BOUNDARIES.map((boundary) => [
            <Text key={boundary} type="supporting">
              {PROBE_BOUNDARY_NOTES[boundary].label}
            </Text>,
            ...DETECTORS.map((detector) => (
              <MatrixCell
                key={detector}
                scores={scores}
                boundary={boundary}
                detector={detector}
                figure={figure}
                onOpen={onOpen}
              />
            )),
          ])}
        </div>
      </div>
      <div className="studio-bench-legend">
        <ScaleStrip figure={figure} />
      </div>
    </VStack>
  );
}
