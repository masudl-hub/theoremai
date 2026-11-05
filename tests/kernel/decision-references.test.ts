import { assertEquals } from '@std/assert';
import { referencedAssets, splitReferences } from '../../src/kernel/engine/decision-references.ts';

const a = { mimeType: 'image/png', data: 'AAAA' } as const;
const b = { mimeType: 'image/jpeg', data: 'BBBB' } as const;

Deno.test('a reference is read as TypeSafe reads it: whole value, then left to right, longest first', () => {
  assertEquals(splitReferences('cat', { cat: a }), [{ reference: 'cat', asset: a }]);
  assertEquals(splitReferences('See cat and dog.', { cat: a, dog: b }), [
    'See ',
    { reference: 'cat', asset: a },
    ' and ',
    { reference: 'dog', asset: b },
    '.',
  ]);
  assertEquals(splitReferences('catalog', { cat: a, catalog: b }), [
    { reference: 'catalog', asset: b },
  ]);
  assertEquals(splitReferences('xcatalogx', { cat: a, catalog: b }), [
    'x',
    { reference: 'catalog', asset: b },
    'x',
  ]);
  assertEquals(splitReferences('no images here', { cat: a }), ['no images here']);
});

Deno.test('only the images a string value references are kept; keys are never read', () => {
  assertEquals(
    referencedAssets([{ photo: 'It is <a>.', '<b>': 'key' }, undefined, ['plain']], {
      '<a>': a,
      '<b>': b,
    }),
    { '<a>': a },
  );
});
