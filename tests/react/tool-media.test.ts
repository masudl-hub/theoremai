import { assertEquals } from '@std/assert';
import { mediaFileName, toolMediaShows } from '../../react/src/ui/tool-media-shown.ts';

Deno.test('under sent a chat shows only what a tool sent; under all, everything', () => {
  const read = { fromTool: true as const };
  const sent = { fromTool: true as const, sent: true as const };
  const generated = {};
  assertEquals(
    [read, sent, generated].map((block) => toolMediaShows(block, 'sent')),
    [false, true, true],
  );
  assertEquals(
    [read, sent, generated].map((block) => toolMediaShows(block, 'all')),
    [true, true, true],
  );
});

Deno.test('a reference nothing resolves reads as the file it names', () => {
  assertEquals(mediaFileName('gs://bucket/cards/card%207.pdf'), 'card 7.pdf');
  assertEquals(mediaFileName('https://files.example.com/a/b.png?sig=x#y'), 'b.png');
  assertEquals(mediaFileName('s3://bucket/dir/'), 'dir');
  assertEquals(mediaFileName('urn:media:42'), 'urn:media:42');
  assertEquals(mediaFileName('gs://bucket/%E0%A4%A.png'), '%E0%A4%A.png');
});
