import type { TraceSpan } from '../../observability/trace-span.ts';
import type { EvalGrader, Trial } from '../types.ts';
import { codeGrader, passFail } from './shared.ts';

const MS_PER_S = 1000;
const NANOS_PER_MS = 1_000_000n;
const ACTIVITY_END = 'ACTIVITY_END';

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

// The successful (last) HTTP try's start plus its time to first chunk, or the call's own start when the call streamed over a socket (Live).
function firstChunkAt(trial: Trial, call: TraceSpan): bigint | undefined {
  const seconds = numberAttribute(call, 'gen_ai.response.time_to_first_chunk');
  if (seconds === undefined) return undefined;
  const tries = trial.children(call).filter((span) => 'http.request.method' in span.attributes);
  const from = tries.at(-1) ?? call;
  return BigInt(from.startTimeUnixNano) + BigInt(Math.round(seconds * MS_PER_S)) * NANOS_PER_MS;
}

// Speech that prompted an earlier reply never anchors a later one.
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

/** A grader that passes when each reply began within `maxMs`, measured from the start of the response or, for a live reply, from the end of the user's speech; a reply with no reading fails it. */
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
