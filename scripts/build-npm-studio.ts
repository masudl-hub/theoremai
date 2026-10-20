/**
 * Builds `@theoremjs/studio` into `studio/npm`: the command (`theorem-studio`), every export
 * `studio/package.json` names built to JavaScript and declarations, and the page built in advance.
 * Deno runs no TypeScript from `node_modules`, so tsc writes the JavaScript; Deno checks it. Vite
 * builds the page with the kernel's declarations in it, so the studio ships in lockstep with the
 * kernel and the React package: the version, the runtime floor, and both peers come from the root
 * manifest, pinned.
 */
import { BUILT_PAGE, PROJECT_PLACEHOLDER } from '../studio/page.mjs';

const studioDir = './studio';
const outDir = `${studioDir}/npm`;
/** The command and what it loads: the launcher, its checks, and the page's server. */
const launchers = [
  'start.mjs',
  'installed.mjs',
  'ports.mjs',
  'setups.mjs',
  'page.mjs',
  'serve-page.mjs',
];

type StudioManifest = {
  name: string;
  type: string;
  sideEffects: string[];
  exports: Record<string, string>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const manifest: StudioManifest = JSON.parse(await Deno.readTextFile(`${studioDir}/package.json`));
const { version, engines }: { version: string; engines: Record<string, string> } = JSON.parse(
  await Deno.readTextFile('./package.json'),
);

await Deno.remove(outDir, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

await run('npx', ['tsc', '-p', 'tsconfig.build.json'], 'tsc failed to build the studio server');
await run(
  'node',
  [
    'node_modules/vite/bin/vite.js',
    'build',
    '--config',
    'app/vite.config.ts',
    '--outDir',
    `${Deno.cwd()}/${outDir}/${BUILT_PAGE}`,
    '--logLevel',
    'error',
  ],
  'vite failed to build the studio page',
  { THEOREM_STUDIO_PROJECT: PROJECT_PLACEHOLDER },
);

for (const file of [...launchers, 'deno.json']) {
  await Deno.copyFile(`${studioDir}/${file}`, `${outDir}/${file}`);
}
await Deno.chmod(`${outDir}/start.mjs`, 0o755);
await Deno.copyFile(`${studioDir}/README.md`, `${outDir}/README.md`);
await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);
await copyAssets(`${studioDir}/ui`, `${outDir}/ui`);

// A stylesheet import is a side effect of the JS module; its declarations carry no types, and tsc
// keeps the import there, where a consumer's typecheck cannot resolve it.
const cssImport = /^import ['"][^'"]+\.css['"];\n/gm;
const sideEffects = ['**/*.css'];
for await (const file of walkFiles(`${outDir}/ui`)) {
  const text = await Deno.readTextFile(file);
  if (!text.match(cssImport)) continue;
  if (file.endsWith('.d.ts')) await Deno.writeTextFile(file, text.replace(cssImport, ''));
  else if (file.endsWith('.js')) sideEffects.push(`./${file.slice(outDir.length + 1)}`);
}

// The manifest declares which modules have side effects, so a bundler that
// reads the source (a linked checkout) drops what goes unused exactly as it
// does from the published package; the build checks the declaration is whole.
const declared = manifest.sideEffects.map(builtSideEffect).sort();
if (JSON.stringify(declared) !== JSON.stringify(sideEffects.sort())) {
  throw new Error(
    `studio/package.json sideEffects must name every module that imports a stylesheet: it declares ${JSON.stringify(declared)}, the build finds ${JSON.stringify(sideEffects)}`,
  );
}

const pkg = {
  name: manifest.name,
  version,
  description:
    "Theorem Studio: open a project's agents in a local studio on Deno, edit and run them, and save back to its files; or show the studio screen in a Vite app.",
  license: 'MIT',
  type: manifest.type,
  engines,
  repository: {
    type: 'git',
    url: 'git+https://github.com/masudl-hub/theoremai.git',
    directory: 'studio',
  },
  // npm publish drops a bin path that starts with "./".
  bin: { 'theorem-studio': 'start.mjs' },
  sideEffects: declared,
  exports: Object.fromEntries(
    Object.entries(manifest.exports).flatMap(([entry, source]) => builtExports(entry, source)),
  ),
  // The project's server reads and writes the project's TypeScript with the compiler.
  dependencies: { ...manifest.dependencies, typescript: manifest.devDependencies.typescript },
  peerDependencies: {
    ...manifest.peerDependencies,
    '@theoremjs/agents': version,
    '@theoremjs/react': version,
  },
};
await Deno.writeTextFile(`${outDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

type Built = { types: string; default: string };

/**
 * An export as tsc built it: the declarations it is checked against, and the module. `./ui/*`
 * keeps the extension a host imports a screen file by, and its stylesheets ship as they are.
 */
function builtExports(entry: string, source: string): [string, Built | string][] {
  if (entry === './ui/*') {
    const ui = { types: './ui/*.d.ts', default: './ui/*.js' };
    return [
      ['./ui/*.tsx', ui],
      ['./ui/*.ts', ui],
      ['./ui/*.css', './ui/*.css'],
    ];
  }
  const module = source.match(/^(.*)\.(ts|mjs)$/);
  if (!module) throw new Error(`studio/package.json exports ${source}, which tsc does not build`);
  const [, built, extension] = module;
  return [
    [
      entry,
      extension === 'ts'
        ? { types: `${built}.d.ts`, default: `${built}.js` }
        : { types: `${built}.d.mts`, default: `${built}.mjs` },
    ],
  ];
}

/**
 * What tsc does not write: stylesheets, the prebuilt theme, and the declarations for modules the
 * screen's code imports that ship none.
 */
async function copyAssets(from: string, to: string) {
  for await (const entry of Deno.readDir(from)) {
    const source = `${from}/${entry.name}`;
    const target = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyAssets(source, target);
    } else if (/\.d\.ts$/.test(entry.name) || !/\.tsx?$/.test(entry.name)) {
      await Deno.mkdir(to, { recursive: true });
      await Deno.copyFile(source, target);
    }
  }
}

/** A declared source path as the module it builds to; globs stay as they are. */
function builtSideEffect(path: string): string {
  return path.replace(/\.tsx?$/, '.js');
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(path);
    else if (entry.isFile) yield path;
  }
}

async function run(command: string, args: string[], failure: string, env?: Record<string, string>) {
  const { success } = await new Deno.Command(command, {
    args,
    cwd: studioDir,
    stdout: 'inherit',
    stderr: 'inherit',
    ...(env ? { env } : {}),
  }).output();
  if (!success) throw new Error(failure);
}
