import { assertEquals } from '@std/assert';
import {
  pick,
  picker,
  pickerKey,
  setupLines,
  setupOf,
  setupsAmong,
  setupsNamed,
} from '../setups.mjs';

const FILES = [
  'README.md',
  'studio.setup.ts',
  'evals/studio.setup.ts',
  'backend/support.studio.setup.ts',
  'backend/studio.setup.test.ts',
  'backend/setup.ts',
];

Deno.test('a setup is named for its folder, or by the name in front of it', () => {
  assertEquals(setupOf('studio.setup.ts', 'bonsai'), { name: 'bonsai', file: 'studio.setup.ts' });
  assertEquals(setupOf('evals/studio.setup.ts', 'bonsai')?.name, 'evals');
  assertEquals(setupOf('backend/support.studio.setup.ts', 'bonsai')?.name, 'support');
  assertEquals(setupOf('backend/studio.setup.test.ts', 'bonsai'), undefined);
  assertEquals(setupOf('backend/setup.ts', 'bonsai'), undefined);
});

Deno.test('a project lists its setups by name', () => {
  assertEquals(
    setupsAmong(FILES, 'bonsai').map((setup) => setup.name),
    ['bonsai', 'evals', 'support'],
  );
});

Deno.test('a word names a setup by its file or by its name', () => {
  const setups = setupsAmong(FILES, 'bonsai');
  assertEquals(
    setupsNamed(setups, 'support').map((setup) => setup.file),
    ['backend/support.studio.setup.ts'],
  );
  assertEquals(
    setupsNamed(setups, './evals/studio.setup.ts').map((setup) => setup.name),
    ['evals'],
  );
  assertEquals(setupsNamed(setups, 'nothing'), []);
});

Deno.test('two setups with one name are both offered', () => {
  const setups = setupsAmong(['a/web/studio.setup.ts', 'b/web/studio.setup.ts'], 'bonsai');
  assertEquals(setupsNamed(setups, 'web').length, 2);
});

Deno.test('the picker moves between the ends, chooses and leaves', () => {
  const setups = setupsAmong(FILES, 'bonsai');
  let state = picker(setups);
  state = pick(state, 'up');
  assertEquals(state.at, 0);
  state = pick(pick(pick(state, 'down'), 'down'), 'down');
  assertEquals(state.at, 2);
  assertEquals(pick(state, 'choose').chosen?.name, 'support');
  assertEquals(pick(state, 'leave').left, true);
  assertEquals(pick(state, 'leave').chosen, undefined);
});

Deno.test('arrow keys, enter, escape, and control-c are the picker keys', () => {
  assertEquals(pickerKey({ name: 'up' }), 'up');
  assertEquals(pickerKey({ name: 'j' }), 'down');
  assertEquals(pickerKey({ name: 'return' }), 'choose');
  assertEquals(pickerKey({ name: 'escape' }), 'leave');
  assertEquals(pickerKey({ name: 'c', ctrl: true }), 'leave');
  assertEquals(pickerKey({ name: 'x' }), undefined);
});

Deno.test('the list lines names up and marks the one the cursor is on', () => {
  assertEquals(setupLines(setupsAmong(FILES, 'bonsai'), 1), [
    '  bonsai   studio.setup.ts',
    '› evals    evals/studio.setup.ts',
    '  support  backend/support.studio.setup.ts',
  ]);
});
