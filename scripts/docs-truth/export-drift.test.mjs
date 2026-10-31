import assert from 'node:assert/strict';
import test from 'node:test';
import { entrypointSubpaths, sectionOf, tableNames } from './export-drift.mjs';

const doc = [
  '# Package',
  '## Exported API',
  'Prose names `notAnExport`.',
  '',
  '| Group | Symbols |',
  '| --- | --- |',
  '| Runner | `runTurn`, `TurnRequest` — see `src/kernel/types.ts` |',
  '',
  '### Exported by role',
  '',
  '| Export | Role |',
  '| --- | --- |',
  '| `defineAction(action)` | Takes `fieldName` |',
  '',
  '## Public Entrypoints',
  '',
  '| Entrypoint | Purpose |',
  '| --- | --- |',
  '| `jsr:@theoremjs/agents` / `@theoremjs/agents` | Root |',
  '| `jsr:@theoremjs/agents/kernel` / `@theoremjs/agents/kernel` | Uses `@theoremjs/agents/interface` |',
].join('\n');

test('a section runs to the next heading of its level, through deeper ones', () => {
  const lines = sectionOf(doc, 'Exported API');
  assert.ok(lines.includes('### Exported by role'));
  assert.ok(!lines.includes('## Public Entrypoints'));
  assert.equal(sectionOf(doc, 'Missing'), null);
});

test('names come only from the Symbols or Export column of each table', () => {
  assert.deepEqual([...tableNames(sectionOf(doc, 'Exported API'))].sort(), [
    'TurnRequest',
    'defineAction',
    'runTurn',
  ]);
  assert.equal(tableNames(['Prose names `runTurn`.']), null);
});

test('entrypoints are read from the first column as subpaths', () => {
  assert.deepEqual(
    [...entrypointSubpaths(sectionOf(doc, 'Public Entrypoints'))],
    ['.', './kernel'],
  );
});
