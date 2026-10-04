/**
 * The file trace sink: daily rotating JSONL under a host-chosen directory. Its own entry point, so
 * browser bundles and Workers never pull the filesystem into their module graph.
 *
 * @module
 */

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { cwd } from 'node:process';
import { TheoremError } from '../guardrails/error.ts';
import type { TraceSink } from './trace-sink.ts';

const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const SEC_PER_MIN = 60;
const MS_PER_SEC = 1000;
const KIB = 1024;
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const MIB = KIB * KIB;
const FILE_PART = /^turns-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.jsonl$/;

/** Retention and rotation are not here: they arrive with each write (`TraceWriteContext`) from the profile. */
export interface JsonlSinkOptions {
  now?: () => number;
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fileDay(name: string): string | undefined {
  return FILE_PART.exec(name)?.[1];
}

/** Remove day files older than `retainForDays`; `<= 0` keeps every file. */
async function pruneTraces(dir: string, now: number, retainForDays: number): Promise<void> {
  if (retainForDays <= 0) {
    return;
  }
  const retainMs = retainForDays * HOURS_PER_DAY * MIN_PER_HOUR * SEC_PER_MIN * MS_PER_SEC;
  const cutoff = now - retainMs;
  for (const name of await readdir(dir)) {
    const day = fileDay(name);
    if (day && Date.parse(`${day}T00:00:00.000Z`) < cutoff) {
      await rm(`${dir}/${name}`);
    }
  }
}

/** The day's newest file while it has room, else a new one stamped `now`. */
async function pickFile(dir: string, now: number, rotateBytes: number): Promise<string> {
  const day = dayStamp(now);
  const newest = (await readdir(dir))
    .map((name) => ({ name, part: FILE_PART.exec(name) }))
    .filter(({ part }) => part?.[1] === day)
    .map(({ name, part }) => ({ name, stamp: Number(part?.[2] ?? 0) }))
    .reduce<{ name: string; stamp: number } | undefined>(
      (latest, file) => (latest && latest.stamp >= file.stamp ? latest : file),
      undefined,
    );
  if (!newest) return `${dir}/turns-${day}.jsonl`;
  const path = `${dir}/${newest.name}`;
  return (await stat(path)).size < rotateBytes ? path : `${dir}/turns-${day}-${now}.jsonl`;
}

/**
 * Daily rotating JSONL files under an absolute, host-chosen `dir`. Each write removes day files
 * older than the record's retention (`<= 0` keeps every file) and appends to the day's newest file
 * until it reaches the profile's `rotateAfterMiB`, then starts another.
 */
export function jsonlSink(dir: string, options: JsonlSinkOptions = {}): TraceSink {
  const safeDir = validateTraceDir(dir);
  const now = options.now ?? Date.now;
  return {
    write: async (record, context) => {
      const at = now();
      // Records hold conversation content: readable by the host's user only.
      await mkdir(safeDir, { recursive: true, mode: OWNER_ONLY_DIR });
      await pruneTraces(safeDir, at, context.retainForDays);
      const path = await pickFile(safeDir, at, context.rotateAfterMiB * MIB);
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: OWNER_ONLY_FILE });
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

/** An absolute directory outside the working directory, normalized; throws `config` otherwise. */
function validateTraceDir(dir: string): string {
  const normalized = normalizeAbsolutePath(dir);
  if (insideDir(normalized, normalizeAbsolutePath(cwd()))) {
    throw new TheoremError('config', 'trace directory must be outside the project checkout');
  }
  return normalized;
}
