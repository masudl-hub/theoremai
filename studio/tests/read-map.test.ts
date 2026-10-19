import { assertEquals } from '@std/assert';
import type { ReadStep } from '../read-steps.ts';
import { readMap } from '../ui/lib/read-map.ts';

const STEPS: ReadStep[] = [
  { file: 'studio.setup.ts' },
  { file: 'backend/theorem/profiles/thinker.ts', from: 'studio.setup.ts' },
  { file: 'backend/theorem/tools/places.ts', from: 'studio.setup.ts' },
  { file: 'backend/theorem/tools/plants.ts', from: 'backend/theorem/tools/places.ts' },
  { file: 'backend/infrastructure/providers.ts', from: 'backend/theorem/profiles/thinker.ts' },
  { found: 'profile', name: 'bonsai.thinker', file: 'backend/theorem/profiles/thinker.ts' },
  { found: 'tool', name: 'search_places', file: 'backend/theorem/tools/places.ts' },
  { found: 'tool', name: 'remove_plant', file: 'backend/theorem/tools/plants.ts' },
];

const by = (map: ReturnType<typeof readMap>) =>
  Object.fromEntries(map.nodes.map((node) => [node.id, node]));

Deno.test('the setup file is on the left, folders branch from it, and what is found is on the right', () => {
  const map = readMap(STEPS, 12);
  const nodes = by(map);
  assertEquals(
    [nodes.entry?.label, nodes.entry?.col, nodes.entry?.own],
    ['studio.setup.ts', 0, [0]],
  );
  // A folder that only holds one other is named by the whole path.
  assertEquals(nodes['folder:backend/theorem/profiles']?.label, 'profiles');
  assertEquals(nodes['folder:backend/theorem']?.label, 'theorem');
  assertEquals(nodes['folder:backend/theorem/tools']?.own, [2, 3]);
  // Each node is drawn at the step that first reaches it.
  assertEquals(nodes['folder:backend/infrastructure']?.first, 4);
  assertEquals(nodes['tool:remove_plant']?.first, 7);
  assertEquals(nodes['tool:remove_plant']?.col, map.cols - 1);
  assertEquals(nodes['tool:remove_plant']?.parent, 'folder:backend/theorem/tools');
  assertEquals(map.rows, 4);
});

Deno.test('with few rows the folders are told apart less, and what is found is counted', () => {
  const map = readMap(STEPS, 2);
  const nodes = by(map);
  assertEquals(nodes['folder:backend/theorem']?.own, [1, 2, 3]);
  assertEquals(nodes['folder:backend/theorem/tools'], undefined);
  assertEquals(
    map.nodes.filter((node) => node.kind === 'more').map((node) => node.label),
    ['3 agents and tools'],
  );
  assertEquals(map.rows, 2);
});

Deno.test('folders past the rows are folded into the last one kept', () => {
  const steps: ReadStep[] = [
    { file: 'setup.ts' },
    { file: 'a/x.ts' },
    { file: 'b/x.ts' },
    { file: 'c/x.ts' },
  ];
  const nodes = by(readMap(steps, 2));
  assertEquals(nodes['folder:b']?.label, 'b and 1 more');
  assertEquals(nodes['folder:b']?.own, [2, 3]);
  assertEquals(nodes['folder:c'], undefined);
});

Deno.test('a project of one file is that file', () => {
  const map = readMap([{ file: 'setup.ts' }], 8);
  assertEquals(
    map.nodes.map((node) => [node.id, node.row]),
    [['entry', 0]],
  );
});

Deno.test('an agent and a tool keep the type their file writes, and one without has none', () => {
  const typed: ReadStep[] = [
    { file: 'studio.setup.ts' },
    { file: 'backend/tools/places.ts', from: 'studio.setup.ts' },
    {
      found: 'profile',
      name: 'bonsai.pagereader',
      file: 'backend/tools/places.ts',
      type: 'decision',
    },
    { found: 'tool', name: 'search_places', file: 'backend/tools/places.ts', type: 'http' },
    { found: 'tool', name: 'remove_plant', file: 'backend/tools/places.ts' },
  ];
  const nodes = by(readMap(typed, 6));
  assertEquals(nodes['profile:bonsai.pagereader']?.type, 'decision');
  assertEquals(nodes['tool:search_places']?.type, 'http');
  assertEquals('type' in (nodes['tool:remove_plant'] ?? {}), false);
});
