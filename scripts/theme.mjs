// Usage: node scripts/theme.mjs build | check [react | studio]
// Builds an Astryx theme into its `built` folder. The React package's typings are formatted with Biome, as the repo's lint reads them.
// `check` fails when the files on disk are not what a build writes, and leaves them as they were.
// The Astryx CLI is the one the React package installs; the studio's theme is built with it too.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const which = process.argv[3] ?? 'react';
const TARGETS = {
  react: {
    cwd: 'react',
    source: 'src/ui/theorem-theme.ts',
    built: 'src/ui/built',
    name: 'theorem',
    icons: '../icons.js',
    // Biome reads the React package's typings, so they are kept in its format.
    format: true,
    rebuild: 'npm --prefix react run theme:build',
  },
  studio: {
    cwd: 'studio',
    source: 'ui/studio-theme.ts',
    built: 'ui/built',
    name: 'theorem-studio',
    icons: '../../../react/src/ui/icons.ts',
    format: false,
    rebuild: 'npm --prefix studio run theme:build',
  },
};
const target = TARGETS[which];
if ((mode !== 'build' && mode !== 'check') || !target) {
  throw new Error('usage: theme.mjs build | check [react | studio]');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const cwd = fileURLToPath(new URL(`../${target.cwd}`, import.meta.url));
const cli = fileURLToPath(
  new URL('../react/node_modules/@astryxdesign/cli/clients/cli/bin/astryx.mjs', import.meta.url),
);
const built = (name) =>
  fileURLToPath(new URL(`../${target.cwd}/${target.built}/${name}`, import.meta.url));
const TYPINGS = [`${target.name}.d.ts`, `${target.name}.variants.d.ts`].map(built);
const OUTPUTS = [built('theme.css'), built(`${target.name}.js`), ...TYPINGS];

function run(command, args, at) {
  const { status } = spawnSync(command, args, { cwd: at, stdio: 'inherit' });
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${status}`);
}

function build() {
  run(
    process.execPath,
    [
      ...[cli, 'theme', 'build', target.source],
      ...['-o', `${target.built}/theme.css`, '--icons-specifier', target.icons],
    ],
    cwd,
  );
  if (target.format) run('npx', ['biome', 'check', '--write', ...TYPINGS], root);
}

if (mode === 'build') {
  build();
} else {
  const before = OUTPUTS.map((path) => readFileSync(path, 'utf8'));
  let stale = [];
  try {
    build();
    stale = OUTPUTS.filter((path, i) => readFileSync(path, 'utf8') !== before[i]);
  } finally {
    OUTPUTS.forEach((path, i) => {
      writeFileSync(path, before[i]);
    });
  }
  if (stale.length > 0) {
    console.error(`Theme outputs are out of date:\n${stale.map((path) => `  ${path}`).join('\n')}`);
    console.error(`Rebuild with: ${target.rebuild}`);
    process.exit(1);
  }
}
