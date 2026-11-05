#!/usr/bin/env node
/**
 * Export drift: each published entry point's exports are the names in the Exported API table of the
 * doc that owns it, in both directions. `deno doc` reads the exports, so `export *` counts. Names that
 * an entry re-exports through `export type *`, or through `export *` from another published entry
 * point, are documented by reference and may be left out. The root README's Public Entrypoints table
 * names every `deno.json` export, and only those.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph, normalizePath } from './graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE = '@theoremjs/agents';
const IDENTIFIER = /`([A-Za-z_$][\w$]*)(?:\([^`]*\))?`/g;

/** The lines of a heading's section, up to the next heading of its level or higher. */
export function sectionOf(doc, heading) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^#{2,3} ${heading}\\s*$`).test(line));
  if (start < 0) return null;
  const level = lines[start].indexOf(' ');
  let end = start + 1;
  while (end < lines.length) {
    const hashes = /^(#+) /.exec(lines[end]);
    if (hashes && hashes[1].length <= level) break;
    end++;
  }
  return lines.slice(start + 1, end);
}

function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * The names in a section's tables, read from the column headed `Symbols` or `Export`; `null` when the
 * section has no such table.
 */
export function tableNames(lines) {
  const names = new Set();
  let column = -1;
  let tables = 0;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at];
    if (!line.trim().startsWith('|')) {
      column = -1;
      continue;
    }
    if (column < 0) {
      column = cells(line).findIndex((cell) => cell === 'Symbols' || cell === 'Export');
      if (column >= 0) tables++;
      at++;
      continue;
    }
    for (const match of (cells(line)[column] ?? '').matchAll(IDENTIFIER)) names.add(match[1]);
  }
  return tables > 0 ? names : null;
}

/** The npm names in the Public Entrypoints table, as `.`-relative subpaths (`.`, `./kernel`). */
export function entrypointSubpaths(lines) {
  const subpaths = new Set();
  for (const line of lines.slice(2)) {
    if (!line.trim().startsWith('|')) continue;
    for (const match of cells(line)[0].matchAll(/`(@theoremjs\/agents[^`]*)`/g))
      subpaths.add(`.${match[1].slice(PACKAGE.length)}`);
  }
  return subpaths;
}

function documented(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g))
    for (const part of match[1].split(',')) {
      const alias = part
        .trim()
        .split(/\s+as\s+/i)
        .pop()
        ?.replace(/^type\s+/, '')
        .trim();
      if (alias) names.add(alias);
    }
  return names;
}

function symbolsByModule(files) {
  const output = execFileSync('deno', ['doc', '--json', ...files], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const { nodes } = JSON.parse(output.toString());
  return new Map(
    Object.entries(nodes).map(([url, node]) => [
      fileURLToPath(url),
      new Set(node.symbols.map((symbol) => symbol.name)),
    ]),
  );
}

async function main() {
  const graph = await loadGraph(ROOT);
  const entries = Object.values(graph.entries ?? {});
  const { exports } = JSON.parse(await readFile(path.join(ROOT, 'deno.json'), 'utf8'));
  const errors = [];

  const mods = await Promise.all(
    Object.entries(exports).map(async ([name, mod]) => {
      const file = path.resolve(ROOT, mod);
      const source = await readFile(file, 'utf8');
      const star = (pattern) =>
        [...source.matchAll(pattern)].map((match) => path.resolve(path.dirname(file), match[1]));
      return {
        name,
        file,
        source,
        typeStar: star(/export\s+type\s+\*\s+from\s+'([^']+)'/g),
        valueStar: star(/export\s+\*\s+from\s+'([^']+)'/g),
        owner: entries.find((e) => e.export === name),
      };
    }),
  );
  const entryFiles = new Set(mods.map(({ file }) => file));
  for (const mod of mods)
    mod.byReference = [...mod.typeStar, ...mod.valueStar.filter((file) => entryFiles.has(file))];
  const symbols = symbolsByModule([
    ...new Set(mods.flatMap(({ file, byReference }) => [file, ...byReference])),
  ]);
  const published = new Set(mods.flatMap(({ file }) => [...(symbols.get(file) ?? [])]));

  const docs = new Map();
  for (const { name, file, source, byReference, owner } of mods) {
    if (!owner?.doc) {
      errors.push(`no graph entry with a doc owns export ${name}`);
      continue;
    }
    const docPath = normalizePath(owner.doc);
    if (!docs.has(docPath)) {
      const text = await readFile(path.join(ROOT, docPath), 'utf8');
      const lines = sectionOf(text, 'Exported API');
      docs.set(docPath, { text, listed: lines ? tableNames(lines) : null });
    }
    const { listed } = docs.get(docPath);
    if (!listed) {
      errors.push(
        `${docPath}: no Exported API section with a table whose column is Symbols or Export`,
      );
      continue;
    }
    const named = documented(source);
    const referenced = new Set(byReference.flatMap((ref) => [...(symbols.get(ref) ?? [])]));
    const missing = [...(symbols.get(file) ?? [])].filter(
      (symbol) => !listed.has(symbol) && !(referenced.has(symbol) && !named.has(symbol)),
    );
    if (missing.length > 0)
      errors.push(
        `${docPath}: Exported API leaves out ${missing.length} names that ${normalizePath(path.relative(ROOT, file))} exports: ${missing.join(', ')}`,
      );
  }

  for (const [docPath, { listed }] of docs) {
    const gone = [...(listed ?? [])].filter((symbol) => !published.has(symbol));
    if (gone.length > 0)
      errors.push(
        `${docPath}: Exported API lists ${gone.length} names that no entry point exports: ${gone.join(', ')}`,
      );
  }

  const root = entries.find((entry) => entry.export === '.');
  if (root?.doc) {
    const lines = sectionOf(
      await readFile(path.join(ROOT, root.doc), 'utf8'),
      'Public Entrypoints',
    );
    const tabled = entrypointSubpaths(lines ?? []);
    const absent = Object.keys(exports).filter((subpath) => !tabled.has(subpath));
    const extra = [...tabled].filter((subpath) => !(subpath in exports));
    if (absent.length > 0)
      errors.push(`${root.doc}: Public Entrypoints leaves out ${absent.join(', ')}`);
    if (extra.length > 0)
      errors.push(
        `${root.doc}: Public Entrypoints names ${extra.join(', ')}, which deno.json does not export`,
      );
  }

  for (const error of errors) console.error(`export drift error: ${error}`);
  if (errors.length) process.exit(1);
  console.log(`export-drift: ${mods.length} entrypoints checked`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
