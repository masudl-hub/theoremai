#!/usr/bin/env node
/**
 * Verify public entrypoint exports appear in the owning contract doc.
 * Heuristic: every `export { name` / `export type { Name` from the entry
 * mod file must appear as text in the mapped contract.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadGraph, normalizePath } from './graph.mjs';

const repoRoot = process.cwd();

const ENTRY_MODS = [
  { export: '.', mod: 'mod.ts', docFromEntry: 'package' },
  { export: './kernel', mod: 'src/kernel/mod.ts', docFromEntry: 'kernel' },
  { export: './providers', mod: 'src/providers/mod.ts', docFromEntry: 'providers' },
  {
    export: './providers/local',
    mod: 'src/providers/local/mod.ts',
    docFromEntry: 'providers-local',
  },
  { export: './guardrails', mod: 'src/guardrails/mod.ts', docFromEntry: 'guardrails' },
  { export: './observability', mod: 'src/observability/mod.ts', docFromEntry: 'observability' },
  { export: './host', mod: 'src/host/mod.ts', docFromEntry: 'host' },
  { export: './cli', mod: 'src/cli/index.ts', docFromEntry: 'cli' },
  { export: './presets', mod: 'src/presets/mod.ts', docFromEntry: 'presets' },
  { export: './presets/google', mod: 'src/presets/google.ts', docFromEntry: 'presets-google' },
];

function parseExportNames(source) {
  const names = new Set();
  const blockPattern = /export\s+(?:type\s+)?\{([^}]+)\}/g;
  for (const match of source.matchAll(blockPattern)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const alias = trimmed
        .split(/\s+as\s+/i)
        .pop()
        ?.trim();
      if (alias) names.add(alias.replace(/^type\s+/, ''));
    }
  }
  const exportTypePattern = /export\s+type\s+\*\s+from/g;
  if (exportTypePattern.test(source)) {
    names.add('type *');
  }
  return [...names].filter((n) => n !== 'type *' || names.size === 1);
}

async function main() {
  const graph = await loadGraph(repoRoot);
  const entries = graph.entries ?? {};
  const errors = [];

  for (const { mod, docFromEntry } of ENTRY_MODS) {
    const entry = entries[docFromEntry];
    if (!entry?.doc) {
      errors.push(`export-drift: missing graph entry ${docFromEntry}`);
      continue;
    }
    const modPath = normalizePath(mod);
    const docPath = normalizePath(entry.doc);
    let modSource;
    let docSource;
    try {
      modSource = await readFile(path.resolve(repoRoot, modPath), 'utf8');
      docSource = await readFile(path.resolve(repoRoot, docPath), 'utf8');
    } catch {
      errors.push(`export-drift: cannot read ${modPath} or ${docPath}`);
      continue;
    }
    const exports = parseExportNames(modSource);
    const missing = exports.filter((name) => !docSource.includes(name));
    if (missing.length > 0) {
      errors.push(
        `${docPath}: Exported API missing names from ${modPath}: ${missing.slice(0, 12).join(', ')}` +
          (missing.length > 12 ? ` (+${missing.length - 12} more)` : ''),
      );
    }
  }

  for (const error of errors) {
    console.error(`export drift error: ${error}`);
  }
  if (errors.length) process.exit(1);
  console.log(`export-drift: ${ENTRY_MODS.length} entrypoints checked`);
}

await main();
