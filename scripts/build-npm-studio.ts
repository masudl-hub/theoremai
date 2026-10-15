/**
 * Builds `@theoremjs/studio` into `studio/npm`: the command (`theorem-studio`), the project's
 * server built to JavaScript, and the page built in advance. Deno runs no TypeScript from
 * `node_modules`, so tsc writes the server's JavaScript; Deno checks it. Vite builds the page with
 * the kernel's declarations in it, so the studio ships in lockstep with the kernel and the React
 * package: the version, the runtime floor and both peers come from the root manifest, pinned.
 */
import { BUILT_PAGE, PROJECT_PLACEHOLDER } from '../studio/page.mjs';

const studioDir = './studio';
const outDir = `${studioDir}/npm`;
/** The command and what it loads: the launcher, its checks and the page's server. */
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

const pkg = {
  name: manifest.name,
  version,
  description:
    "Theorem Studio: open a project's agents in a local studio, edit and run them, and save back to its files. Runs on Deno.",
  license: 'MIT',
  type: manifest.type,
  engines,
  repository: {
    type: 'git',
    url: 'https://github.com/masudl-hub/theoremai',
    directory: 'studio',
  },
  bin: { 'theorem-studio': './start.mjs' },
  // The project's server reads and writes the project's TypeScript with the compiler.
  dependencies: { typescript: manifest.devDependencies.typescript },
  peerDependencies: {
    '@theoremjs/agents': version,
    '@theoremjs/react': version,
    zod: manifest.peerDependencies.zod,
  },
};
await Deno.writeTextFile(`${outDir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);

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
