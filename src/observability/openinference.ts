/**
 * OpenInference attributes for viewers that read them (Phoenix).
 *
 * Phoenix maps the GenAI semconv spans on its own, but not reasoning tokens
 * or cost; it reads those only under OpenInference names. This module copies
 * them onto each model-call span, beside the semconv names, so the kernel and
 * `toOtlpJson` stay viewer-neutral. Hosts that don't use such a viewer never
 * load it.
 *
 * Names: https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * @module
 */

import type { TraceRecord } from './trace-record.ts';
import type { TraceAttributes, TraceSpan } from './trace-span.ts';

/** The operations that are one model call (semconv `gen_ai.operation.name`). */
const MODEL_CALLS: ReadonlySet<unknown> = new Set(['chat', 'generate_content']);

/**
 * OpenInference names for one model call's usage. Only model calls carry them:
 * a viewer sums them across a trace, and an agent span's usage is already the
 * sum of its calls.
 */
function openInferenceUsage(attributes: TraceAttributes): TraceAttributes {
  const reasoning = attributes['gen_ai.usage.reasoning.output_tokens'];
  const cost = attributes['theorem.usage.cost_usd'];
  return {
    ...(typeof reasoning === 'number'
      ? { 'llm.token_count.completion_details.reasoning': reasoning }
      : {}),
    // A partial cost would read as the call's total; it keeps only its theorem.* name.
    ...(typeof cost === 'number' && attributes['theorem.usage.cost_partial'] !== true
      ? { 'llm.cost.total': cost }
      : {}),
  };
}

function withSpanUsage(span: TraceSpan): TraceSpan {
  if (!MODEL_CALLS.has(span.attributes['gen_ai.operation.name'])) {
    return span;
  }
  return { ...span, attributes: { ...span.attributes, ...openInferenceUsage(span.attributes) } };
}

/**
 * The records with OpenInference usage names added to every model-call span.
 * Pure: the input records are not changed. Export with
 * `toOtlpJson(withOpenInference(records))`.
 */
function withOpenInference(records: readonly TraceRecord[]): TraceRecord[] {
  return records.map((record) => ({ ...record, spans: record.spans.map(withSpanUsage) }));
}

export { withOpenInference };
