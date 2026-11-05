import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  addUsage,
  checkEmbeddingInputs,
  checkInputs,
  cosineSimilarity,
  embeddingBatches,
  fieldsInput,
  inputFields,
  rankMatches,
  readsAsText,
  splitText,
} from '../../web/src/client/embedding-input.ts';
import { embeddingInterface } from '../../web/src/client/embedding-transport.ts';

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

Deno.test('fields round-trip an input, and refuse one with two text parts', () => {
  const inputs = ['plain', { parts: [{ type: 'text' as const, text: 'with' }, image('AAA=')] }];
  const fields = inputs.map(inputFields);
  assertEquals(fields, [
    { text: 'plain', media: [] },
    { text: 'with', media: [image('AAA=')] },
  ]);
  assertEquals(
    fields.map((f) => f && fieldsInput(f)),
    inputs,
  );
  assertEquals(fieldsInput({ text: '', media: [image('AAA=')] }), { parts: [image('AAA=')] });
  assertEquals(
    inputFields({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    }),
    null,
  );
});

Deno.test('text splits into trimmed documents at the chosen separator', () => {
  const text = ' one, two\nthree\n  \nfour ';
  assertEquals(splitText(text, 'whole'), ['one, two\nthree\n  \nfour']);
  assertEquals(splitText(text, 'lines'), ['one, two', 'three', 'four']);
  assertEquals(splitText(text, 'paragraphs'), ['one, two\nthree', 'four']);
  assertEquals(splitText('a\r\n\r\nb', 'paragraphs'), ['a', 'b']);
  assertEquals(splitText(text, 'commas'), ['one', 'two\nthree\n  \nfour']);
  assertEquals(splitText('a;;b;;', { separator: ';;' }), ['a', 'b']);
  assertEquals(splitText(' a ', { separator: '' }), ['a']);
  assertEquals(splitText('  \n ', 'lines'), []);
});

Deno.test('text files are read as words; other files are media', () => {
  assertEquals(readsAsText({ name: 'notes.md', type: '' }), true);
  assertEquals(readsAsText({ name: 'a', type: 'text/csv' }), true);
  assertEquals(readsAsText({ name: 'a', type: 'application/json' }), true);
  assertEquals(readsAsText({ name: 'photo.png', type: 'image/png' }), false);
  assertEquals(readsAsText({ name: 'deck.pdf', type: 'application/pdf' }), false);
});

Deno.test('documents batch as the fewest requests the profile allows', () => {
  assertEquals(embeddingBatches(['a', 'b', 'c'], TEXT), [['a', 'b', 'c']]);
  assertEquals(embeddingBatches(['a', 'b', 'c'], TEXT, 2), [['a', 'b'], ['c']]);
  // Files count per input, bytes per request: 3 and 1 bytes fill one request of 4, the text rides along.
  const one = { parts: [image('AAAA')] };
  const two = { parts: [image('AA==')] };
  const three = { parts: [image('AA==')] };
  assertEquals(embeddingBatches(['a', one, 'b', two, three], MEDIA), [
    ['a', one, 'b', two],
    [three],
  ]);
  // The model's cap on inputs a request holds splits too.
  assertEquals(embeddingBatches(['a', 'b', 'c'], { ...TEXT, maxInputs: 2 }), [['a', 'b'], ['c']]);
  // An input the profile refuses on its own still goes, alone, for the kernel to refuse.
  const big = { parts: [image('AAAAAAAA')] };
  assertEquals(embeddingBatches(['a', big, 'b'], MEDIA), [['a'], [big], ['b']]);
  assertEquals(embeddingBatches([], TEXT), []);
});

Deno.test('usage adds across requests', () => {
  assertEquals(addUsage(undefined, { inputTokens: 3 }), { inputTokens: 3 });
  assertEquals(addUsage({ inputTokens: 3, costUsd: 0.5 }, { inputTokens: 4, estimated: true }), {
    inputTokens: 7,
    costUsd: 0.5,
    estimated: true,
  });
  assertEquals(addUsage(undefined, undefined), undefined);
});

Deno.test('vectors compare by cosine, and matches rank only at the query width', () => {
  assertAlmostEquals(cosineSimilarity([1, 0], [1, 0]), 1);
  assertAlmostEquals(cosineSimilarity([1, 0], [-1, 0]), -1);
  assertEquals(cosineSimilarity([0, 0], [1, 0]), 0);
  const ranked = rankMatches(
    [1, 0],
    [
      [0, 1],
      [1, 0.1],
      [1, 0, 0],
      [-1, 0],
    ],
  );
  assertEquals(
    ranked.map(({ index }) => index),
    [1, 0, 3],
  );
  assertAlmostEquals(ranked[2].score, -1);
});

Deno.test("the interface holds the profile's inputs to its default model's limits", () => {
  const iface = embeddingInterface({
    identity: { handle: 'Search' },
    defaultModel: 'gemini',
    models: {
      gemini: {
        protocol: 'geminiEmbeddings',
        provider: 'gemini',
        apiId: 'gemini-embedding-2-preview',
      },
    },
    inputs: {
      text: true,
      attachments: { accept: ['image/*', 'text/plain'] },
      maxFiles: 10,
      maxBytes: 100,
      maxTurnBytes: 1000,
    },
  });
  assertEquals(iface.inputs.attachments?.accept, ['image/png', 'image/jpeg']);
  assertEquals(iface.inputs.maxInputs, 100);
  const seven = { parts: Array.from({ length: 7 }, () => image('AA==')) };
  const check = checkInputs([seven], iface.inputs);
  assertEquals(check.ok ? [] : 'issues' in check ? check.issues : [], [
    { code: 'too_many_of_kind', params: { maxFiles: 6, kind: 'image' } },
  ]);
});
