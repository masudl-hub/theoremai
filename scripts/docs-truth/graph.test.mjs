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
