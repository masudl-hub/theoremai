/**
 * Trace sink contract.
 *
 * Type-only so hosts that consume kernel types under a non-Deno TypeScript
 * program (browser bundles, Workers) never pull the JSONL file sink and its
 * `Deno` calls into their type graph. Implementations live in `trace.ts`.
 *
 * @module
 */

import type { TraceRecord } from './trace-record.ts';

/**
 * Storage policy for one record, resolved from the observability policy of the
 * profile that wrote it. Every destination receives it, so a host store reads
 * the same setting the JSONL writer does.
 */
export interface TraceWriteContext {
  /** Days to keep the record from now; `<= 0` keeps it forever. */
  retainForDays: number;
}

/** Minimal async destination for completed trace records. */
export interface TraceSink {
  write: (record: TraceRecord, context: TraceWriteContext) => Promise<void>;
  /**
   * Optional host hook when `writeTrace` catches record-build or write failures.
   * Must not throw; tracing never fails the turn.
   */
  onError?: (err: unknown) => void;
}
