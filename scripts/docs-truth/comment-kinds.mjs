#!/usr/bin/env node
/**
 * Comment-kind lint: a line or block comment says why, never what. The code says what.
 * A comment block must open with one of these tags, and each tag states what the code cannot:
 *   why:        the reason for a choice, or the trap a change would fall into
 *   invariant:  a rule the surrounding code relies on and nothing else checks
 *   probed <YYYY-MM-DD>:  a fact measured against an outside system on that date
 *   license:    a legal notice
 *   lexicon-exempt: / lexicon-exempt-file:  escape hatches that `copy-lint.mjs` reads
 * JSDoc comments are not checked here: the kernel catalog and the entry docs own them.
 * A suppression comment (`biome-ignore`, `fallow-ignore`, `@ts-expect-error` …) fails everywhere,
 * tests and scripts included. Fix the cause.
 */
import { execFileSync } from 'node:child_process';

const SCAN = ['src', 'react/src', 'scripts', 'tests', 'mod.ts'];
const KIND_ROOTS = /^(src|react\/src)\/|^mod\.ts$/;
const TAG =
  /^(why|invariant|probed \d{4}-\d{2}-\d{2}|licen[cs]e|lexicon-exempt|lexicon-exempt-file)\s*:/;
const SUPPRESSION =
  /biome-ignore|fallow-ignore|deno-lint-ignore|eslint-disable|@ts-(ignore|nocheck|expect-error)|istanbul ignore|c8 ignore|stryker (disable|ignore)/;
const rule = (language) => `id: comment
language: ${language}
severity: hint
message: comment
rule:
  kind: comment
`;

function comments() {
  const scan = (language) =>
    execFileSync(
      'node_modules/.bin/ast-grep',
      ['scan', '--inline-rules', rule(language), '--json=stream', ...SCAN],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
  return [scan('TypeScript'), scan('Tsx')]
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((c) => !/\.(test\.tsx?|d\.ts)$/.test(c.file));
}

/** Consecutive `//` lines are one block. A blank line or code in between starts a new one. */
function blocks(all) {
  const byFile = new Map();
  for (const c of all) {
    if (!c.text.startsWith('//') && !c.text.startsWith('/*')) continue;
    if (c.text.startsWith('/**')) continue;
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file).push(c);
  }
  const out = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.range.start.line - b.range.start.line);
    let prev;
    for (const c of list) {
      const continues =
        prev &&
        c.text.startsWith('//') &&
        prev.text.startsWith('//') &&
        c.range.start.line === prev.range.end.line + 1 &&
        c.range.start.column === prev.range.start.column;
      if (!continues) out.push({ file, line: c.range.start.line + 1, text: c.text });
      prev = c;
    }
  }
  return out;
}

function body(text) {
  return text
    .replace(/^\/\*+\s*(\*\s*)?/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\/\/\/?/, '')
    .trim();
}

function main() {
  const all = comments();
  const suppressions = all.filter((c) => SUPPRESSION.test(c.text));
  const untagged = blocks(all.filter((c) => KIND_ROOTS.test(c.file))).filter(
    (b) => !TAG.test(body(b.text)) && !SUPPRESSION.test(b.text),
  );
  for (const c of suppressions) {
    console.error(
      `comment-kinds: suppression ${c.file}:${c.range.start.line + 1}  ${body(c.text).slice(0, 80)}`,
    );
  }
  for (const b of untagged) {
    console.error(`comment-kinds: ${b.file}:${b.line}  ${body(b.text).slice(0, 90)}`);
  }
  console.log(
    `comment-kinds: ${untagged.length} untagged comment blocks, ${suppressions.length} suppressions`,
  );
  if (untagged.length + suppressions.length > 0) {
    console.error(
      'Open each comment with why:, invariant:, probed <date>:, or license:, or delete it. Never suppress a check: fix the cause.',
    );
    process.exit(1);
  }
}

main();
