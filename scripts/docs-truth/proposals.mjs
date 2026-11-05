#!/usr/bin/env node
/**
 * Proposal status lint: every proposal says on its third line whether it is a proposal, building,
 * built, or historical, and a docs-truth entry names each proposal its doc realizes in `realizes`.
 * Both are declared, so the check reads them and infers nothing from the code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROPOSALS_DIR = 'docs/proposals';

export const STATUSES = ['proposal', 'building', 'built', 'historical'];
const STATUS_LINE = /^\*\*Status:\*\* (\w+)\. \S/;

/** The status a proposal declares, or the way its status line is wrong. */
export function proposalStatus(text) {
  const lines = text.split('\n');
  if (!lines[0]?.startsWith('# ')) return { problem: 'the first line must be the "# " title' };
  const status = STATUS_LINE.exec(lines[2] ?? '')?.[1];
  if (!status || !STATUSES.includes(status)) {
    return {
      problem: `the third line must open "**Status:** <${STATUSES.join(' | ')}>. " and say what that means here`,
    };
  }
  return { status };
}

/**
 * The ways the proposals and the graph disagree: a status that is missing, a proposal realized
 * while it says nothing is built, a building or built proposal no entry realizes, or an entry that
 * realizes a file that is not a proposal.
 */
export function proposalProblems(proposals, entries) {
  const problems = [];
  const realizedBy = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    for (const file of entry.realizes ?? []) {
      if (!(file in proposals)) {
        problems.push(`${id}: realizes ${file}, which is not a proposal in ${PROPOSALS_DIR}/`);
        continue;
      }
      realizedBy.set(file, [...(realizedBy.get(file) ?? []), id]);
    }
  }
  for (const [file, text] of Object.entries(proposals)) {
    const { status, problem } = proposalStatus(text);
    if (problem) {
      problems.push(`${file}: ${problem}`);
      continue;
    }
    const owners = realizedBy.get(file) ?? [];
    if (status === 'proposal' && owners.length > 0) {
      problems.push(
        `${file}: says it is a proposal, but ${owners.join(', ')} realizes it; say building or built`,
      );
    }
    if ((status === 'building' || status === 'built') && owners.length === 0) {
      problems.push(
        `${file}: says it is ${status}, but no docs-truth entry realizes it; add it to the realizes of the entry whose doc says what shipped`,
      );
    }
  }
  return problems;
}

async function main() {
  const dir = path.join(ROOT, PROPOSALS_DIR);
  const proposals = Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => [`${PROPOSALS_DIR}/${name}`, fs.readFileSync(path.join(dir, name), 'utf8')]),
  );
  const { default: graph } = await import(pathToFileURL(path.join(ROOT, 'docs/_map.mjs')).href);
  const errors = proposalProblems(proposals, graph.entries ?? {});
  for (const error of errors) console.error(`proposals error: ${error}`);
  console.log(`proposals: ${errors.length} errors, ${Object.keys(proposals).length} files`);
  if (errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
