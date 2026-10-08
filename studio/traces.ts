/**
 * The kernel copies request metadata into every record, so one router `sink` hands each record
 * to the run that wrote it. Recording, sampling and scrubbing stay the profile's observability
 * policy: a record the policy does not write never reaches the router.
 */

import type { TraceRecord } from '../src/observability/trace-record.ts';
import type { TraceSink } from '../src/observability/trace-sink.ts';

export const STUDIO_RUN_METADATA_KEY = 'studioRun';

/** A trace record on the studio's run stream (NDJSON line or Live socket message). */
export type StudioTraceLine = { type: 'trace'; record: TraceRecord };

/** One run's route: pass `metadata` on its request, `close` when the run ends. */
export interface StudioTraceRoute {
  metadata: Record<string, string>;
  close(): void;
}

export interface StudioTraceRouter {
  /** Register for `STUDIO_TRACE_DESTINATION`. */
  sink: TraceSink;
  /** Open a route; `onRecord` receives each record the run writes while it is open. */
  route(onRecord: (record: TraceRecord) => void): StudioTraceRoute;
}

export function createStudioTraceRouter(): StudioTraceRouter {
  const routes = new Map<string, (record: TraceRecord) => void>();
  return {
    sink: {
      write: (record) => {
        const run = record.metadata?.[STUDIO_RUN_METADATA_KEY];
        if (typeof run === 'string') routes.get(run)?.(record);
        return Promise.resolve();
      },
    },
    route(onRecord) {
      const run = globalThis.crypto.randomUUID();
      routes.set(run, onRecord);
      return {
        metadata: { [STUDIO_RUN_METADATA_KEY]: run },
        close: () => {
          routes.delete(run);
        },
      };
    },
  };
}
