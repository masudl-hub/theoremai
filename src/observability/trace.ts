/**
 * Trace sink primitives for THEOREM.
 *
 * Tracing is host-injected: the kernel can write to a provided sink, a memory
 * sink, a JSONL directory, or a noop sink. Profiles declare policy via
 * `observability`; hosts register named destinations. THEOREM does not read
 * environment variables or own a database destination.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import { DEFAULT_ROTATE_MIB } from './resolve-policy.ts';
import type { TraceRecord } from './trace-record.ts';
import type { TraceSink } from './trace-sink.ts';
import type { ResolvedObservabilityPolicy } from './types.ts';

const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const KIB = 1024;
const MIB = KIB * KIB;
const FILE_DAY = /^turns-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/;

/**
 * Options for daily rotating JSONL sinks. Retention is not here: it arrives
 * with each write (`TraceWriteContext`), from the profile that wrote the record.
 */
interface JsonlSinkOptions {
  rotateAfterMiB?: number;
  now?: () => number;
}

/**
 * Write a trace record under the policy it was built with, without allowing
 * trace failures to fail the turn. Build/write errors are forwarded to
 * `sink.onError` when provided.
 */
async function writeTrace(
  sink: TraceSink,
  record: Promise<TraceRecord>,
  policy: ResolvedObservabilityPolicy,
): Promise<void> {
  try {
    await sink.write(await record, { retainForDays: policy.retainForDays });
  } catch (err) {
    try {
      sink.onError?.(err);
    } catch {
      // Host onError must not fail the turn.
    }
  }
}

/** Trace sink that drops records. */
function noopSink(): TraceSink {
  return { write: () => Promise.resolve() };
}

/** Trace sink that appends records to a caller-owned array. */
function memorySink(into: TraceRecord[]): TraceSink {
  return {
    write: (record) => {
      into.push(record);
      return Promise.resolve();
    },
  };
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fileDay(name: string): string | undefined {
  return FILE_DAY.exec(name)?.[1];
}

/** Remove day files older than `retainForDays`; `<= 0` keeps every file. */
async function pruneTraces(dir: string, now: number, retainForDays: number): Promise<void> {
  if (retainForDays <= 0) {
    return;
  }
  const retainMs = retainForDays * HOURS_PER_DAY * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
  const cutoff = now - retainMs;
  for await (const entry of Deno.readDir(dir)) {
    const day = fileDay(entry.name);
    if (day && Date.parse(`${day}T00:00:00.000Z`) < cutoff) {
      await Deno.remove(`${dir}/${entry.name}`);
    }
  }
}

async function pickFile(dir: string, now: number, rotateBytes: number): Promise<string> {
  const day = dayStamp(now);
  const base = `${dir}/turns-${day}.jsonl`;
  try {
    const info = await Deno.stat(base);
    if ((info.size ?? 0) < rotateBytes) {
      return base;
    }
  } catch {
    return base;
  }
  return `${dir}/turns-${day}-${now}.jsonl`;
}

/**
 * Trace sink that writes daily rotating JSONL files under a host-selected
 * directory, and on each write removes day files older than the record's
 * retention (`<= 0` keeps every file).
 *
 * @param dir - Absolute host-chosen directory
 * @param options - Rotate size and a test clock
 */
function jsonlSink(dir: string, options: JsonlSinkOptions = {}): TraceSink {
  const safeDir = validateTraceDir(dir);
  const now = options.now ?? Date.now;
  const rotateBytes = (options.rotateAfterMiB ?? DEFAULT_ROTATE_MIB) * MIB;
  return {
    write: async (record, context) => {
      const at = now();
      await Deno.mkdir(safeDir, { recursive: true });
      await pruneTraces(safeDir, at, context.retainForDays);
      const path = await pickFile(safeDir, at, rotateBytes);
      await Deno.writeTextFile(path, `${JSON.stringify(record)}\n`, { append: true });
    },
  };
}

function insideDir(path: string, root: string): boolean {
  let base = root;
  if (root.endsWith('/')) {
    base = root.slice(0, -1);
  }
  if (path === base) {
    return true;
  }
  return path.startsWith(`${base}/`);
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new TheoremError('config', 'trace directory must be non-empty');
  }
  if (!trimmed.startsWith('/')) {
    throw new TheoremError('config', 'trace directory must be absolute');
  }
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Normalize and validate a trace directory before any filesystem operation. */
function validateTraceDir(dir: string): string {
  const normalized = normalizeAbsolutePath(dir);
  const normalizedCwd = normalizeAbsolutePath(Deno.cwd());
  if (insideDir(normalized, normalizedCwd)) {
    throw new TheoremError('config', 'trace directory must be outside the project checkout');
  }
  return normalized;
}

export type { JsonlSinkOptions };
export { jsonlSink, memorySink, noopSink, validateTraceDir, writeTrace };
