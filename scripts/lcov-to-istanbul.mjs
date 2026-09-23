import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(root);
const lcovPath = join(repoRoot, 'coverage', 'lcov.info');
const outPath = join(repoRoot, 'coverage', 'coverage-final.json');

function loc(line, column = 0) {
  return { line, column };
}

function span(startLine, endLine) {
  return { start: loc(startLine), end: loc(endLine, 1) };
}

function parseRecord(block) {
  const path = block
    .split('\n')
    .find((line) => line.startsWith('SF:'))
    ?.slice(3);
  if (!path) {
    return null;
  }

  const fnStarts = new Map();
  const fnHits = new Map();
  const statements = [];

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
      const hits = Number(rest.slice(0, comma));
      const name = rest.slice(comma + 1);
      fnHits.set(name, hits);
    } else if (line.startsWith('DA:')) {
      const [rawLine, rawHits] = line.slice(3).split(',');
      statements.push({ line: Number(rawLine), hits: Number(rawHits) });
    }
  }

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

const lcov = await readFile(lcovPath, 'utf8');
const coverage = {};
for (const block of lcov.split('end_of_record')) {
  const record = parseRecord(block);
  if (record) {
    coverage[record.path] = record;
  }
}

await writeFile(outPath, `${JSON.stringify(coverage)}\n`);
console.log(`wrote ${outPath} (${Object.keys(coverage).length} files)`);
