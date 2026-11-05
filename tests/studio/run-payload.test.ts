import { assertEquals } from '@std/assert';
import { readStudioRunIdFromUrl } from '../../studio/mod.ts';

Deno.test('readStudioRunIdFromUrl reads ?run=', () => {
  assertEquals(readStudioRunIdFromUrl('https://x.example/studio/run/?run=rid-1'), 'rid-1');
  assertEquals(readStudioRunIdFromUrl('/studio/run/?run=rid-2&x=1'), 'rid-2');
  assertEquals(readStudioRunIdFromUrl('/studio/run/'), null);
  assertEquals(readStudioRunIdFromUrl('https://x.example/studio/run/?run=%20'), null);
});
