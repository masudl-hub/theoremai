#!/usr/bin/env node
import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hooksDir = path.join(repoRoot, '.git/hooks');

const hooks = [
  {
    src: path.join(repoRoot, 'scripts/hooks/pre-commit'),
    dest: path.join(hooksDir, 'pre-commit'),
    label: 'pre-commit → npm run lint:docs (docs-truth)',
  },
  {
    src: path.join(repoRoot, 'scripts/hooks/pre-push'),
    dest: path.join(hooksDir, 'pre-push'),
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

await mkdir(hooksDir, { recursive: true });
for (const hook of hooks) {
  await copyFile(hook.src, hook.dest);
  await chmod(hook.dest, 0o755);
  console.log(`Installed git ${hook.label}`);
}
