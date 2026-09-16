/**
 * Host cutout-trace helpers for apps that mint a final audit row after an
 * upstream side effect (for example image cutout).
 *
 * Prefer importing from `theorum/host`.
 *
 * @module
 */

import { publicError, UPSTREAM_FAILED } from '../guardrails/error.ts';
import { noopSink, writeTrace } from '../observability/trace.ts';
import type { TraceRecord } from '../observability/trace-record.ts';
import type { TraceSink } from '../observability/trace-sink.ts';

interface CutoutTape {
  ok: boolean;
  ms: number;
  url?: string;
  inSha256?: string;
  outSha256?: string;
  http?: unknown;
  error?: string;
}

function attachMint(row: TraceRecord, app: Record<string, unknown>, cutout: CutoutTape): void {
  row.app = app;
  row.cutout = cutout;
  row.ms = Date.now() - row.ts;
  if (!cutout.ok) {
    row.ok = false;
    const { error: cutoutError } = cutout;
    let error = cutoutError;
    if (!error) {
      error = publicError(UPSTREAM_FAILED);
    }
    row.error = error;
  }
}

async function flushMintTrace(args: {
  held: TraceRecord[];
  app: Record<string, unknown>;
  cutout: CutoutTape;
  sink?: TraceSink;
}): Promise<void> {
  const [row] = args.held;
  if (!row) {
    return;
  }
  attachMint(row, args.app, args.cutout);
  await writeTrace(args.sink ?? noopSink(), Promise.resolve(row));
}

export type { CutoutTape };
export { flushMintTrace };
