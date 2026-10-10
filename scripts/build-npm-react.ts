/**
 * Builds `@theoremjs/react` into `react/npm`: tsc emits JS and declarations
 * from `react/src`, the generated theme and stylesheets are copied beside
 * them, and the manifest is `react/package.json` with its exports pointed at
 * the built files. The two packages ship in lockstep: the version, the runtime
 * floor and the `@theoremjs/agents` peer range come from the root manifest.
 */

const reactDir = './react';
const srcDir = `${reactDir}/src`;
const outDir = `${reactDir}/npm`;
/** Shipped as they are: tsc emits nothing for them. */
const assetDirs = ['client/worklets', 'styles', 'ui/built'];

type ReactManifest = {
  name: string;
  description: string;
  type: string;
  exports: Record<string, string>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
};

const manifest: ReactManifest = JSON.parse(await Deno.readTextFile(`${reactDir}/package.json`));
const { version, engines }: { version: string; engines: Record<string, string> } = JSON.parse(
  await Deno.readTextFile('./package.json'),
);

await Deno.remove(outDir, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

const tsc = await new Deno.Command('npx', {
  args: ['tsc', '-p', 'tsconfig.build.json'],
  cwd: reactDir,
  stdout: 'inherit',
  stderr: 'inherit',
}).output();
if (!tsc.success) throw new Error('tsc failed to build @theoremjs/react');

for (const dir of assetDirs) {
  await Deno.mkdir(`${outDir}/${dir}`, { recursive: true });
  for await (const entry of Deno.readDir(`${srcDir}/${dir}`)) {
    if (entry.isFile)
      await Deno.copyFile(`${srcDir}/${dir}/${entry.name}`, `${outDir}/${dir}/${entry.name}`);
  }
}
await Deno.copyFile(`${reactDir}/README.md`, `${outDir}/README.md`);
await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);

// A stylesheet import is a side effect of the JS module; its declarations carry
// no types, and tsc keeps the import there, where a consumer's typecheck
// cannot resolve it.
const cssImport = /^import ['"][^'"]+\.css['"];\n/gm;
const sideEffects = ['**/*.css'];
for await (const file of walkFiles(outDir)) {
  const text = await Deno.readTextFile(file);
  if (!text.match(cssImport)) continue;
  if (file.endsWith('.d.ts')) {
    await Deno.writeTextFile(file, text.replace(cssImport, ''));
  } else if (file.endsWith('.js')) {
    sideEffects.push(`./${file.slice(outDir.length + 1)}`);
  }
}

const pkg = {
  name: manifest.name,
  version,
  description: manifest.description,
  license: 'MIT',
  type: manifest.type,
  engines,
  repository: {
    type: 'git',
    url: 'https://github.com/masudl-hub/theoremai',
    directory: 'react',
  },
  sideEffects: sideEffects.sort(),
  exports: Object.fromEntries(
    Object.entries(manifest.exports).map(([name, path]) => [name, builtExport(path)]),
  ),
  dependencies: manifest.dependencies,
  peerDependencies: { ...manifest.peerDependencies, '@theoremjs/agents': `^${version}` },
  peerDependenciesMeta: manifest.peerDependenciesMeta,
};
await Deno.writeTextFile(`${outDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

/** `./src/x.ts(x)` → its built JS and declarations; anything else ships at its path under `src`. */
function builtExport(path: string): string | { types: string; default: string } {
  if (!path.startsWith('./src/')) throw new Error(`react export ${path} is outside src/`);
  const built = `./${path.slice('./src/'.length)}`;
  const module = built.match(/^(.*)\.tsx?$/);
  if (!module) return built;
  return { types: `${module[1]}.d.ts`, default: `${module[1]}.js` };
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkFiles(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}
