#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const hooks = [
  {
    name: 'pre-commit',
    label: 'pre-commit → npm run lint:docs (docs-truth)',
  },
  {
    name: 'pre-push',
    label: 'pre-push → fallow audit --base main (coverage-aware when present)',
  },
];

if (process.env.CI === 'true') {
  process.exit(0);
}

try {
  await access(path.join(repoRoot, '.git'));
} catch {
  process.exit(0);
}

// Ask git where hooks live: `.git/hooks` in a clone, the shared common-dir hooks in a
// worktree (where `.git` is a file), or `core.hooksPath` when set.
const hooksDir = path.resolve(
  repoRoot,
  execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim(),
);

await mkdir(hooksDir, { recursive: true });
for (const hook of hooks) {
  const dest = path.join(hooksDir, hook.name);
  await copyFile(path.join(repoRoot, 'scripts/hooks', hook.name), dest);
  await chmod(dest, 0o755);
  console.log(`Installed git ${hook.label}`);
}
