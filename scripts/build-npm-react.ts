/**
 * Builds `@theoremjs/react` into `react/npm`: tsc emits JS and declarations
 * from `react/src`, the generated theme and stylesheets are copied beside
 * them, and the manifest is `react/package.json` with its exports pointed at
 * the built files. The packages ship in lockstep: the version, the runtime
 * floor and the `@theoremjs/agents` and `@theoremjs/web` peer ranges come from
 * the root manifest.
 */

const reactDir = './react';
const srcDir = `${reactDir}/src`;
const outDir = `${reactDir}/npm`;
/** Shipped as they are: tsc emits nothing for them. */
const assetDirs = ['styles', 'ui/built'];

type ReactManifest = {
  name: string;
  description: string;
  type: string;
  sideEffects: string[];
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

// why: The local Studio prototype is type-checked but is not a public React entrypoint.
await Deno.remove(`${outDir}/studio`, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

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
// why: tsc keeps a relative `.ts` specifier as written in the declarations it emits; the package ships `.js` and `.d.ts`.
const sourceSpecifier = /((?:from |import\()['"]\.{1,2}\/[^'"]+)\.tsx?(['"])/g;
const relativeSpecifier = /(?:from |import\()['"](\.{1,2}\/[^'"]+)['"]/g;
const packageRoot = new URL(`${outDir}/`, `file://${Deno.cwd()}/`).href;
const sideEffects = ['**/*.css'];
const escaping: string[] = [];
for await (const file of walkFiles(outDir)) {
  const text = await Deno.readTextFile(file);
  if (file.endsWith('.d.ts')) {
    const shipped = text.replace(cssImport, '').replace(sourceSpecifier, '$1.js$2');
    if (shipped !== text) await Deno.writeTextFile(file, shipped);
    const at = new URL(file, `file://${Deno.cwd()}/`);
    for (const [, specifier] of shipped.matchAll(relativeSpecifier)) {
      if (!new URL(specifier, at).href.startsWith(packageRoot))
        escaping.push(`${file.slice(outDir.length + 1)}: ${specifier}`);
    }
  } else if (file.endsWith('.js') && text.match(cssImport)) {
    sideEffects.push(`./${file.slice(outDir.length + 1)}`);
  }
}
// A declaration that reaches outside the package resolves to nothing for a consumer, and its type turns `any`.
if (escaping.length > 0) {
  throw new Error(
    `@theoremjs/react declarations import from outside the package; give the type a name from a public entry:\n${escaping.join('\n')}`,
  );
}

// The manifest declares which modules have side effects, so a bundler that
// reads the source (a linked checkout) drops what goes unused exactly as it
// does from the published package; the build checks the declaration is whole.
const declared = manifest.sideEffects.map(builtSideEffect).sort();
if (JSON.stringify(declared) !== JSON.stringify(sideEffects.sort())) {
  throw new Error(
    `react/package.json sideEffects must name every module that imports a stylesheet: it declares ${JSON.stringify(declared)}, the build finds ${JSON.stringify(sideEffects)}`,
  );
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
    url: 'git+https://github.com/masudl-hub/theoremai.git',
    directory: 'react',
  },
  sideEffects: declared,
  exports: Object.fromEntries(
    Object.entries(manifest.exports).map(([name, path]) => [name, builtExport(path)]),
  ),
  dependencies: manifest.dependencies,
  peerDependencies: {
    ...manifest.peerDependencies,
    '@theoremjs/agents': `^${version}`,
    '@theoremjs/web': `^${version}`,
  },
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

/** A declared source path as the module it builds to; globs stay as they are. */
function builtSideEffect(path: string): string {
  return path.replace(/^\.\/src\//, './').replace(/\.tsx?$/, '.js');
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
