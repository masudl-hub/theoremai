/**
 * The kernel copies request metadata into every record, so one router `sink` hands each record
 * to the run that wrote it. Recording, sampling and scrubbing stay the profile's observability
 * policy: a record the policy does not write never reaches the router.
 */

import type { TraceRecord } from '../src/observability/trace-record.ts';
import type { TraceSink } from '../src/observability/trace-sink.ts';

export const PLAYGROUND_RUN_METADATA_KEY = 'playgroundRun';

/** A trace record on the playground's run stream (NDJSON line or Live socket message). */
export type PlaygroundTraceLine = { type: 'trace'; record: TraceRecord };

/** One run's route: pass `metadata` on its request, `close` when the run ends. */
export interface PlaygroundTraceRoute {
  metadata: Record<string, string>;
  close(): void;
}

export interface PlaygroundTraceRouter {
  /** Register for `PLAYGROUND_TRACE_DESTINATION`. */
  sink: TraceSink;
  /** Open a route; `onRecord` receives each record the run writes while it is open. */
  route(onRecord: (record: TraceRecord) => void): PlaygroundTraceRoute;
}

export function createPlaygroundTraceRouter(): PlaygroundTraceRouter {
  const routes = new Map<string, (record: TraceRecord) => void>();
  return {
    sink: {
      write: (record) => {
        const run = record.metadata?.[PLAYGROUND_RUN_METADATA_KEY];
        if (typeof run === 'string') routes.get(run)?.(record);
        return Promise.resolve();
      },
    },
    route(onRecord) {
      const run = globalThis.crypto.randomUUID();
      routes.set(run, onRecord);
      return {
        metadata: { [PLAYGROUND_RUN_METADATA_KEY]: run },
        close: () => {
          routes.delete(run);
        },
      };
    },
  };
}
