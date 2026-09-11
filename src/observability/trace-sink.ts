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

/** Minimal async destination for completed turn trace records. */
export interface TraceSink {
  write: (record: TraceRecord) => Promise<void>;
  /**
   * Optional host hook when `writeTrace` catches record-build or write failures.
   * Must not throw; tracing never fails the turn.
   */
  onError?: (err: unknown) => void;
}
