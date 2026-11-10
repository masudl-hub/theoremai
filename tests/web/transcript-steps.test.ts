import { assertEquals } from '@std/assert';
import { foldTurnEvents } from '../../src/interface/blocks.ts';
import type { MediaBlock } from '../../src/interface/types.ts';
import { turnEventSchema } from '../../src/kernel/turn-events.ts';
import { transcriptBlockSchema } from '../../web/src/client/transcript-schema.ts';

Deno.test("a saved agent tool call keeps its agent's calls, nested as deep as they ran", () => {
  const leaf = { name: 'read_page', callId: 'c', arguments: {} };
  const block = {
    id: 'b1',
    kind: 'tool' as const,
    tool: {
      name: 'think_deeply',
      callId: 'a',
      arguments: { text: 'thrips' },
      steps: [{ name: 'web_search', callId: 'b', arguments: {}, steps: [leaf] }],
    },
  };
  assertEquals(transcriptBlockSchema.parse(block), block);
});

Deno.test('tool media keeps sent and its reference live, and after a reload', () => {
  const uri = 'gs://bucket/card.pdf';
  const tool = { name: 'make_card', callId: 'c1', arguments: {}, at: 1 };
  const complete = {
    ...tool,
    phase: 'complete',
    output: {},
    parts: [
      { type: 'image', mimeType: 'image/png', data: 'U0VOVA==', sent: true },
      { type: 'image', mimeType: 'image/png', data: 'UkVBRA==' },
      { type: 'document', mimeType: 'application/pdf', uri },
    ],
  };
  // Live: the events cross the wire and are read back through the turn event schema.
  const live = [
    { type: 'tool', tool },
    { type: 'tool', tool: complete },
  ].map((event) => turnEventSchema.parse(JSON.parse(JSON.stringify(event))));
  const blocks = foldTurnEvents(live).filter((block) => block.kind === 'media');
  const shown: Omit<MediaBlock, 'id' | 'kind'>[] = [
    { mimeType: 'image/png', fromTool: true, data: 'U0VOVA==', sent: true },
    { mimeType: 'image/png', fromTool: true, data: 'UkVBRA==' },
    { mimeType: 'application/pdf', fromTool: true, uri, type: 'document', sent: true },
  ];
  assertEquals(
    blocks.map(({ id: _id, kind: _kind, ...rest }) => rest),
    shown,
  );
  // After a reload: the stored blocks are read back through the transcript schema.
  const reloaded = blocks.map((block) =>
    transcriptBlockSchema.parse(JSON.parse(JSON.stringify(block))),
  );
  assertEquals(reloaded, blocks);
});
