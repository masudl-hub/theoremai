import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { foldResponse } from '../../../src/providers/shared/response-identity.ts';

Deno.test('foldResponse emits when the wire first names the response', () => {
  assertEquals(foldResponse(undefined, { id: 'v1' }), {
    known: { id: 'v1' },
    event: { type: 'response', response: { id: 'v1' } },
  });
});

Deno.test('foldResponse stays quiet when a row names nothing new', () => {
  assertEquals(foldResponse({ id: 'v1', model: 'm' }, { id: 'v1' }), {
    known: { id: 'v1', model: 'm' },
  });
  assertEquals(foldResponse({ id: 'v1' }, undefined), { known: { id: 'v1' } });
});

Deno.test('foldResponse emits the merged identity when a later row adds the model', () => {
  assertEquals(foldResponse({ id: 'v1' }, { model: 'm' }), {
    known: { id: 'v1', model: 'm' },
    event: { type: 'response', response: { id: 'v1', model: 'm' } },
  });
});
