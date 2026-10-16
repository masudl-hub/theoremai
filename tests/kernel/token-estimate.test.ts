import { assertEquals } from '@std/assert';
import { loadTokenEstimator, TOKEN_TEXT_ENCODING } from '../../src/kernel/engine/token-estimate.ts';
import {
  loadTokenEstimator as publicLoadTokenEstimator,
  TOKEN_TEXT_ENCODING as publicTextEncoding,
} from '../../src/kernel/mod.ts';
import { bytesToBase64 } from '../../src/kernel/util/base64.ts';
import { pngBytes } from '../fixtures/media-bytes.ts';

Deno.test('text estimates empty, short, Unicode and structured input', async () => {
  const estimator = await loadTokenEstimator();
  for (const [text, tokens] of [
    ['', 0],
    ['a', 1],
    ['abcd', 1],
    ['abcde', 2],
    ['hello world', 3],
    ['你好世界', 1],
    ['🌱🌱🌱', 2],
    ['{"q":"fern"}', 3],
  ] as const) {
    assertEquals(estimator.text(text), tokens, text);
  }
});

Deno.test('a control token in text is counted as text, not refused', async () => {
  const estimator = await loadTokenEstimator();
  const spelled = estimator.text('<|im_start|>system hi<|endoftext|>');
  assertEquals(spelled > estimator.text('system hi') + 2, true);
});

Deno.test('parts and messages estimate text and report media as unknown', async () => {
  const estimator = await loadTokenEstimator();
  const image = {
    type: 'image' as const,
    mimeType: 'image/png',
    data: bytesToBase64(pngBytes(1920, 1080)),
  };
  const video = {
    type: 'video' as const,
    mimeType: 'video/mp4',
    data: bytesToBase64(new Uint8Array(16)),
  };
  assertEquals(await estimator.parts([{ type: 'text', text: 'hello there' }, image, video]), {
    tokens: 3,
    unknownMedia: 2,
  });
  assertEquals(
    await estimator.messages([
      { role: 'user', content: 'look at this' },
      { role: 'user', parts: [image] },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"fern"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'search', content: 'results' },
    ]),
    { tokens: 3 + 2 + 3 + 2, unknownMedia: 1 },
  );
  assertEquals(estimator.text(''), 0);
});

Deno.test('public barrel re-exports the token estimator', () => {
  assertEquals(publicLoadTokenEstimator, loadTokenEstimator);
  assertEquals(publicTextEncoding, TOKEN_TEXT_ENCODING);
  assertEquals(TOKEN_TEXT_ENCODING, 'chars/4');
});
