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

/** Published entry points: `deno.json` exports, each owned by the graph entry that names it. */
async function entryMods(entries) {
  const { exports } = JSON.parse(await readFile(path.resolve(repoRoot, 'deno.json'), 'utf8'));
  return Object.entries(exports).map(([name, mod]) => ({
    name,
    mod,
    owner: Object.values(entries).find((entry) => entry.export === name),
  }));
}

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

  const mods = await entryMods(entries);
  for (const { name, mod, owner: entry } of mods) {
    if (!entry?.doc) {
      errors.push(`export-drift: no graph entry with a doc owns export ${name}`);
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
  console.log(`export-drift: ${mods.length} entrypoints checked`);
}

await main();
