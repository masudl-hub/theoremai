import type { EmbeddingInput, EmbeddingResult } from '@theoremjs/agents';
import { useCallback, useEffect, useRef, useState } from 'react';
import { failedTraces } from '../client/decision-transport.ts';
import type {
  EmbeddingInterface,
  EmbeddingReply,
  EmbeddingTransport,
} from '../client/embedding-transport.ts';
import { type ClientFailure, clientFailure } from '../client/failure.ts';
import { useDescribed } from './use-described.ts';

export type TheoremEmbeddingState = {
  /** The profile as the page sees it; null until the host describes it. */
  iface: EmbeddingInterface | null;
  /** Why the host could not describe the profile. */
  describeFailure: ClientFailure | null;
  status: 'idle' | 'embedding' | 'done' | 'error';
  /** The last vectors; kept while the next embedding runs and when it fails. */
  result: EmbeddingResult | null;
  /** How long the last embedding took, round trip, in milliseconds. */
  elapsedMs: number | null;
  failure: ClientFailure | null;
};

/**
 * One embedding profile: describe it once, then `embed(inputs)` as often as
 * needed. A new embedding aborts the one still running.
 */
type EmbeddingRun = Pick<TheoremEmbeddingState, 'status' | 'result' | 'elapsedMs' | 'failure'> & {
  transport: EmbeddingTransport;
};

/** An embedding starting: the last vectors stay on screen while the same host embeds again. */
function embedding(previous: EmbeddingRun, transport: EmbeddingTransport): EmbeddingRun {
  const kept = previous.transport === transport ? previous : { result: null, elapsedMs: null };
  return {
    transport,
    status: 'embedding',
    result: kept.result,
    elapsedMs: kept.elapsedMs,
    failure: null,
  };
}

/** Hands an embedding's trace records to the transport's feed, when it has one. */
function feed(transport: EmbeddingTransport, records: Readonly<EmbeddingReply['traces']>): void {
  for (const record of records ?? []) transport.traces?.push(record);
}

export function useTheoremEmbedding(transport: EmbeddingTransport): TheoremEmbeddingState & {
  embed: (inputs: readonly EmbeddingInput[], model?: string) => Promise<void>;
  cancel: () => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const [run, setRun] = useState<EmbeddingRun>({
    transport,
    status: 'idle',
    result: null,
    elapsedMs: null,
    failure: null,
  });
  const running = useRef<AbortController | null>(null);

  const runningFor = useRef<EmbeddingTransport | null>(null);

  useEffect(() => {
    if (runningFor.current !== transport) running.current?.abort();
  }, [transport]);

  useEffect(() => () => running.current?.abort(), []);

  const cancel = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setRun((previous) =>
      previous.status === 'embedding'
        ? { ...previous, status: previous.result ? 'done' : 'idle' }
        : previous,
    );
  }, []);

  const embed = useCallback(
    async (inputs: readonly EmbeddingInput[], model?: string) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      runningFor.current = transport;
      setRun((previous) => embedding(previous, transport));
      const started = performance.now();
      try {
        const reply = await transport.embed(inputs, model, controller.signal);
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
    embed,
    cancel,
  };
}
