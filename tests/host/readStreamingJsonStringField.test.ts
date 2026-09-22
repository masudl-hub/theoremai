import '../fixtures/test-host.ts';
import { readStreamingJsonStringField } from '../../src/host/readStreamingJsonStringField.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

Deno.test('readStreamingJsonStringField decodes escaped partial message text', () => {
  assertEquals(
    readStreamingJsonStringField('{"message":"hello\\nworld"', 'message'),
    'hello\nworld',
  );
});

Deno.test('readStreamingJsonStringField returns null when key is absent', () => {
  assertEquals(readStreamingJsonStringField('{"other":"x"}', 'message'), null);
});

Deno.test('readStreamingJsonStringField returns complete string value', () => {
  assertEquals(readStreamingJsonStringField('{"title":"Done"}', 'title'), 'Done');
});

Deno.test('readStreamingJsonStringField treats regex characters in keys literally', () => {
  assertEquals(readStreamingJsonStringField('{"aXb":"wrong","a.b":"right"}', 'a.b'), 'right');
});

Deno.test('readStreamingJsonStringField skips matching text inside earlier values', () => {
  assertEquals(readStreamingJsonStringField('{"other":"message","message":"ok"}', 'message'), 'ok');
});
