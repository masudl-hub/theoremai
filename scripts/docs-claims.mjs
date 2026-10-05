#!/usr/bin/env node
// Ties a Markdown doc to the code it describes. See docs/writing/proof.md.
//
//   node scripts/docs-claims.mjs check <doc.md>
//     Every inline `code span` that names a path, package or identifier must
//     exist in the repo. Prints the ones that do not. Exit 1 if any are missing.
//
//   node scripts/docs-claims.mjs affected [--base REF]
//     Lists Markdown docs that mention a symbol or path changed since REF
//     (default: the merge base with origin/main, plus the working tree).
//
// It proves that a name exists. It does not prove that a sentence is true.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const IDENT = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*(\(\))?$/;
const PKG = /^@[\w.-]+\/[\w.-]+$/;
const SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;
const GENERIC = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'string',
  'number',
  'boolean',
  'void',
  'Request',
  'Response',
  'Promise',
  'Uint8Array',
  'Map',
  'Set',
  'Date',
  'Error',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'HttpOnly',
  'SameSite',
  'Lax',
  'WebSocket',
  'JSON',
  'URL',
  'npm',
  'deno',
  'node',
  'tsc',
  'git',
  'zod',
  'react',
]);
const DECL =
  /^[+-]\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum|abstract class)\s+([A-Za-z_$][\w$]*)/;

function git(args, cwd) {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { code: p.status ?? 1, out: p.stdout ?? '' };
}

function rootOf(dir) {
  const r = git(['rev-parse', '--show-toplevel'], dir);
  return r.code === 0 ? r.out.trim() : process.cwd();
}

function inCode(root, needle, fixed = true) {
  const flags = fixed ? ['-q', '-w', '-F'] : ['-q', '-F'];
  return git(['grep', ...flags, needle, '--', ':!*.md'], root).code === 0;
}

function stripFences(text) {
  let fenced = false;
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out.join('\n');
}

function check(doc) {
  const docPath = resolve(doc);
  const docDir = dirname(docPath);
  const root = rootOf(docDir);
  const text = stripFences(readFileSync(docPath, 'utf8'));
  const seen = new Set();
  const missing = [];
  for (const m of text.matchAll(SPAN)) {
    const s = m[1].trim();
    if (seen.has(s)) continue;
    seen.add(s);
    if (PKG.test(s)) {
      const hit =
        git(['grep', '-q', '-F', `"${s}"`, '--', '*package.json', '*deno.json'], root).code === 0;
      if (!hit) missing.push([s, 'package not found in any package.json or deno.json']);
    } else if (s.includes('/') && /\.\w+$/.test(s) && !/[\s*<]|^http/.test(s)) {
      const p = s.split(':')[0].replace(/^\.\//, '');
      if (!existsSync(join(root, p)) && !existsSync(join(docDir, p)))
        missing.push([s, 'path does not exist']);
    } else if (IDENT.test(s)) {
      const name = s.replace(/\(\)$/, '').split('.').pop();
      if (name.length < 4 || GENERIC.has(name) || (name === name.toLowerCase() && name.length < 6))
        continue;
      if (!inCode(root, name)) missing.push([s, 'identifier not found in code']);
    }
  }
  for (const [s, why] of missing) console.log(`MISSING  \`${s}\`  ${why}`);
  console.log(`${seen.size} code spans read, ${missing.length} not found in ${root}`);
  return missing.length ? 1 : 0;
}

function changed(root, base) {
  const ref = base ?? (git(['merge-base', 'HEAD', 'origin/main'], root).out.trim() || 'HEAD~1');
  const skip = [':!*.md', ':!*.lock', ':!package-lock.json'];
  const diff = git(['diff', '-U0', ref, '--', ...skip], root).out;
  const files = new Set(
    git(['diff', '--name-only', ref, '--', ':!*.md'], root).out.split('\n').filter(Boolean),
  );
  const symbols = new Set();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const m = DECL.exec(line);
    // Plain lowercase words ('args', 'code') match every doc; keep names with a case change.
    if (m && m[1].length >= 6 && /[a-z][A-Z]|^[A-Z]/.test(m[1])) symbols.add(m[1]);
  }
  return { ref, files, symbols };
}

function affected(base) {
  const root = rootOf(process.cwd());
  const { ref, files, symbols } = changed(root, base);
  const docs = git(['ls-files', '*.md'], root)
    .out.split('\n')
    .filter((d) => d && !d.includes('node_modules'));
  const hits = [];
  for (const d of docs) {
    if (!existsSync(join(root, d))) continue;
    const text = readFileSync(join(root, d), 'utf8');
    const found = [
      ...[...symbols].filter((s) => new RegExp(`\\b${s.replace(/\$/g, '\\$')}\\b`).test(text)),
      ...[...files].filter((f) => text.includes(f)),
    ].sort();
    if (found.length) hits.push([d, found]);
  }
  console.log(
    `base ${ref.slice(0, 10)}: ${files.size} code files, ${symbols.size} symbols changed`,
  );
  hits.sort((a, b) => b[1].length - a[1].length);
  for (const [d, found] of hits) {
    console.log(
      `RE-READ  ${d}  <- ${found.slice(0, 8).join(', ')}${found.length > 8 ? ' ...' : ''}`,
    );
  }
  if (!hits.length) console.log('no doc mentions a changed symbol or path');
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check' && rest[0]) process.exit(check(rest[0]));
if (cmd === 'affected') {
  const i = rest.indexOf('--base');
  process.exit(affected(i >= 0 ? rest[i + 1] : undefined));
}
console.error('usage: docs-claims.mjs check <doc.md> | affected [--base REF]');
process.exit(2);
