import { readdir, readFile, stat } from 'node:fs/promises';
import { cwd } from 'node:process';
import type { z } from 'zod';
import { TheoremError } from '../guardrails/error.ts';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import type { ProviderHostOptions } from '../kernel/provider-contract.ts';
import type { StageHandler } from '../kernel/stages.ts';
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

/** A suite with its cases read, the providers, media resolver and stage handler its module exports, and the module's path. */
interface LoadedSuite {
  suite: EvalSuite;
  cases: EvalCase[];
  provider?: ProviderHostOptions;
  judgeProvider?: ProviderHostOptions;
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  media?: EvalMediaResolver;
  /** The stage handler every live trial's turn runs with, as the host's own requests do. */
  onStage?: StageHandler;
  path: string;
}

function isProvider(value: unknown): value is ProviderHostOptions {
  return isRecord(value) && !('complete' in value);
}

function isDecisionKey(value: unknown): value is Omit<RunDecisionOptions, 'sink'> {
  return isRecord(value) && isRecord(value.vault);
}

function absolute(path: string): string {
  return path.startsWith('/') ? path : `${cwd()}/${path}`;
}

function siblingOf(modulePath: string, relative: string): string {
  const dir = modulePath.slice(0, modulePath.lastIndexOf('/'));
  return relative.startsWith('/') ? relative : `${dir}/${relative}`;
}

/** Reads a JSON Lines file, parsing each line against the schema; throws with the file and line number on a line that is not JSON or does not match. */
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

/** Reads trace records from a `.jsonl` file, or from every `.jsonl` file in a directory, in name order. */
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

/** Imports a suite module, checks its default export against `EvalSuite` and reads its cases; throws when a case id repeats. */
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
    ...(typeof module.onStage === 'function' ? { onStage: module.onStage as StageHandler } : {}),
  };
}

export type { LoadedSuite };
export { loadSuite, readJsonl, readTraceRecords };
