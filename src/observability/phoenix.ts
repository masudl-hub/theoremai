/**
 * Eval results as Phoenix span annotations.
 *
 * A trial's results travel as `gen_ai.evaluation.result` events on its
 * `theorem.eval.trial` span, which Phoenix shows as span events but does not
 * read as evaluations. Its Annotations column, filters and experiment views
 * read span annotations, which it takes over REST
 * (`POST /v1/span_annotations`), not OTLP. This module turns the events into
 * that request body, each annotation on the judged root (the trial span's
 * parent), so a host that views traces in Phoenix sends the body beside the
 * records. Pure: it builds the body, the host posts it.
 *
 * API: https://arize.com/docs/phoenix/sdk-api-reference/rest-api/api-reference/spans
 *
 * @module
 */

import { inlineContent, type TraceRecord } from './trace-record.ts';
import type { TraceAttributes, TraceAttributeValue, TraceSpan } from './trace-span.ts';

const TRIAL_SPAN = 'theorem.eval.trial';
const RESULT_EVENT = 'gen_ai.evaluation.result';

/** One annotation as Phoenix's `/v1/span_annotations` takes it. */
interface PhoenixSpanAnnotation {
  /** The judged root span, as OTLP hex. */
  span_id: string;
  /** The grader's name (`gen_ai.evaluation.name`). */
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

/** Keep the entries whose value is present. */
function present(
  entries: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) kept[key] = value;
  return kept;
}

/** The explanation as stored text; nothing when the policy did not keep it. */
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
 * Every eval result in the records as a Phoenix span annotation, on the span
 * the trial judged. Records without trial spans add nothing. Send as
 * `{ data: phoenixAnnotations(records) }` to `POST /v1/span_annotations`;
 * Phoenix keeps one annotation per span and name, so grading the same
 * record again replaces its annotations.
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
