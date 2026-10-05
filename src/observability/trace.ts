// invariant: Tracing is host-injected: THEOREM reads no environment variables and owns no database sink.

import { buildRecord, type TraceRecord } from './trace-record.ts';
import type { TraceSink } from './trace-sink.ts';
import type { TraceSpan } from './trace-span.ts';
import type { ResolvedObservabilityPolicy } from './types.ts';

/** Trace failures never fail the turn: build and write errors go to `sink.onError`, if set. */
async function writeTrace(
  sink: TraceSink,
  record: Promise<TraceRecord>,
  policy: ResolvedObservabilityPolicy,
): Promise<void> {
  try {
    await sink.write(await record, {
      retainForDays: policy.retainForDays,
      rotateAfterMiB: policy.rotateAfterMiB,
    });
  } catch (err) {
    try {
      sink.onError?.(err);
    } catch {
      // why: Host onError must not fail the turn.
    }
  }
}

/** Like `writeTrace`, it never fails the caller. */
function writeSpans(
  sink: TraceSink,
  spans: TraceSpan[],
  policy: ResolvedObservabilityPolicy,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return writeTrace(
    sink,
    buildRecord({ spans, policy, ...(metadata ? { metadata } : {}) }),
    policy,
  );
}

/** A sink that discards every record. */
function noopSink(): TraceSink {
  return { write: () => Promise.resolve() };
}

/** A sink that appends each trace record to the given array. */
function memorySink(into: TraceRecord[]): TraceSink {
  return {
    write: (record) => {
      into.push(record);
      return Promise.resolve();
    },
  };
}

export { memorySink, noopSink, writeSpans, writeTrace };
