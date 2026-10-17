import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  checkEmbeddingInputs,
  cosineSimilarity,
  embeddingPairs,
  embeddingRows,
  rowInput,
  vectorBins,
  vectorNorm,
} from '../../react/src/client/embedding-input.ts';

const TEXT = { text: true };
const MEDIA = {
  text: true,
  attachments: { accept: ['image/*'] },
  maxFiles: 1,
  maxBytes: 4,
  maxTurnBytes: 4,
};
const image = (data: string, mimeType = 'image/png') => ({
  type: 'media' as const,
  mimeType,
  data,
});

Deno.test('the embedding request is held to the profile as the kernel holds it', () => {
  const reason = (text: string, rules: Parameters<typeof checkEmbeddingInputs>[1] = TEXT) => {
    const check = checkEmbeddingInputs(text, rules);
    return check.ok ? 'ok' : check.reason;
  };
  assertEquals(reason('["a", "b"]'), 'ok');
  assertEquals(reason('["a",'), 'invalid_json');
  assertEquals(reason('{"input": "a"}'), 'invalid_json');
  assertEquals(reason('[]'), 'no_inputs');
  assertEquals(reason('["a", "  "]'), 'empty_input');
  assertEquals(reason('[{"parts": []}]'), 'empty_input');
  assertEquals(
    reason('["a"]', {
      text: false,
      attachments: MEDIA.attachments,
      maxFiles: 1,
      maxBytes: 4,
      maxTurnBytes: 4,
    }),
    'text_off',
  );
  // Media the profile does not accept, too many files, a file too large, and data that is not base64.
  assertEquals(reason(JSON.stringify([{ parts: [image('AAA=')] }])), 'attachments');
  assertEquals(reason(JSON.stringify([{ parts: [image('AAA=')] }]), MEDIA), 'ok');
  assertEquals(
    reason(JSON.stringify([{ parts: [image('AAA='), image('AAA=')] }]), MEDIA),
    'attachments',
  );
  assertEquals(reason(JSON.stringify([{ parts: [image('AAAAAAAA')] }]), MEDIA), 'attachments');
  assertEquals(
    reason(JSON.stringify([{ parts: [image('AAA=', 'text/plain')] }]), MEDIA),
    'attachments',
  );
  assertEquals(reason(JSON.stringify([{ parts: [image('not base64!')] }]), MEDIA), 'invalid_json');
  const empty = checkEmbeddingInputs('["a", ""]', TEXT);
  assertEquals(!empty.ok && empty.reason === 'empty_input' && empty.index, 1);
});

Deno.test('rows round-trip the inputs, and refuse inputs with two text parts', () => {
  const inputs = ['plain', { parts: [{ type: 'text' as const, text: 'with' }, image('AAA=')] }];
  const rows = embeddingRows(inputs);
  assertEquals(rows, [
    { text: 'plain', media: [] },
    { text: 'with', media: [image('AAA=')] },
  ]);
  assertEquals(rows?.map(rowInput), inputs);
  assertEquals(rowInput({ text: '', media: [image('AAA=')] }), { parts: [image('AAA=')] });
  assertEquals(
    embeddingRows([
      {
        parts: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]),
    null,
  );
});

Deno.test('vectors compare by cosine, pair only at the same width, and bin to a width', () => {
  assertAlmostEquals(cosineSimilarity([1, 0], [1, 0]), 1);
  assertAlmostEquals(cosineSimilarity([1, 0], [-1, 0]), -1);
  assertEquals(cosineSimilarity([0, 0], [1, 0]), 0);
  assertAlmostEquals(vectorNorm([3, 4]), 5);
  const pairs = embeddingPairs({
    model: 'm',
    embeddings: [
      { index: 0, values: [1, 0], dimensions: 2 },
      { index: 1, values: [0, 1], dimensions: 2 },
      { index: 2, values: [1, 0.1], dimensions: 2 },
      { index: 3, values: [1, 0, 0], dimensions: 3 },
    ],
  });
  assertEquals(
    pairs.map(({ a, b }) => [a, b]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ],
  );
  assertEquals(vectorBins([1, 2, 3], 4), [1, 2, 3]);
  assertEquals(vectorBins([1, 3, 5, 7], 2), [2, 6]);
});
