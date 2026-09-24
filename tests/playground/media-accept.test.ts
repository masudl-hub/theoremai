import { assertEquals } from '@std/assert';
import { ATTACHMENT_ACCEPT_MIMES, MEDIA_INPUT_KINDS } from '../../src/kernel/schema.ts';
import { acceptSections, expandAccept, nextAccept } from '../../playground/mod.ts';

const sections = acceptSections(ATTACHMENT_ACCEPT_MIMES);
const kinds = Object.fromEntries(sections.map((section) => [section.kind, section]));
const images = kinds.image.mimes;
const [png, ...otherImages] = images;

/** Apply a picker change the way the editor does: from the expanded list to `selected`. */
function pick(stored: string[], change: (shown: string[]) => string[]): string[] {
  return nextAccept(stored, change(expandAccept(stored, sections)), sections);
}

Deno.test('attachment options group by kind, a wildcard heading its own', () => {
  assertEquals(sections.map(({ kind, wildcard }) => [kind, wildcard]), [
    ['image', 'image/*'],
    ['video', 'video/*'],
    ['document', undefined],
  ]);
  for (const { kind, mimes } of sections) {
    assertEquals(mimes.every((mime) => MEDIA_INPUT_KINDS[mime] === kind), true);
  }
});

Deno.test('a stored wildcard shows every type of its kind as picked', () => {
  assertEquals(expandAccept(['image/*'], sections), ['image/*', ...images]);
});

Deno.test('picking a wildcard stores it alone for its kind', () => {
  assertEquals(pick([png], (shown) => [...shown, 'image/*']), ['image/*']);
});

Deno.test('unpicking a wildcard clears its kind', () => {
  const stored = ['image/*', 'application/pdf'];
  assertEquals(pick(stored, (shown) => shown.filter((m) => m !== 'image/*')), ['application/pdf']);
});

Deno.test('unpicking one type under a wildcard keeps the rest of its kind', () => {
  assertEquals(pick(['image/*'], (shown) => shown.filter((m) => m !== png)), otherImages);
});

Deno.test('picking every type of a kind collapses to its wildcard', () => {
  assertEquals(pick(otherImages, (shown) => [...shown, png]), ['image/*']);
});

Deno.test('a kind without a wildcard and an unknown type pass through', () => {
  const stored = ['application/pdf', 'x-custom/thing'];
  assertEquals(pick(stored, (shown) => shown), stored);
});
