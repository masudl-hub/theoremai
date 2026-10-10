/**
 * A run's trace, sent to the page behind the run's own events, as the playground sends a draft's.
 * A run made in the studio is a test, so its records go to the page and stay out of the store the
 * profile writes to. A profile that records nothing sends nothing, and what the profile keeps
 * private stays out, as in any trace.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { type Profile, registerTraceDestination, resolveObservabilityPolicy, type TraceRecord } from '../../mod.ts';
import { eachLine, NDJSON, type SendLine } from '../stream-lines.ts';
import type { StudioTraceLine } from '../traces.ts';

/** Where a profile served by the studio writes its records. */
export const STUDIO_RUN_TRACES = 'theorem-studio-run';

/** The records of the run in progress. The kernel writes a record inside the run that made it. */
const runs = new AsyncLocalStorage<TraceRecord[]>();

/** The profile as the studio serves it: one that records writes to the run it is in. */
export function tracedToPage<P extends Profile>(profile: P): P {
  if (!resolveObservabilityPolicy(profile.observability).record) return profile;
  registerTraceDestination(STUDIO_RUN_TRACES, {
    write: (record) => {
      runs.getStore()?.push(record);
      return Promise.resolve();
    },
  });
  return { ...profile, observability: { ...profile.observability, writeTo: STUDIO_RUN_TRACES } };
}

/** Whether a line of the stream is the failure that ends it. */
function isFailure(line: string): boolean {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'error';
  } catch {
    return false;
  }
}

/**
 * Passes a run's lines through and adds its records as the stream ends. The kernel writes a run's
 * records before the run returns or throws, and a page stops reading at a failure, so the records
 * go ahead of the failure that ends the stream.
 */
function recordsBeforeEnd(records: readonly TraceRecord[]): TransformStream<Uint8Array, Uint8Array> {
  let failure: string | undefined;
  /** A failure is held until the next line shows it did not end the stream. */
  const release = (send: SendLine) => {
    if (failure !== undefined) send(failure);
    failure = undefined;
  };
  return eachLine(
    (line, send) => {
      release(send);
      if (isFailure(line)) failure = line;
      else send(line);
    },
    (send) => {
      for (const record of records) {
        const line: StudioTraceLine = { type: 'trace', record };
        send(JSON.stringify(line));
      }
      release(send);
    },
  );
}

/** Serves a profile with each run's records sent behind its events. */
export function withRunTraces(
  serve: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const records: TraceRecord[] = [];
    const response = await runs.run(records, () => serve(request));
    if (!response.body || !response.headers.get('content-type')?.startsWith(NDJSON)) return response;
    return new Response(response.body.pipeThrough(recordsBeforeEnd(records)), {
      status: response.status,
      headers: response.headers,
    });
  };
}
