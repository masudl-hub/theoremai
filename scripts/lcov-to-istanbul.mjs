// Usage: node scripts/lcov-to-istanbul.mjs <lcov.info> <coverage-final.json>
// A file recorded more than once (several runs' lcov joined) has its hits summed.
// The output is written whole or not at all: a concurrent reader never sees half a file.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import ts from 'typescript';

const [lcovPath, outPath] = process.argv.slice(2);
if (!lcovPath || !outPath) {
  throw new Error('usage: lcov-to-istanbul.mjs <lcov.info> <coverage-final.json>');
}

function loc(line, column = 0) {
  return { line, column };
}

function span(startLine, endLine) {
  return { start: loc(startLine), end: loc(endLine, 1) };
}

// Deno prints V8's unsigned 32-bit hit counter as signed, so a count past 2^31 reads negative.
function hitCount(raw) {
  const hits = Number(raw);
  return hits < 0 ? hits + 2 ** 32 : hits;
}

function readBlock(block) {
  const path = block
    .split('\n')
    .find((line) => line.startsWith('SF:'))
    ?.slice(3);
  if (!path) {
    return null;
  }

  const fnStarts = new Map();
  const fnHits = new Map();
  const lines = new Map();

  for (const line of block.split('\n')) {
    if (line.startsWith('FN:') && !line.startsWith('FNDA:')) {
      const rest = line.slice(3);
      const comma = rest.indexOf(',');
      const start = Number(rest.slice(0, comma));
      const name = rest.slice(comma + 1);
      fnStarts.set(name, start);
    } else if (line.startsWith('FNDA:')) {
      const rest = line.slice(5);
      const comma = rest.indexOf(',');
      const hits = hitCount(rest.slice(0, comma));
      const name = rest.slice(comma + 1);
      fnHits.set(name, (fnHits.get(name) ?? 0) + hits);
    } else if (line.startsWith('DA:')) {
      const [rawLine, rawHits] = line.slice(3).split(',');
      const at = Number(rawLine);
      lines.set(at, (lines.get(at) ?? 0) + hitCount(rawHits));
    }
  }
  return { path, fnStarts, fnHits, lines };
}

function mergeInto(into, { fnStarts, fnHits, lines }) {
  for (const [name, start] of fnStarts)
    if (!into.fnStarts.has(name)) into.fnStarts.set(name, start);
  for (const [name, hits] of fnHits) into.fnHits.set(name, (into.fnHits.get(name) ?? 0) + hits);
  for (const [at, hits] of lines) into.lines.set(at, (into.lines.get(at) ?? 0) + hits);
}

function toIstanbul({ path, fnStarts, fnHits, lines }) {
  const statements = [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }));
  const names = [...fnStarts.keys()];
  const fnMap = {};
  const f = {};
  names.forEach((name, index) => {
    const start = fnStarts.get(name) ?? 1;
    const next = names[index + 1];
    const end = next ? (fnStarts.get(next) ?? start) - 1 : (statements.at(-1)?.line ?? start);
    fnMap[String(index)] = {
      name,
      decl: span(start, start),
      loc: span(start, Math.max(start, end)),
    };
    f[String(index)] = fnHits.get(name) ?? 0;
  });

  const statementMap = {};
  const s = {};
  statements.forEach((row, index) => {
    statementMap[String(index)] = span(row.line, row.line);
    s[String(index)] = row.hits;
  });

  return {
    path,
    statementMap,
    fnMap,
    branchMap: {},
    s,
    f,
    b: {},
  };
}

async function locateFunctions(record) {
  let source;
  try {
    source = await readFile(record.path, 'utf8');
  } catch {
    return;
  }
  const kind = ['.tsx', '.jsx'].includes(extname(record.path))
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(record.path, source, ts.ScriptTarget.Latest, true, kind);
  const ranges = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const start = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      const end = tree.getLineAndCharacterOfPosition(node.getEnd());
      ranges.push({ name: node.name?.getText(tree), start, end });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const entry of Object.values(record.fnMap)) {
    const candidates = ranges.filter((range) => range.start.line + 1 === entry.decl.start.line);
    const named = candidates.filter((range) => range.name === entry.name);
    const matches = named.length === 1 ? named : candidates;
    if (matches.length !== 1) continue;
    const range = matches[0];
    entry.loc = {
      start: loc(range.start.line + 1, range.start.character),
      end: loc(range.end.line + 1, range.end.character),
    };
  }
}

const lcov = await readFile(lcovPath, 'utf8');
const files = new Map();
for (const block of lcov.split('end_of_record')) {
  const read = readBlock(block);
  if (!read) continue;
  const seen = files.get(read.path);
  if (seen) mergeInto(seen, read);
  else files.set(read.path, read);
}
const coverage = {};
for (const file of files.values()) {
  const record = toIstanbul(file);
  await locateFunctions(record);
  coverage[record.path] = record;
}

await mkdir(dirname(outPath), { recursive: true });
const partPath = `${outPath}.${process.pid}.part`;
await writeFile(partPath, `${JSON.stringify(coverage)}\n`);
await rename(partPath, outPath);
console.log(`wrote ${outPath} (${Object.keys(coverage).length} files)`);
