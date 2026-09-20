#!/usr/bin/env node
/**
 * Copy-manifest lint — P2 enforcement for "Host decides, Theorem runs."
 *
 * Scans **all** of `src/kernel`, `src/guardrails`, and `src/interface` for
 * prose-like string literals (≥3 alphabetic words) outside the lexicon.
 *
 * Escape hatches (must state a reason):
 *   - `// lexicon-exempt: <reason>` on the same or previous line
 *   - `lexicon-exempt-file: <reason>` in a comment in the first 40 lines
 *     (for fixture modules that never emit to users/models at runtime)
 *
 * Auto-skipped (only):
 *   - `src/guardrails/lexicon.ts` — the registered defaults themselves
 *
 * Important: do NOT strip block comments before scanning strings — template
 * literals can contain `/*` (e.g. `${category}/*`) and a naive strip eats the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAN_ROOTS = ['src/kernel', 'src/guardrails', 'src/interface'];
const AUTO_SKIP = new Set(['src/guardrails/lexicon.ts']);

const EXEMPT_LINE_RE = /lexicon-exempt\s*:/;
const EXEMPT_FILE_RE = /lexicon-exempt-file\s*:/;
const WORD_RE = /^[A-Za-z][A-Za-z'’.,:;!?()-]*$/;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function fileIsExempt(src) {
  const head = src.split('\n').slice(0, 40).join('\n');
  return EXEMPT_FILE_RE.test(head);
}

/** Scan source for string literals without disturbing comment/string nesting. */
function proseHits(src) {
  const lines = src.split('\n');
  const hits = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        if (src[i] === quote) break;
        i += 1;
      }
      const raw = src.slice(start, i + 1);
      i += 1;
      const body = raw.slice(1, -1);
      const decoded = body
        .replace(/\\n/g, ' ')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      if (decoded.includes('://')) continue;
      // MIME / path-like tokens
      if (/^[a-z]+\/[a-z0-9.+*-]+$/i.test(decoded.trim())) continue;
      const words = decoded.split(/\s+/).filter((w) => WORD_RE.test(w));
      if (words.length < 3) continue;

      const line = src.slice(0, start).split('\n').length;
      const original = lines[line - 1] ?? '';
      const prev = lines[line - 2] ?? '';
      if (EXEMPT_LINE_RE.test(original) || EXEMPT_LINE_RE.test(prev)) continue;
      hits.push({ line, text: decoded.replace(/\s+/g, ' ').trim().slice(0, 100) });
      continue;
    }

    i += 1;
  }
  return hits;
}

const violations = [];
for (const root of SCAN_ROOTS) {
  const abs = path.join(ROOT, root);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const relative = rel(file);
    if (AUTO_SKIP.has(relative)) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (fileIsExempt(src)) continue;
    for (const hit of proseHits(src)) {
      violations.push(`${relative}:${hit.line}: ${JSON.stringify(hit.text)}`);
    }
  }
}

if (violations.length) {
  console.error(
    `copy-lint: ${violations.length} prose-like string(s) outside the lexicon.\n` +
      'Move user/model-visible copy into src/guardrails/lexicon.ts, or annotate with\n' +
      '`// lexicon-exempt: <reason>` (same/previous line) or `lexicon-exempt-file: <reason>`\n' +
      '(first 40 lines, for non-runtime fixture modules only).\n',
  );
  for (const v of violations.slice(0, 120)) console.error(`  ${v}`);
  if (violations.length > 120) {
    console.error(`  … and ${violations.length - 120} more`);
  }
  process.exit(1);
}

console.log('copy-lint: ok (full tree: src/kernel, src/guardrails, src/interface)');
