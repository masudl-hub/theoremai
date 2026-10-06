/**
 * `agents detect-compile`: reads a module's exported `guardrails.detect` setting and writes the
 * table each detector's own patterns compile to.
 *
 * @module
 */

import { writeFile } from 'node:fs/promises';
import { cwd } from 'node:process';
import type { DetectSpec } from '../../guardrails/detectors.ts';

interface DetectCompileOptions {
  /** Path or URL of the module exporting the detect setting. */
  module: string;
  /** The export holding it. Default `detect`. */
  exportName?: string;
  /** Where the compiled module is written. */
  out: string;
}

/** Compiles each detector's patterns and writes the module; returns the detectors it compiled. */
async function detectCompileCommand({
  module,
  exportName = 'detect',
  out,
}: DetectCompileOptions): Promise<string[]> {
  const loaded = await import(new URL(module, `file://${cwd()}/`).href);
  const detect = loaded[exportName] as DetectSpec | undefined;
  if (typeof detect !== 'object' || detect === null) {
    throw new Error(`${module} has no detect setting exported as ${exportName}`);
  }
  // why: Loaded here so no other command loads the regex engine.
  const { compiledDetectModule, compileDetectTables } = await import(
    '../../guardrails/egress-compiler.ts'
  );
  const tables = compileDetectTables(detect);
  await writeFile(out, compiledDetectModule(tables));
  return Object.keys(tables);
}

export { detectCompileCommand };
