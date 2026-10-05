/**
 * `agents egress-compile`: reads a module's exported egress rules and writes
 * the table `egressPolicy` loads with them.
 *
 * @module
 */

import { writeFile } from 'node:fs/promises';
import { cwd } from 'node:process';
import type { EgressRule } from '../../guardrails/egress-rules.ts';

interface EgressCompileOptions {
  /** Path or URL of the module exporting the rules. */
  module: string;
  /** The export holding the rules. Default `rules`. */
  exportName?: string;
  /** Where the compiled module is written. */
  out: string;
}

/** `specifier` as a URL, relative paths read from the working directory. */
function moduleUrl(specifier: string): string {
  return new URL(specifier, `file://${cwd()}/`).href;
}

/** Compiles the rules and writes the module; returns how many rules it read. */
async function egressCompileCommand({
  module,
  exportName = 'rules',
  out,
}: EgressCompileOptions): Promise<number> {
  const loaded = await import(moduleUrl(module));
  const rules = loaded[exportName] as readonly EgressRule[] | undefined;
  if (!Array.isArray(rules)) {
    throw new Error(`${module} has no array export named ${exportName}`);
  }
  // why: Loaded here so no other command loads the regex engine.
  const { compiledEgressModule, compileEgressRules } = await import(
    '../../guardrails/egress-compiler.ts'
  );
  await writeFile(out, compiledEgressModule(compileEgressRules(rules)));
  return rules.length;
}

export { egressCompileCommand };
