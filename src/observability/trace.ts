/**
 * Trace sink primitives for THEORUM.
 *
 * Tracing is host-injected: the kernel can write to a provided sink, a memory
 * sink, a JSONL directory, or a noop sink. It does not read environment
 * variables or own a database destination.
 *
 * @module
 */

import type { TraceRecord } from './trace-record.ts';

const RETAIN_DAYS = 14;
const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const RETAIN_MS = RETAIN_DAYS * HOURS_PER_DAY * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
const KIB = 1024;
const MIB = KIB * KIB;
const ROTATE_MIB = 32;
const ROTATE_BYTES = ROTATE_MIB * MIB;
const FILE_DAY = /^turns-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/;

/** Minimal async destination for completed turn trace records. */
interface TraceSink {
  write: (record: TraceRecord) => Promise<void>;
  /**
   * Optional host hook when `writeTrace` catches record-build or write failures.
   * Must not throw; tracing never fails the turn.
   */
  onError?: (err: unknown) => void;
}

/**
 * Write a trace record without allowing trace failures to fail the turn.
 * Build/write errors are forwarded to `sink.onError` when provided.
 */
async function writeTrace(sink: TraceSink, record: Promise<TraceRecord>): Promise<void> {
  try {
    await sink.write(await record);
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

async function pruneTraces(dir: string, now: number): Promise<void> {
  const cutoff = now - RETAIN_MS;
  for await (const entry of Deno.readDir(dir)) {
    const day = fileDay(entry.name);
    if (day && Date.parse(`${day}T00:00:00.000Z`) < cutoff) {
      await Deno.remove(`${dir}/${entry.name}`);
    }
  }
}

async function pickFile(dir: string, now: number): Promise<string> {
  const day = dayStamp(now);
  const base = `${dir}/turns-${day}.jsonl`;
  try {
    const info = await Deno.stat(base);
    if ((info.size ?? 0) < ROTATE_BYTES) {
      return base;
    }
  } catch {
    return base;
  }
  return `${dir}/turns-${day}-${now}.jsonl`;
}

/** Trace sink that writes daily rotating JSONL files under a host-selected directory. */
function jsonlSink(dir: string, now: () => number = Date.now): TraceSink {
  return {
    write: async (record) => {
      const at = now();
      await Deno.mkdir(dir, { recursive: true });
      await pruneTraces(dir, at);
      const path = await pickFile(dir, at);
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

/** Resolve a trace directory while refusing relative paths or paths inside the clone. */
function resolveTraceDir(args: {
  dir?: string;
  fallbackDir?: string;
  cwd?: string;
}): string | undefined {
  const cwd = args.cwd ?? Deno.cwd();
  if (args.dir === '') {
    return undefined;
  }
  let dir = args.dir?.trim() || args.fallbackDir;
  if (!dir) {
    return undefined;
  }
  if (!dir.startsWith('/') || insideDir(dir, cwd)) {
    dir = args.fallbackDir;
  }
  if (!dir || insideDir(dir, cwd)) {
    return undefined;
  }
  return dir;
}

/** Build a JSONL sink from a host-supplied directory or return a noop sink. */
function sinkFromDir(dir?: string, fallbackDir?: string): TraceSink {
  const resolved = resolveTraceDir({ dir, fallbackDir });
  if (!resolved) {
    return noopSink();
  }
  return jsonlSink(resolved);
}

export type { TraceSink };
export { jsonlSink, memorySink, noopSink, resolveTraceDir, sinkFromDir, writeTrace };
