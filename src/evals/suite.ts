/**
 * Loading a suite: the TypeScript module that names the profile, graders and
 * pass rule, and the JSONL file beside it that holds the cases. Also the
 * JSONL reader recorded mode uses for trace records.
 *
 * @module
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { cwd } from 'node:process';
import type { z } from 'zod';
import { TheoremError } from '../guardrails/error.ts';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import type { ModelProvider } from '../kernel/types.ts';
import { isRecord } from '../kernel/util/record.ts';
import { type TraceRecord, traceRecordSchema } from '../observability/trace-schema.ts';
import { pinCaseFiles } from './attachments.ts';
import {
  type EvalCase,
  type EvalMediaResolver,
  type EvalSuite,
  evalCaseSchema,
  evalSuiteSchema,
} from './types.ts';

/** A suite with its cases read in. */
interface LoadedSuite {
  suite: EvalSuite;
  cases: EvalCase[];
  /** The provider the suite module exported, when it did (`export const provider`). */
  provider?: ModelProvider;
  /** The provider for text judge profiles, when the module exported one (`export const judgeProvider`). */
  judgeProvider?: ModelProvider;
  /** The key for decision judge profiles, when the module exported one (`export const judgeDecision`). */
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  /** Where a judge finds media by hash, when the module exported it (`export const media`). */
  media?: EvalMediaResolver;
  /** Absolute path of the suite module. */
  path: string;
}

function isProvider(value: unknown): value is ModelProvider {
  return isRecord(value) && typeof value.complete === 'function';
}

/** A flat key or a vault, as `runDecision` takes them. */
function isDecisionKey(value: unknown): value is Omit<RunDecisionOptions, 'sink'> {
  return isRecord(value) && (typeof value.apiKey === 'string' || isRecord(value.keyVault));
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : `${cwd()}/${path}`;
}

function siblingOf(modulePath: string, relative: string): string {
  const dir = modulePath.slice(0, modulePath.lastIndexOf('/'));
  return relative.startsWith('/') ? relative : `${dir}/${relative}`;
}

/** Every non-blank line of a JSONL file, parsed and validated; the line number names a bad one. */
async function readJsonl<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T[]> {
  const text = await readFile(path, 'utf8');
  const out: T[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TheoremError('config', `${path}:${index + 1}: ${what} is not JSON`); // lexicon-exempt: developer contract error
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const at = issue?.path.join('.') || '(root)';
      throw new TheoremError(
        'config',
        `${path}:${index + 1}: ${what} ${at}: ${issue?.message ?? 'invalid'}`, // lexicon-exempt: developer contract error
      );
    }
    out.push(result.data);
  }
  return out;
}

/** The trace records in one JSONL file, or in every `.jsonl` file of a directory. */
async function readTraceRecords(path: string): Promise<TraceRecord[]> {
  const target = absolute(path);
  const info = await stat(target);
  if (!info.isDirectory()) return readJsonl(target, traceRecordSchema, 'trace record');
  const files: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(`${target}/${entry.name}`);
  }
  files.sort();
  const records: TraceRecord[] = [];
  for (const file of files)
    records.push(...(await readJsonl(file, traceRecordSchema, 'trace record')));
  return records;
}

/**
 * Import a suite module (`export default` an `EvalSuite`, optionally
 * `export const provider`, `judgeProvider`, `judgeDecision` and `media`), then read
 * its cases from the file it names, relative to the module.
 */
async function loadSuite(modulePath: string): Promise<LoadedSuite> {
  const path = absolute(modulePath);
  const module: unknown = await import(new URL(`file://${path}`).href);
  if (!isRecord(module)) {
    throw new TheoremError('config', `${modulePath}: not a module`); // lexicon-exempt: developer contract error
  }
  const parsed = evalSuiteSchema.safeParse(module.default);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TheoremError(
      'config',
      `${modulePath}: default export is not an EvalSuite (${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'invalid'})`, // lexicon-exempt: developer contract error
    );
  }
  const suite = parsed.data;
  const casesPath = siblingOf(path, suite.cases);
  const cases = await readJsonl(casesPath, evalCaseSchema, 'case');
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) {
      throw new TheoremError('config', `${suite.cases}: case id ${evalCase.id} appears twice`); // lexicon-exempt: developer contract error
    }
    ids.add(evalCase.id);
  }
  return {
    suite,
    cases: await pinCaseFiles(cases, casesPath),
    path,
    ...(isProvider(module.provider) ? { provider: module.provider } : {}),
    ...(isProvider(module.judgeProvider) ? { judgeProvider: module.judgeProvider } : {}),
    ...(isDecisionKey(module.judgeDecision) ? { judgeDecision: module.judgeDecision } : {}),
    ...(typeof module.media === 'function' ? { media: module.media as EvalMediaResolver } : {}),
  };
}

export type { LoadedSuite };
export { loadSuite, readJsonl, readTraceRecords };
