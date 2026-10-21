import type { TraceRecord } from '@theoremjs/agents';
import type { TraceFeed } from '@theoremjs/web/client';
import { type ClientFailure, clientFailure, failedTraces } from '@theoremjs/web/client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** A profile that answers in one call: a decision or an embedding. */
export type OneCallTransport = { traces?: TraceFeed };

/** The last call's state: its result is kept while the next one runs and when it fails. */
export type OneCallState<Busy extends string, Result> = {
  status: 'idle' | Busy | 'done' | 'error';
  result: Result | null;
  /** How long the last call took, round trip, in milliseconds. */
  elapsedMs: number | null;
  /** When the call now running began, as `Date.now()`; null while none runs. */
  startedAt: number | null;
  failure: ClientFailure | null;
};

const IDLE = {
  status: 'idle',
  result: null,
  elapsedMs: null,
  startedAt: null,
  failure: null,
} as const;

/** Hands a call's trace records to the transport's feed, when it has one. */
function feed(transport: OneCallTransport, records: readonly TraceRecord[] | undefined): void {
  for (const record of records ?? []) transport.traces?.push(record);
}

/**
 * One call at a time to `transport`, through `send`: a new call aborts the one
 * still running, and the last result stays on screen while the next one runs.
 * A new transport (a recompiled profile) keeps the result and any call still
 * running, as a chat keeps its transcript; give the component a new `key` to
 * start over. `send` must not change between renders.
 */
export function useOneCall<
  T extends OneCallTransport,
  Busy extends string,
  Args extends unknown[],
  Result,
>(
  transport: T,
  busy: Busy,
  send: (
    transport: T,
    signal: AbortSignal,
    ...args: Args
  ) => Promise<{ result: Result; traces?: readonly TraceRecord[] }>,
): OneCallState<Busy, Result> & { call: (...args: Args) => Promise<void>; cancel: () => void } {
  const [run, setRun] = useState<OneCallState<Busy, Result>>(IDLE);
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setRun((previous) =>
      previous.status === busy
        ? { ...previous, status: previous.result ? 'done' : 'idle', startedAt: null }
        : previous,
    );
  }, [busy]);

  const call = useCallback(
    async (...args: Args) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setRun((previous) => ({
        status: busy,
        result: previous.result,
        elapsedMs: previous.elapsedMs,
        startedAt: Date.now(),
        failure: null,
      }));
      const started = performance.now();
      try {
        const reply = await send(transport, controller.signal, ...args);
        if (controller.signal.aborted) return;
        feed(transport, reply.traces);
        setRun({
          status: 'done',
          result: reply.result,
          elapsedMs: performance.now() - started,
          startedAt: null,
          failure: null,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        feed(transport, failedTraces(err));
        setRun((previous) => ({
          ...previous,
          status: 'error',
          startedAt: null,
          failure: clientFailure(err),
        }));
      } finally {
        if (running.current === controller) running.current = null;
      }
    },
    [transport, busy, send],
  );

  return { ...run, call, cancel };
}
