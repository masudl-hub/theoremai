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

import type { TraceRecord } from './trace-record.ts';
import type { TraceSink } from './trace-sink.ts';

const DEFAULT_RETAIN_DAYS = 14;
const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const KIB = 1024;
const MIB = KIB * KIB;
const DEFAULT_ROTATE_MIB = 32;
const FILE_DAY = /^turns-(\d{4}-\d{2}-\d{2})(?:-\d+)?\.jsonl$/;

/** Options for daily rotating JSONL sinks. */
interface JsonlSinkOptions {
  retainForDays?: number;
  rotateAfterMiB?: number;
  now?: () => number;
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

async function pruneTraces(dir: string, now: number, retainForDays: number): Promise<void> {
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
 * Trace sink that writes daily rotating JSONL files under a host-selected directory.
 *
 * @param dir - Absolute host-chosen directory
 * @param optionsOrNow - Retention/rotate options, or a `now` clock (legacy)
 */
function jsonlSink(dir: string, optionsOrNow?: JsonlSinkOptions | (() => number)): TraceSink {
  const options: JsonlSinkOptions =
    typeof optionsOrNow === 'function' ? { now: optionsOrNow } : (optionsOrNow ?? {});
  const now = options.now ?? Date.now;
  const retainForDays = options.retainForDays ?? DEFAULT_RETAIN_DAYS;
  const rotateBytes = (options.rotateAfterMiB ?? DEFAULT_ROTATE_MIB) * MIB;
  return {
    write: async (record) => {
      const at = now();
      await Deno.mkdir(dir, { recursive: true });
      await pruneTraces(dir, at, retainForDays);
      const path = await pickFile(dir, at, rotateBytes);
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

export type { JsonlSinkOptions };
export { jsonlSink, memorySink, noopSink, resolveTraceDir, sinkFromDir, writeTrace };
