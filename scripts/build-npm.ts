import { build, emptyDir } from '@deno/dnt';

const outDir = './npm';
const version = JSON.parse(await Deno.readTextFile('./package.json')).version as string;

await emptyDir(outDir);

await build({
  entryPoints: [
    { name: '.', path: './mod.ts' },
    { name: './kernel', path: './src/kernel/mod.ts' },
    { name: './providers', path: './src/providers/mod.ts' },
    { name: './providers/local', path: './src/providers/local/mod.ts' },
    { name: './guardrails', path: './src/guardrails/mod.ts' },
    { name: './guardrails/testing', path: './src/guardrails/testing.ts' },
    { name: './observability', path: './src/observability/mod.ts' },
    { name: './host', path: './src/host/mod.ts' },
    { name: './cli', path: './src/cli/index.ts' },
    { name: './presets', path: './src/presets/mod.ts' },
    { name: './presets/google', path: './src/presets/google.ts' },
    {
      kind: 'bin',
      name: 'theorum',
      path: './src/cli/index.ts',
    },
  ],
  outDir,
  scriptModule: false,
  test: false,
  declaration: 'inline',
  shims: {
    deno: true,
  },
  compilerOptions: {
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    target: 'ES2022',
    strict: true,
  },
  package: {
    name: 'theorum',
    version,
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
    peerDependencies: {
      zod: '^4.1.8',
    },
    repository: {
      type: 'git',
      url: 'https://github.com/masudl-hub/theorum',
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
    const pkg = JSON.parse(await Deno.readTextFile(pkgPath)) as {
      bin?: Record<string, string> | string;
    };
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
