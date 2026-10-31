import assert from 'node:assert/strict';
import test from 'node:test';
import { entriesForFile, lintDocsTruth, normalizePath, pathRuleMatches } from './graph.mjs';

test('pathRuleMatches supports trailing slash and globs', () => {
  assert.equal(pathRuleMatches('src/kernel/', 'src/kernel/mod.ts'), true);
  assert.equal(pathRuleMatches('src/kernel/', 'src/providers/mod.ts'), false);
  assert.equal(pathRuleMatches('src/providers/*.ts', 'src/providers/mod.ts'), true);
  assert.equal(pathRuleMatches('src/**/stop.ts', 'src/kernel/stop.ts'), true);
});

test('providers owns openrouter adapter modules', async () => {
  const { default: graph } = await import('../../docs/_map.mjs');
  const openrouterOwners = entriesForFile(
    graph,
    normalizePath('src/providers/openrouter/chat.ts'),
    {
      ownsOnly: true,
    },
  );
  assert.deepEqual(
    openrouterOwners.map(([id]) => id),
    ['providers'],
  );

  const localOwners = entriesForFile(graph, normalizePath('src/providers/local/local.ts'), {
    ownsOnly: true,
  });
  assert.deepEqual(
    localOwners.map(([id]) => id),
    ['providers'],
  );
});

test('package publish surface omits repo contracts and docs-truth', async () => {
  const root = new URL('../..', import.meta.url).pathname;
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const deno = JSON.parse(await readFile(`${root}/deno.json`, 'utf8'));
  const npmignore = await readFile(`${root}/.npmignore`, 'utf8');

  const files = pkg.files ?? [];
  assert.equal(
    files.some((f) => f === 'docs' || f === 'docs/' || f.startsWith('docs/')),
    false,
    'package.json files must not include docs/',
  );
  assert.ok(files.includes('README.md'), 'package.json files must include README.md');

  const exclude = deno.publish?.exclude ?? [];
  assert.ok(
    exclude.includes('docs/') || exclude.includes('docs'),
    'deno publish.exclude must list docs/',
  );
  assert.ok(exclude.includes('src/**/*.md'), 'deno publish.exclude must list src/**/*.md');

  assert.match(npmignore, /docs\//);
  assert.match(npmignore, /src\/\*\*\/\*\.md/);
});

test('lint passes on current repo graph', async () => {
  const result = await lintDocsTruth({
    repoRoot: new URL('../..', import.meta.url).pathname,
    changedFiles: [],
  });
  assert.equal(result.errors.length, 0, result.errors.join('\n'));
});

test('React source and package changes require the React README', async () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  for (const file of [
    'react/src/client/voice-recorder.ts',
    'react/src/ui/TheoremChat.tsx',
    'react/src/styles/ink-controls.css',
    'react/package.json',
  ]) {
    const { access } = await import('node:fs/promises');
    await access(`${repoRoot}/${file}`);
    const stale = await lintDocsTruth({ repoRoot, changedFiles: [file] });
    assert.ok(
      stale.errors.some((error) =>
        error.includes(`${file}: changed without touching owning doc react/README.md`),
      ),
      stale.errors.join('\n'),
    );
    const fresh = await lintDocsTruth({ repoRoot, changedFiles: [file, 'react/README.md'] });
    assert.equal(fresh.errors.length, 0, fresh.errors.join('\n'));
  }
});

test('web source and package changes require the web README', async () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  for (const file of [
    'web/src/client/live-client.ts',
    'web/src/server/handler.ts',
    'web/src/client/worklets/mic-capture.js',
    'web/package.json',
  ]) {
    const { access } = await import('node:fs/promises');
    await access(`${repoRoot}/${file}`);
    const stale = await lintDocsTruth({ repoRoot, changedFiles: [file] });
    assert.ok(
      stale.errors.some((error) =>
        error.includes(`${file}: changed without touching owning doc web/README.md`),
      ),
      stale.errors.join('\n'),
    );
    const fresh = await lintDocsTruth({ repoRoot, changedFiles: [file, 'web/README.md'] });
    assert.equal(fresh.errors.length, 0, fresh.errors.join('\n'));
  }
});

test('studio changes require the studio README, and its runtime and packaging the studio contract', async () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  for (const file of [
    'studio/ui/studio-screen.tsx',
    'studio/server/draft-handler.ts',
    'studio/package.json',
  ]) {
    const stale = await lintDocsTruth({ repoRoot, changedFiles: [file] });
    assert.ok(
      stale.errors.some((error) =>
        error.includes(`${file}: changed without touching owning doc studio/README.md`),
      ),
      stale.errors.join('\n'),
    );
    const fresh = await lintDocsTruth({ repoRoot, changedFiles: [file, 'studio/README.md'] });
    assert.equal(fresh.errors.length, 0, fresh.errors.join('\n'));
  }
  for (const file of ['studio/runtime.ts', 'scripts/build-npm-studio.ts']) {
    const stale = await lintDocsTruth({ repoRoot, changedFiles: [file, 'studio/README.md'] });
    assert.ok(
      stale.errors.some((error) => error.includes('docs/contracts/studio.md')),
      stale.errors.join('\n'),
    );
    const fresh = await lintDocsTruth({
      repoRoot,
      changedFiles: [file, 'studio/README.md', 'docs/contracts/studio.md'],
    });
    assert.equal(fresh.errors.length, 0, fresh.errors.join('\n'));
  }
});

test('provider and session changes also require the React guide', async () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  for (const file of [
    'src/kernel/protocols/provider.ts',
    'src/interface/session.ts',
    'src/kernel/provider-live.ts',
  ]) {
    const stale = await lintDocsTruth({
      repoRoot,
      changedFiles: [file, 'docs/contracts/kernel.md'],
    });
    assert.ok(
      stale.errors.some((error) =>
        error.includes(`${file}: changed without touching owning doc react/README.md`),
      ),
      stale.errors.join('\n'),
    );
  }
});
