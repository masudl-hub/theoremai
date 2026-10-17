import type { TraceRecord } from '@theoremjs/agents';
import { useCallback, useEffect, useRef, useState } from 'react';
import { failedTraces } from '../client/decision-transport.ts';
import { type ClientFailure, clientFailure } from '../client/failure.ts';
import type { TraceFeed } from '../client/trace-feed.ts';

/** A profile that answers in one call: a decision or an embedding. */
export type OneCallTransport = { traces?: TraceFeed };

/** The last call's state: its result is kept while the next one runs and when it fails. */
export type OneCallState<Busy extends string, Result> = {
  status: 'idle' | Busy | 'done' | 'error';
  result: Result | null;
  /** How long the last call took, round trip, in milliseconds. */
  elapsedMs: number | null;
  failure: ClientFailure | null;
};

type Run<T, Busy extends string, Result> = OneCallState<Busy, Result> & { transport: T };

const IDLE = { status: 'idle', result: null, elapsedMs: null, failure: null } as const;

/** Hands a call's trace records to the transport's feed, when it has one. */
function feed(transport: OneCallTransport, records: readonly TraceRecord[] | undefined): void {
  for (const record of records ?? []) transport.traces?.push(record);
}

/**
 * One call at a time to `transport`, through `send`: a new call aborts the one
 * still running, and the last result stays on screen while the same host
 * answers again. `send` must not change between renders.
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
  const [run, setRun] = useState<Run<T, Busy, Result>>({ transport, ...IDLE });
  const running = useRef<AbortController | null>(null);
  const runningFor = useRef<T | null>(null);

  useEffect(() => {
    if (runningFor.current !== transport) running.current?.abort();
  }, [transport]);

  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setRun((previous) =>
      previous.status === busy
        ? { ...previous, status: previous.result ? 'done' : 'idle' }
        : previous,
    );
  }, [busy]);

  const call = useCallback(
    async (...args: Args) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      runningFor.current = transport;
      setRun((previous) => {
        const kept = previous.transport === transport ? previous : IDLE;
        return {
          transport,
          status: busy,
          result: kept.result,
          elapsedMs: kept.elapsedMs,
          failure: null,
        };
      });
      const started = performance.now();
      try {
        const reply = await send(transport, controller.signal, ...args);
        if (controller.signal.aborted) return;
        feed(transport, reply.traces);
        setRun({
          transport,
          status: 'done',
          result: reply.result,
          elapsedMs: performance.now() - started,
          failure: null,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        feed(transport, failedTraces(err));
        setRun((previous) => ({ ...previous, status: 'error', failure: clientFailure(err) }));
      } finally {
        if (running.current === controller) running.current = null;
      }
    },
    [transport, busy, send],
  );

  const { status, result, elapsedMs, failure } = run.transport === transport ? run : IDLE;
  return { status, result, elapsedMs, failure, call, cancel };
}
