// Usage: node scripts/theme.mjs build | check
// Builds the Astryx theme into react/src/ui/built and formats the typings with Biome, as the repo's lint reads them.
// `check` fails when the files on disk are not what a build writes, and leaves them as they were.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode !== 'build' && mode !== 'check') {
  throw new Error('usage: theme.mjs build | check');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const react = fileURLToPath(new URL('../react', import.meta.url));
const built = (name) => fileURLToPath(new URL(`../react/src/ui/built/${name}`, import.meta.url));
const TYPINGS = ['theorem.d.ts', 'theorem.variants.d.ts'].map(built);
const OUTPUTS = [built('theme.css'), built('theorem.js'), ...TYPINGS];

function run(command, args, cwd) {
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${status}`);
}

function build() {
  run(
    'npx',
    [
      ...['astryx', 'theme', 'build', 'src/ui/theorem-theme.ts'],
      ...['-o', 'src/ui/built/theme.css', '--icons-specifier', '../icons.js'],
    ],
    react,
  );
  run('npx', ['biome', 'check', '--write', ...TYPINGS], root);
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
    console.error('Rebuild with: npm --prefix react run theme:build');
    process.exit(1);
  }
}
