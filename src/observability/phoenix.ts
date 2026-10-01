/**
 * Eval results as Phoenix span annotations, which Phoenix reads over REST
 * (`POST /v1/span_annotations`), not OTLP. Pure: it builds the body, the host posts it.
 *
 * @module
 */

import { inlineContent, type TraceRecord } from './trace-record.ts';
import type { TraceAttributes, TraceAttributeValue, TraceSpan } from './trace-span.ts';

const TRIAL_SPAN = 'theorem.eval.trial';
const RESULT_EVENT = 'gen_ai.evaluation.result';

interface PhoenixSpanAnnotation {
  /** The judged root span, as OTLP hex. */
  span_id: string;
  name: string;
  /** `LLM` for a judge's result, `CODE` for a code grader's. */
  annotator_kind: 'LLM' | 'CODE';
  result: { label?: string; score?: number; explanation?: string };
  metadata: Record<string, string | number | boolean>;
}

function scalar(value: TraceAttributeValue | undefined): string | number | boolean | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

function present(
  entries: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) kept[key] = value;
  return kept;
}

/** `undefined` when the policy did not keep the explanation. */
function explanationOf(
  record: TraceRecord,
  value: TraceAttributeValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const text = inlineContent(record, value);
  return typeof text === 'string' ? text : undefined;
}

function annotation(
  record: TraceRecord,
  span: TraceSpan & { parentSpanId: string },
  attributes: TraceAttributes,
): PhoenixSpanAnnotation | undefined {
  const name = attributes['gen_ai.evaluation.name'];
  if (typeof name !== 'string') return undefined;
  const label = attributes['gen_ai.evaluation.score.label'];
  const score = attributes['gen_ai.evaluation.score.value'];
  const explanation = explanationOf(record, attributes['gen_ai.evaluation.explanation']);
  return {
    span_id: span.parentSpanId,
    name,
    annotator_kind: attributes['theorem.evaluation.source'] === 'model' ? 'LLM' : 'CODE',
    result: {
      ...(typeof label === 'string' ? { label } : {}),
      ...(typeof score === 'number' ? { score } : {}),
      ...(explanation === undefined ? {} : { explanation }),
    },
    metadata: present({
      suite: scalar(span.attributes['theorem.evaluation.suite']),
      case: scalar(span.attributes['theorem.evaluation.case']),
      trial: scalar(span.attributes['theorem.evaluation.trial']),
      passed: scalar(attributes['theorem.evaluation.passed']),
      error_type: scalar(attributes['error.type']),
      grader_version: scalar(attributes['theorem.evaluation.grader.version']),
    }),
  };
}

/**
 * Each annotation lands on the root the trial judged. Send as
 * `{ data: phoenixAnnotations(records) }`; Phoenix keeps one annotation per span and name, so
 * grading a record again replaces them.
 */
function phoenixAnnotations(records: readonly TraceRecord[]): PhoenixSpanAnnotation[] {
  return records.flatMap((record) =>
    record.spans.flatMap((span) => {
      if (span.name !== TRIAL_SPAN || span.parentSpanId === undefined) return [];
      const trial = { ...span, parentSpanId: span.parentSpanId };
      return span.events
        .filter((event) => event.name === RESULT_EVENT)
        .flatMap((event) => annotation(record, trial, event.attributes) ?? []);
    }),
  );
}

export type { PhoenixSpanAnnotation };
export { phoenixAnnotations };
