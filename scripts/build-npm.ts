import { build, emptyDir } from '@deno/dnt';

const outDir = './npm';
const rootManifest: {
  version: string;
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
} = JSON.parse(await Deno.readTextFile('./package.json'));
// deno.json is the one export map and import map; npm gets the same entry points and zod range.
const {
  exports: exportMap,
  imports,
}: {
  exports: Record<string, string>;
  imports: Record<string, string>;
} = JSON.parse(await Deno.readTextFile('./deno.json'));
const zodSpecifier = imports.zod;
const zodVersion = zodSpecifier?.match(/^npm:zod@(.+)$/)?.[1];
if (!zodSpecifier || !zodVersion) throw new Error('deno.json must import zod as npm:zod@<range>');

await emptyDir(outDir);

await build({
  entryPoints: [
    ...Object.entries(exportMap).map(([name, path]) => ({ name, path })),
    {
      kind: 'bin',
      name: 'agents',
      path: './src/cli/bin.ts',
    },
  ],
  outDir,
  scriptModule: false,
  test: false,
  declaration: 'inline',
  // Published code reaches the platform through Web APIs and `node:` built-ins only, so npm
  // consumers (browser bundles included) get no Deno shim.
  shims: {},
  // The host and the kernel must share one zod: schemas cross the boundary.
  mappings: {
    [zodSpecifier]: { name: 'zod', version: zodVersion, peerDependency: true },
  },
  compilerOptions: {
    lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    target: 'ES2023',
  },
  package: {
    name: '@theoremjs/agents',
    version: rootManifest.version,
    engines: rootManifest.engines,
    description:
      'A flat TypeScript agent kernel for typed profiles, deterministic turn execution, registered tools, provider adapters, guardrails, and host-injected traces.',
    license: 'MIT',
    type: 'module',
    keywords: [
      'agent',
      'ai',
      'kernel',
      'llm',
      'typescript',
      'deno',
      'node',
      'openrouter',
      'gemini',
    ],
    sideEffects: false,
    // dnt type-checks against these; the `node:` built-ins need Node's types.
    devDependencies: {
      '@types/node': rootManifest.devDependencies['@types/node'],
    },
    repository: {
      type: 'git',
      url: 'https://github.com/masudl-hub/theoremai',
    },
  },
  postBuild: async () => {
    await Deno.copyFile('README.md', `${outDir}/README.md`);
    await Deno.copyFile('LICENSE', `${outDir}/LICENSE`);

    // Repo contracts / docs-truth must not ship. dnt may copy co-located *.md
    // under esm/src — strip them from the npm tree.
    for await (const file of walkFiles(`${outDir}`)) {
      if (file.endsWith('.md') && !file.endsWith(`${outDir}/README.md`)) {
        await Deno.remove(file);
      }
    }

    // npm publish rejects bin paths with a leading "./" and silently drops them.
    // dnt emits "./esm/...", so normalize before the package is packed.
    const pkgPath = `${outDir}/package.json`;
    const pkg: { bin?: Record<string, string> | string } = JSON.parse(
      await Deno.readTextFile(pkgPath),
    );
    if (typeof pkg.bin === 'string') {
      pkg.bin = pkg.bin.replace(/^\.\//, '');
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const [name, target] of Object.entries(pkg.bin)) {
        pkg.bin[name] = target.replace(/^\.\//, '');
      }
    }
    await Deno.writeTextFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  },
});

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
