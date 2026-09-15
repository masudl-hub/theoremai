/**
 * Fail fast before `deno publish` if local artifact trees or oversized files
 * could leak into the JSR tarball (especially with `--allow-dirty`).
 */
const root = new URL('..', import.meta.url).pathname;

/** Paths that must never ship; each must appear in deno.json publish.exclude. */
const ARTIFACT_DIRS = [
  '.stryker-cache',
  '.stryker-tmp',
  'coverage',
  'cov_profile',
  'traces',
  'npm',
  'node_modules',
  '.fallow',
  '.github',
  'tests',
  'scripts',
  'ast-grep-rules',
  'docs',
  'playground',
] as const;

const ARTIFACT_FILES = [
  'knip.json',
  'stryker.config.json',
  'stryker.log',
  '.fallowrc.jsonc',
  'biome.json',
  'sgconfig.yml',
  'package-lock.json',
  'deno.lock',
  '.npmignore',
] as const;

/** Repo-maintainer markdown that must stay out of JSR / npm publish. */
const REPO_DOC_GLOBS = ['src/**/*.md'] as const;

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface DenoConfig {
  publish?: { exclude?: string[] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPublishExclude(): Promise<Set<string>> {
  const text = await Deno.readTextFile(`${root}/deno.json`);
  const config = JSON.parse(text) as DenoConfig;
  return new Set(config.publish?.exclude ?? []);
}

function normalizeExclude(entry: string): string {
  return entry.replace(/\/$/, '');
}

function assertPublishExcludeCoversArtifacts(exclude: Set<string>): void {
  const normalized = new Set([...exclude].map(normalizeExclude));
  const missing: string[] = [];

  for (const dir of ARTIFACT_DIRS) {
    const covered = [...normalized].some((e) => e === dir || e === `${dir}/`);
    if (!covered) missing.push(`${dir}/`);
  }
  for (const file of ARTIFACT_FILES) {
    if (!normalized.has(file)) missing.push(file);
  }
  for (const glob of REPO_DOC_GLOBS) {
    if (![...normalized].includes(glob)) missing.push(glob);
  }

  if (missing.length > 0) {
    throw new Error(
      `deno.json publish.exclude is missing artifact paths:\n  ${missing.join('\n  ')}`,
    );
  }
}

async function assertNpmPackageFilesOmitRepoDocs(): Promise<void> {
  const pkg = JSON.parse(await Deno.readTextFile(`${root}/package.json`)) as {
    files?: string[];
  };
  const files = pkg.files ?? [];
  if (files.some((f) => f === 'docs' || f === 'docs/' || f.startsWith('docs/'))) {
    throw new Error(
      'package.json files must not include docs/ (repo contracts / docs-truth are not package docs)',
    );
  }
  const npmignore = await Deno.readTextFile(`${root}/.npmignore`).catch(() => '');
  if (!npmignore.includes('docs/') || !npmignore.includes('src/**/*.md')) {
    throw new Error('.npmignore must exclude docs/ and src/**/*.md from the npm tarball');
  }
}

async function findOversizedFiles(): Promise<string[]> {
  const hits: string[] = [];

  /** Artifact trees that may exist locally but must never contain huge blobs. */
  const sizeScanDirs = [
    '.stryker-cache',
    '.stryker-tmp',
    'coverage',
    'cov_profile',
    'traces',
    '.fallow',
  ] as const;

  for (const dir of sizeScanDirs) {
    const path = `${root}/${dir}`;
    if (!(await exists(path))) continue;
    for await (const file of walkFiles(path)) {
      const stat = await Deno.stat(file);
      if (stat.size > MAX_FILE_BYTES) hits.push(file);
    }
  }

  for await (const entry of Deno.readDir(root)) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (!entry.isFile) continue;
    const path = `${root}/${entry.name}`;
    const stat = await Deno.stat(path);
    if (stat.size > MAX_FILE_BYTES) hits.push(path);
  }

  return hits;
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === 'node_modules') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkFiles(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}

async function assertNoExportedInternals(): Promise<void> {
  const hits: string[] = [];
  for await (const file of walkFiles(`${root}/src`)) {
    if (!file.endsWith('.ts')) continue;
    const text = await Deno.readTextFile(file);
    if (/export\s+const\s+_internals\b/.test(text)) {
      hits.push(file.replace(root, '.'));
    }
  }
  if (hits.length > 0) {
    throw new Error(`Published source must not export _internals:\n  ${hits.join('\n  ')}`);
  }
}

async function assertPublicEntrypointsOmitTestHooks(): Promise<void> {
  const entrypoints = [
    'mod.ts',
    'src/kernel/mod.ts',
    'src/providers/mod.ts',
    'src/guardrails/mod.ts',
    'src/observability/mod.ts',
    'src/host/mod.ts',
    'src/presets/mod.ts',
  ];
  const hits: string[] = [];
  for (const rel of entrypoints) {
    const text = await Deno.readTextFile(`${root}/${rel}`);
    if (/exposeForTests|__theorumTestInternals|THEORUM_TEST_INTERNALS|_internals/.test(text)) {
      hits.push(rel);
    }
  }
  if (hits.length > 0) {
    throw new Error(`Public entrypoints must not re-export test hooks:\n  ${hits.join('\n  ')}`);
  }
}

/** Global test backdoors must not exist anywhere under src/ (natural spellings). */
async function assertNoGlobalTestInternals(): Promise<void> {
  const banned = /exposeForTests|__theorumTestInternals|THEORUM_TEST_INTERNALS/;
  const hits: string[] = [];
  for await (const file of walkFiles(`${root}/src`)) {
    if (!file.endsWith('.ts')) continue;
    const text = await Deno.readTextFile(file);
    if (banned.test(text)) {
      hits.push(file.replace(root, '.'));
    }
  }
  if (hits.length > 0) {
    throw new Error(
      `src/ must not contain exposeForTests / __theorumTestInternals / THEORUM_TEST_INTERNALS:\n  ${hits.join('\n  ')}`,
    );
  }
}

/**
 * The playground demo package is repo-private and must never ship: no
 * `./playground` entry in any exports map, no `playground/` in the npm files
 * whitelist or tarball, and no `src/playground` tree resurrected.
 */
async function assertNoPlaygroundInBundles(): Promise<void> {
  const pkg = JSON.parse(await Deno.readTextFile(`${root}/package.json`)) as {
    files?: string[];
    exports?: Record<string, unknown>;
  };
  if (Object.keys(pkg.exports ?? {}).some((key) => key.includes('playground'))) {
    throw new Error('package.json exports must not include a playground entrypoint');
  }
  if ((pkg.files ?? []).some((f) => f.includes('playground'))) {
    throw new Error('package.json files must not include playground/');
  }
  const denoConfig = JSON.parse(await Deno.readTextFile(`${root}/deno.json`)) as {
    exports?: Record<string, unknown>;
  };
  if (Object.keys(denoConfig.exports ?? {}).some((key) => key.includes('playground'))) {
    throw new Error('deno.json exports must not include a playground entrypoint');
  }
  const npmignore = await Deno.readTextFile(`${root}/.npmignore`).catch(() => '');
  if (!npmignore.includes('playground/')) {
    throw new Error('.npmignore must exclude playground/ from the npm tarball');
  }
  if (await exists(`${root}/src/playground`)) {
    throw new Error(
      'src/playground must not exist — demo fixtures live in repo-private playground/',
    );
  }
  // dnt output tree, when present, must not contain a playground module.
  if (await exists(`${root}/npm`)) {
    for await (const file of walkFiles(`${root}/npm`)) {
      if (file.includes('/playground/')) {
        throw new Error(`npm build output must not contain playground modules: ${file}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const exclude = await readPublishExclude();
  assertPublishExcludeCoversArtifacts(exclude);
  await assertNpmPackageFilesOmitRepoDocs();
  await assertNoPlaygroundInBundles();
  await assertNoExportedInternals();
  await assertPublicEntrypointsOmitTestHooks();
  await assertNoGlobalTestInternals();

  const oversized = await findOversizedFiles();
  if (oversized.length > 0) {
    const lines = oversized.map((p) => `  ${p.replace(root, '.')}`).join('\n');
    throw new Error(
      `Oversized files (> ${MAX_FILE_BYTES} bytes) must not exist before publish:\n${lines}`,
    );
  }

  console.log(
    'verify-publish-bundle: exclude list covers artifacts; repo docs omitted from package; playground absent from all bundles; no exported _internals; no global test internals in src/; no oversized local files.',
  );
}

await main();
