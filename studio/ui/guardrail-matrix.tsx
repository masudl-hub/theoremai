import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { DETECTOR_META, DETECTORS, type Detector } from '@theoremjs/agents/guardrails';
import type { CSSProperties } from 'react';
import type { DatasetScore } from '../guardrail-bench.ts';
import { PROBE_BOUNDARIES, PROBE_BOUNDARY_NOTES, type ProbeBoundary } from '../mod.ts';

export const MATRIX_FIGURES = ['recall', 'falseAlarms', 'p95'] as const;
export type MatrixFigure = (typeof MATRIX_FIGURES)[number];

export const MATRIX_FIGURE_LABELS: Record<MatrixFigure, string> = {
  recall: 'Recall',
  falseAlarms: 'False alarms',
  p95: 'p95 time',
};

/** Where each figure's shade turns from good to bad, and where it is at its darkest bad. */
const SCALE: Record<MatrixFigure, { worst: number; note: string }> = {
  recall: { worst: 0, note: 'Recall: 100% is the darkest blue, 50% white, 0% the darkest grey.' },
  falseAlarms: {
    worst: 0.1,
    note: 'False alarms: 0% is the darkest blue, 5% white, 10% or more the darkest grey.',
  },
  p95: {
    worst: 10,
    note: 'p95 time: 0 ms is the darkest blue, 5 ms white, 10 ms or more the darkest grey. Each cell is its slowest dataset.',
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
function shade(goodness: number): CSSProperties {
  const strength = Math.round(Math.abs(goodness - 0.5) * 2 * 85);
  const ink = goodness >= 0.5 ? 'var(--color-text-blue)' : 'var(--color-text-gray)';
  return {
    background: `color-mix(in srgb, ${ink} ${String(strength)}%, var(--color-background-surface))`,
    color: strength > 50 ? 'var(--color-background-surface)' : 'var(--color-text-primary)',
  };
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
  const boundaries = PROBE_BOUNDARIES.filter((boundary) =>
    scores.some((dataset) => dataset.boundary === boundary),
  );
  const detectors = DETECTORS.filter((detector) =>
    scores.some((dataset) => dataset.detectors.some((score) => score.detector === detector)),
  );
  return (
    <VStack gap={2}>
      <div className="studio-bench-matrix-scroll">
        <div
          className="studio-bench-matrix"
          style={{ gridTemplateColumns: `max-content repeat(${String(detectors.length)}, 44px)` }}
        >
          <span />
          {detectors.map((detector) => (
            <span key={detector} className="studio-bench-matrix-head">
              <Text type="supporting" color="secondary">
                {DETECTOR_META[detector].label}
              </Text>
            </span>
          ))}
          {boundaries.map((boundary) => [
            <Text key={boundary} type="supporting">
              {PROBE_BOUNDARY_NOTES[boundary].label}
            </Text>,
            ...detectors.map((detector) => {
              const cell = cellOf(scores, boundary, detector, figure);
              const name = `${DETECTOR_META[detector].label} at ${PROBE_BOUNDARY_NOTES[boundary].label}`;
              if (!cell) {
                return (
                  <Tooltip key={detector} content={`${name}: not scored`}>
                    <span className="studio-bench-cell studio-bench-cell-empty" />
                  </Tooltip>
                );
              }
              return (
                <Tooltip
                  key={detector}
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
            }),
          ])}
        </div>
      </div>
      <HStack>
        <Text type="supporting" color="secondary">
          {SCALE[figure].note}
        </Text>
      </HStack>
    </VStack>
  );
}
