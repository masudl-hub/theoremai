import { assertEquals } from '@std/assert';
import { blankLike, isWordList, tableColumns } from '../../react/src/client/state-fields.ts';

Deno.test('a new list row keeps the last row’s fields with their values emptied', () => {
  assertEquals(
    blankLike({ role: 'user', content: 'Hi', turn: 3, read: true, tags: ['a'], meta: { at: 'x' } }),
    {
      role: '',
      content: '',
      turn: 0,
      read: false,
      tags: [],
      meta: { at: '' },
    },
  );
  assertEquals(blankLike(undefined), '');
  assertEquals(blankLike(null), '');
});

Deno.test('only a list of strings, or an empty one, reads as words', () => {
  assertEquals(isWordList([]), true);
  assertEquals(isWordList(['search_restaurants', 'book_table']), true);
  assertEquals(isWordList(['a', 1]), false);
  assertEquals(isWordList([{ role: 'user' }]), false);
});

Deno.test('small, flat, alike rows edit as a table, longer values in wider columns', () => {
  const conversation = [
    { role: 'user', content: 'Book me a table for two tonight.' },
    { role: 'assistant', content: 'Which restaurant, and what time?' },
  ];
  assertEquals(tableColumns(conversation), [
    { key: 'role', weight: 1 },
    { key: 'content', weight: 3 },
  ]);
  assertEquals(tableColumns([]), null);
  assertEquals(tableColumns([{ a: 1 }, { b: 1 }]), null);
  assertEquals(tableColumns([{ a: { nested: true } }]), null);
  assertEquals(tableColumns([{ a: 1, b: 2, c: 3, d: 4, e: 5 }]), null);
});
