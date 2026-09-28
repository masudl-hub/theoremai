/**
 * Records → `Trial`. A live run hands the runner what its memory sink caught;
 * a recorded run hands it what a file held. Both build the same trial, so the
 * same graders give the same results.
 *
 * The root is the `invoke_agent` span that no span in the set parents. It is
 * never assumed to be the first record: a compaction turn's record can be
 * written before its parent's (P9).
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import type { TurnTokens } from '../kernel/turn-events.ts';
import { contentOf, inlineContent, type TraceRecord } from '../observability/trace-record.ts';
import type { TraceAttributeValue, TraceSpan } from '../observability/trace-span.ts';
import type { EvalCase, TraceOperation, Trial, TrialMessage, TrialUsage } from './types.ts';

function byStart(a: TraceSpan, b: TraceSpan): number {
  const left = BigInt(a.startTimeUnixNano);
  const right = BigInt(b.startTimeUnixNano);
  return left < right ? -1 : left > right ? 1 : 0;
}

function operationOf(span: TraceSpan): string | undefined {
  const value = span.attributes['gen_ai.operation.name'];
  return typeof value === 'string' ? value : undefined;
}

/** Every span of every record, in start order. */
function allSpans(records: TraceRecord[]): TraceSpan[] {
  return records.flatMap((record) => record.spans).sort(byStart);
}

/**
 * The `invoke_agent` span whose parent is absent or outside the set; the
 * earliest when several qualify (a session root before its responses).
 */
function rootOf(spans: TraceSpan[]): TraceSpan {
  const ids = new Set(spans.map((span) => span.spanId));
  const roots = spans.filter(
    (span) =>
      operationOf(span) === 'invoke_agent' &&
      (span.parentSpanId === undefined || !ids.has(span.parentSpanId)),
  );
  const [root] = roots;
  if (!root) {
    throw new TheoremError('config', 'trial records hold no invoke_agent root span'); // lexicon-exempt: developer contract error
  }
  return root;
}

/** One record whose `content` is every record's, so a reference from any span resolves. */
function mergedRecord(records: TraceRecord[]): TraceRecord {
  const [first] = records;
  if (!first) {
    throw new TheoremError('config', 'a trial needs at least one trace record'); // lexicon-exempt: developer contract error
  }
  return { ...first, content: Object.assign({}, ...records.map((record) => record.content)) };
}

function numberAttribute(span: TraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

function isObject(value: unknown): value is Record<string, TraceAttributeValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageList(value: unknown): value is TrialMessage[] {
  return Array.isArray(value) && value.every(isObject);
}

/** The root's usage attributes as `TurnTokens`; zero when the root recorded none. */
function usageOf(root: TraceSpan): TrialUsage {
  const input = numberAttribute(root, 'gen_ai.usage.input_tokens') ?? 0;
  const output = numberAttribute(root, 'gen_ai.usage.output_tokens') ?? 0;
  const thinking = numberAttribute(root, 'gen_ai.usage.reasoning.output_tokens');
  const cached = numberAttribute(root, 'gen_ai.usage.cache_read.input_tokens');
  const cacheWrite = numberAttribute(root, 'gen_ai.usage.cache_write.input_tokens');
  const toolUse = numberAttribute(root, 'theorem.usage.tool_use.input_tokens');
  const costUsd = numberAttribute(root, 'theorem.usage.cost_usd');
  const estimated = root.attributes['theorem.usage.estimated'];
  const tokens: TurnTokens = {
    input,
    output,
    total: input + output,
    ...(thinking === undefined ? {} : { thinking }),
    ...(cached === undefined ? {} : { cached }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(costUsd === undefined ? {} : { cost: { usd: costUsd } }),
    ...(Array.isArray(estimated)
      ? {
          estimated: estimated.flatMap((side) =>
            side === 'input' || side === 'output' ? [side] : [],
          ),
        }
      : {}),
  };
  return costUsd === undefined ? { tokens } : { tokens, costUsd };
}

/**
 * What the host received. A turn's root carries `gen_ai.output.messages`; a
 * Live session's root carries none, and each response span carries its own
 * `theorem.output.delivered`, taken in start order.
 */
function deliveredOf(root: TraceSpan, spans: TraceSpan[]): TrialMessage[] {
  const own = root.attributes['gen_ai.output.messages'];
  if (isMessageList(own)) return own;
  return spans
    .filter((span) => 'theorem.request.live' in span.attributes)
    .flatMap((span) => {
      const delivered = span.attributes['theorem.output.delivered'];
      return isMessageList(delivered) ? delivered : [];
    });
}

/** Build the trial every grader receives from the records that share one trace. */
function buildTrial(args: {
  suite: string;
  case?: EvalCase;
  index: number;
  records: TraceRecord[];
}): Trial {
  const merged = mergedRecord(args.records);
  const spans = allSpans(args.records);
  const root = rootOf(spans);
  return {
    suite: args.suite,
    ...(args.case ? { case: args.case } : {}),
    index: args.index,
    records: args.records,
    root,
    spans: (operation: TraceOperation) => spans.filter((span) => operationOf(span) === operation),
    children: (parent: TraceSpan) => spans.filter((span) => span.parentSpanId === parent.spanId),
    content: (value: unknown) => inlineContent(merged, value),
    text: (value: unknown) => (isObject(value) ? contentOf(merged, value) : undefined),
    delivered: () => deliveredOf(root, spans),
    usage: () => usageOf(root),
  };
}

/** Group records by trace id, in first-seen order. */
function groupByTrace(records: TraceRecord[]): Map<string, TraceRecord[]> {
  const groups = new Map<string, TraceRecord[]>();
  for (const record of records) {
    const traceId = record.spans[0]?.traceId;
    if (traceId === undefined) continue;
    const group = groups.get(traceId);
    if (group) group.push(record);
    else groups.set(traceId, [record]);
  }
  return groups;
}

/** Whether these records hold a turn at all: an `invoke_agent` span. An eval run record does not. */
function hasTurn(records: readonly TraceRecord[]): boolean {
  return records.some((record) =>
    record.spans.some((span) => operationOf(span) === 'invoke_agent'),
  );
}

export { buildTrial, groupByTrace, hasTurn };
