#!/usr/bin/env node

import process from 'node:process';

import {
  buildInventory,
  collectChangedFiles,
  DEFAULT_GRAPH_PATH,
  lintDocsTruth,
} from './graph.mjs';

const HELP = `theorem docs-truth — deterministic document health lint (no waivers)

Usage:
  node ./scripts/docs-truth/cli.mjs lint
  node ./scripts/docs-truth/cli.mjs inventory
  node ./scripts/docs-truth/cli.mjs freshness
  node ./scripts/docs-truth/cli.mjs --help

Environment:
  THEOREM_DOCS_BASE=origin/main   Base ref for changed-file freshness
`;

const repoRoot = process.cwd();
const [command] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  process.stdout.write(HELP);
  process.exit(0);
}

if (command === 'inventory') {
  const inventory = await buildInventory(repoRoot);
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  process.exit(inventory.unowned.length || inventory.multi_owned.length ? 1 : 0);
}

if (command === 'lint' || command === 'freshness') {
  const changedFiles = collectChangedFiles(repoRoot);
  const result = await lintDocsTruth({
    repoRoot,
    graphPath: DEFAULT_GRAPH_PATH,
    changedFiles: command === 'freshness' ? changedFiles : changedFiles,
  });
  for (const warning of result.warnings) {
    console.warn(`docs truth warning: ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`docs truth error: ${error}`);
  }
  console.log(
    `docs truth: ${result.errors.length} errors, ${result.warnings.length} warnings, ` +
      `${result.productionFiles.length} production files, ${result.changedFiles.length} changed`,
  );
  process.exit(result.errors.length ? 1 : 0);
}

console.error(`unknown command: ${command}`);
process.stdout.write(HELP);
process.exit(2);
