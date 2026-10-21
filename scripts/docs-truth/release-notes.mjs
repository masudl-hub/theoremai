#!/usr/bin/env node
/**
 * Release notes lint: the version in package.json has its notes in docs/releases/v<version>.md,
 * and every notes file there keeps the pattern in docs/releases/README.md. The publish workflow
 * posts the file as the GitHub release, so a release can never go out without its notes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES_DIR = 'docs/releases';

export const SECTIONS = ['Summary', "What's New", "What's Fixed", 'Breaking Changes', 'Notes'];

/** The ways one notes file breaks the pattern; an empty list when it keeps it. */
export function notesProblems(text, version) {
  const problems = [];
  const lines = text.split('\n');
  if (lines[0] !== `# v${version}`) problems.push(`the first line must be "# v${version}"`);
  const headings = lines
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
  if (headings.join('\n') !== SECTIONS.join('\n')) {
    problems.push(
      `the sections must be exactly ${SECTIONS.map((s) => `"## ${s}"`).join(', ')}, in that order`,
    );
    return problems;
  }
  const bodies = text.split(/^## .*$/m).slice(1);
  SECTIONS.forEach((section, index) => {
    if (!bodies[index]?.trim())
      problems.push(`"## ${section}" is empty; write "None." when there is nothing`);
  });
  if (/github\.com\/[^\s)]+\/pull\/\d+/.test(text)) {
    problems.push('the notes list pull requests; say what changed for the builder instead');
  }
  return problems;
}

function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dir = path.join(ROOT, NOTES_DIR);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^v\d.*\.md$/.test(name))
    : [];
  const errors = [];
  if (!files.includes(`v${version}.md`)) {
    errors.push(
      `${NOTES_DIR}/v${version}.md: package.json is at ${version} and has no release notes`,
    );
  }
  for (const name of files) {
    const fileVersion = name.slice(1, -3);
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const problem of notesProblems(text, fileVersion))
      errors.push(`${NOTES_DIR}/${name}: ${problem}`);
  }
  for (const error of errors) console.error(`release notes error: ${error}`);
  console.log(`release notes: ${errors.length} errors, ${files.length} files`);
  if (errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
