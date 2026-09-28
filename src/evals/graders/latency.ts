/**
 * Turn latency: how long the person waited between finishing their input and
 * the first chunk of the reply. Read from the trace alone, for every reply in
 * the trial.
 *
 * - A turn: from the turn's start (the host handed over the input) to the
 *   first chunk of the first model call, through guardrails, history and
 *   any retried HTTP try (a buffered body is its one chunk).
 *   `budget.maxTimeToFirstChunkMs` is the provider's share of that; this is
 *   the person's whole wait.
 * - A Live response: from the end of the person's speech (the provider's last
 *   `ACTIVITY_END` before the reply) when the session carries voice activity,
 *   else from the response's first input frame, to the response's first chunk.
 *
 * @module
 */

import type { TraceSpan } from '../../observability/trace-span.ts';
import type { EvalGrader, Trial } from '../types.ts';
import { codeGrader, passFail } from './shared.ts';

const MS_PER_S = 1000;
const NANOS_PER_MS = 1_000_000n;
const ACTIVITY_END = 'ACTIVITY_END';

/** One reply's wait, in whole milliseconds, or why the trace cannot show it. */
interface LatencyReading {
  span: TraceSpan;
  ms?: number;
  missing?: 'first chunk not recorded';
}

function msBetween(fromUnixNano: bigint, toUnixNano: bigint): number {
  return Number((toUnixNano - fromUnixNano) / NANOS_PER_MS);
}

function numberAttribute(span: TraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * When the reply's first chunk arrived: the successful (last) HTTP try's start
 * plus its time to first chunk, or the call's own start plus its time to first
 * chunk when the call streamed over a socket (Live).
 */
function firstChunkAt(trial: Trial, call: TraceSpan): bigint | undefined {
  const seconds = numberAttribute(call, 'gen_ai.response.time_to_first_chunk');
  if (seconds === undefined) return undefined;
  const tries = trial.children(call).filter((span) => 'http.request.method' in span.attributes);
  const from = tries.at(-1) ?? call;
  return BigInt(from.startTimeUnixNano) + BigInt(Math.round(seconds * MS_PER_S)) * NANOS_PER_MS;
}

/**
 * The latest moment the provider heard the person stop speaking within
 * `(afterUnixNano, beforeUnixNano]`: after the previous reply began, before
 * this reply's first chunk. Speech that prompted an earlier reply never
 * anchors a later one.
 */
function speechEndedAt(
  root: TraceSpan,
  afterUnixNano: bigint | undefined,
  beforeUnixNano: bigint,
): bigint | undefined {
  let latest: bigint | undefined;
  for (const event of root.events) {
    if (event.name !== 'theorem.session') continue;
    if (event.attributes.kind !== 'voice_activity' || event.attributes.activity !== ACTIVITY_END) {
      continue;
    }
    const at = BigInt(event.timeUnixNano);
    if (afterUnixNano !== undefined && at <= afterUnixNano) continue;
    if (at <= beforeUnixNano && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

function reading(span: TraceSpan, from: bigint, chunk: bigint | undefined): LatencyReading {
  if (chunk === undefined) return { span, missing: 'first chunk not recorded' };
  return { span, ms: msBetween(from, chunk) };
}

/** Every reply's wait: one for a turn, one per response for a Live session. */
function latencyReadings(trial: Trial): LatencyReading[] {
  const responses = trial.spans('generate_content');
  if (responses.length > 0) {
    return responses.map((response, index) => {
      const chunk = firstChunkAt(trial, response);
      const start = BigInt(response.startTimeUnixNano);
      const previous = responses[index - 1];
      const after = previous ? BigInt(previous.startTimeUnixNano) : undefined;
      const from = chunk === undefined ? start : (speechEndedAt(trial.root, after, chunk) ?? start);
      return reading(response, from, chunk);
    });
  }
  const [firstCall] = trial.spans('chat');
  if (!firstCall) return [];
  return [
    reading(trial.root, BigInt(trial.root.startTimeUnixNano), firstChunkAt(trial, firstCall)),
  ];
}

/**
 * Every reply began within `maxMs` of the person finishing their input. A
 * reply whose first chunk the trace did not record fails, since the wait
 * cannot be shown; a trial with no model call fails the same way.
 */
function turnLatency(options: { maxMs: number }): EvalGrader {
  return codeGrader('turn_latency', `turnLatency:${options.maxMs}`, false, (trial) => {
    const readings = latencyReadings(trial);
    if (readings.length === 0) return passFail('turn_latency', false, 'no model call recorded');
    const over = readings.flatMap((entry, index) => {
      const name = readings.length === 1 ? 'reply' : `reply ${index + 1}`;
      if (entry.ms === undefined) return [`${name}: ${entry.missing}`];
      return entry.ms > options.maxMs ? [`${name}: ${entry.ms} ms over ${options.maxMs}`] : [];
    });
    const measured = readings.flatMap((entry) => entry.ms ?? []);
    const summary =
      measured.length === 1
        ? `reply began after ${measured[0]} ms`
        : `${measured.length} replies began within ${Math.max(...measured)} ms`;
    const passed = over.length === 0;
    return passFail('turn_latency', passed, passed ? summary : over.join('; '));
  });
}

export { turnLatency };
