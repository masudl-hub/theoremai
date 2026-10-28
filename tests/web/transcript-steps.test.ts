import { assertEquals } from '@std/assert';
import { transcriptBlockSchema } from '../../web/src/client/transcript-schema.ts';

Deno.test("a saved agent tool call keeps its agent's calls, nested as deep as they ran", () => {
  const leaf = { name: 'read_page', callId: 'c', arguments: {}, artifacts: [] };
  const block = {
    id: 'b1',
    kind: 'tool' as const,
    tool: {
      name: 'think_deeply',
      callId: 'a',
      arguments: { text: 'thrips' },
      artifacts: [],
      steps: [{ name: 'web_search', callId: 'b', arguments: {}, artifacts: [], steps: [leaf] }],
    },
  };
  assertEquals(transcriptBlockSchema.parse(block), block);
});
