// Type-only so programs that never write files (browser bundles, Workers) never pull the JSONL
// file sink into their module graph.

import type { TraceRecord } from './trace-record.ts';

/** Every destination receives it, so a host store reads the storage policy the JSONL writer does. */
export interface TraceWriteContext {
  /** Days to keep the record from now; `<= 0` keeps it forever. */
  retainForDays: number;
  /** Size at which a file-based destination starts a new file. */
  rotateAfterMiB: number;
}

/** Where trace records go: `write` takes each record, and `onError` is told when building or writing one failed. */
export interface TraceSink {
  write: (record: TraceRecord, context: TraceWriteContext) => Promise<void>;
  /** Called when `writeTrace` catches a build or write failure. Must not throw. */
  onError?: (err: unknown) => void;
}
