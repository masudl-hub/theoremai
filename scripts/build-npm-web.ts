/**
 * Builds `@theoremjs/web` into `web/npm`: tsc emits JS and declarations from
 * `web/src`, the audio worklet is copied beside them, and the manifest is
 * `web/package.json` with its exports pointed at the built files. The package
 * ships in lockstep with the kernel: the version, the runtime floor and the
 * `@theoremjs/agents` peer range come from the root manifest.
 */

const webDir = './web';
const srcDir = `${webDir}/src`;
const outDir = `${webDir}/npm`;
/** Shipped as they are: tsc emits nothing for them. */
const assetDirs = ['client/worklets'];

type WebManifest = {
  name: string;
  description: string;
  type: string;
  sideEffects: boolean;
  exports: Record<string, string>;
  peerDependencies: Record<string, string>;
};

const manifest: WebManifest = JSON.parse(await Deno.readTextFile(`${webDir}/package.json`));
const { version, engines }: { version: string; engines: Record<string, string> } = JSON.parse(
  await Deno.readTextFile('./package.json'),
);

await Deno.remove(outDir, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});

const tsc = await new Deno.Command('npx', {
  args: ['tsc', '-p', 'tsconfig.build.json'],
  cwd: webDir,
  stdout: 'inherit',
  stderr: 'inherit',
}).output();
if (!tsc.success) throw new Error('tsc failed to build @theoremjs/web');

for (const dir of assetDirs) {
  await Deno.mkdir(`${outDir}/${dir}`, { recursive: true });
  for await (const entry of Deno.readDir(`${srcDir}/${dir}`)) {
    if (entry.isFile)
      await Deno.copyFile(`${srcDir}/${dir}/${entry.name}`, `${outDir}/${dir}/${entry.name}`);
  }
}
await Deno.copyFile(`${webDir}/README.md`, `${outDir}/README.md`);
await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);

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
    directory: 'web',
  },
  sideEffects: manifest.sideEffects,
  exports: Object.fromEntries(
    Object.entries(manifest.exports).map(([name, path]) => [name, builtExport(path)]),
  ),
  peerDependencies: { ...manifest.peerDependencies, '@theoremjs/agents': `^${version}` },
};
await Deno.writeTextFile(`${outDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

/** `./src/x.ts` → its built JS and declarations. */
function builtExport(path: string): { types: string; default: string } {
  const module = path.match(/^\.\/src\/(.*)\.ts$/);
  if (!module) throw new Error(`web export ${path} is not a module under src/`);
  return { types: `./${module[1]}.d.ts`, default: `./${module[1]}.js` };
}
