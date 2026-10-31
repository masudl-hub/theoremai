/**
 * Opens what the browser test drives: a fresh copy of `project/` in the studio, on the fake model.
 * The copy is what Save writes to, so a run never touches this repo.
 */
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { STUDIO_E2E_PROJECT: project, FAKE_MODEL_PORT: port } = process.env;

rmSync(project, { recursive: true, force: true });
cpSync(path.join(here, 'project'), project, { recursive: true });

// why: the studio starts the builder's editor; this one writes down what it was asked to open.
const tools = `${project}-tools`;
mkdirSync(tools, { recursive: true });
writeFileSync(path.join(tools, 'code'), `#!/bin/sh\necho "$@" > "${tools}/opened"\n`);
chmodSync(path.join(tools, 'code'), 0o755);

const children = [
  spawn('node', [path.join(here, 'fake-model.mjs'), port], { stdio: 'inherit' }),
  spawn(
    'node',
    [
      path.join(here, '../start.mjs'),
      'flows.studio.setup.ts',
      '--deno-config',
      path.join(here, '../../deno.json'),
      '--offline',
      '--editor',
      path.join(tools, 'code'),
    ],
    {
      cwd: project,
      stdio: 'inherit',
      env: { ...process.env, INIT_CWD: project, FAKE_MODEL_URL: `http://127.0.0.1:${port}` },
    },
  ),
];
const stop = () => {
  for (const child of children) child.kill();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
