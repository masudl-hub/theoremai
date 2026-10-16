import type { DecisionJson, DecisionResult } from '@theoremjs/agents';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DecisionInterface,
  type DecisionReply,
  type DecisionTransport,
  failedDecisionTraces,
} from '../client/decision-transport.ts';
import { type ClientFailure, clientFailure } from '../client/failure.ts';
import { useDescribed } from './use-described.ts';

export type TheoremDecisionState = {
  /** The profile as the page sees it; null until the host describes it. */
  iface: DecisionInterface | null;
  /** Why the host could not describe the profile. */
  describeFailure: ClientFailure | null;
  status: 'idle' | 'deciding' | 'done' | 'error';
  /** The last answers; kept while the next decision runs and when it fails. */
  result: DecisionResult | null;
  /** How long the last decision took, round trip, in milliseconds. */
  elapsedMs: number | null;
  failure: ClientFailure | null;
};

/**
 * One decision profile: describe it once, then `decide(state)` as often as
 * needed. A new decision aborts the one still running.
 */
type DecisionRun = Pick<TheoremDecisionState, 'status' | 'result' | 'elapsedMs' | 'failure'> & {
  transport: DecisionTransport;
};

/** A decision starting: the last answer stays on screen while the same host decides again. */
function deciding(previous: DecisionRun, transport: DecisionTransport): DecisionRun {
  const kept = previous.transport === transport ? previous : { result: null, elapsedMs: null };
  return {
    transport,
    status: 'deciding',
    result: kept.result,
    elapsedMs: kept.elapsedMs,
    failure: null,
  };
}

/** Hands a decision's trace records to the transport's feed, when it has one. */
function feed(transport: DecisionTransport, records: Readonly<DecisionReply['traces']>): void {
  for (const record of records ?? []) transport.traces?.push(record);
}

export function useTheoremDecision(transport: DecisionTransport): TheoremDecisionState & {
  decide: (state: Exclude<DecisionJson, null>) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const [run, setRun] = useState<DecisionRun>({
    transport,
    status: 'idle',
    result: null,
    elapsedMs: null,
    failure: null,
  });
  const running = useRef<AbortController | null>(null);

  const runningFor = useRef<DecisionTransport | null>(null);

  useEffect(() => {
    if (runningFor.current !== transport) running.current?.abort();
  }, [transport]);

  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setRun((previous) =>
      previous.status === 'deciding'
        ? { ...previous, status: previous.result ? 'done' : 'idle' }
        : previous,
    );
  }, []);

  const decide = useCallback(
    async (state: Exclude<DecisionJson, null>) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      runningFor.current = transport;
      setRun((previous) => deciding(previous, transport));
      const started = performance.now();
      try {
        const reply = await transport.decide(state, controller.signal);
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
        feed(transport, failedDecisionTraces(err));
        setRun((previous) => ({ ...previous, status: 'error', failure: clientFailure(err) }));
      } finally {
        if (running.current === controller) running.current = null;
      }
    },
    [transport],
  );

  const visible =
    run.transport === transport
      ? run
      : { status: 'idle' as const, result: null, elapsedMs: null, failure: null };
  return {
    iface,
    describeFailure,
    status: visible.status,
    result: visible.result,
    elapsedMs: visible.elapsedMs,
    failure: visible.failure,
    decide,
    cancel,
  };
}
