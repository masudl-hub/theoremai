import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { asObject, dataRecord, takeSsePayloads } from '../../../src/providers/shared/sse.ts';

Deno.test('takeSsePayloads keeps event names, thought signatures, and [DONE]', () => {
  const raw = [
    'event: interaction.created',
    'data: {"event_type":"interaction.created","interaction":{"id":"","status":"in_progress"}}',
    '',
    'event: step.delta',
    'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"abc"}}',
    '',
    'event: done',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
  const { payloads, pendingEvent } = takeSsePayloads(raw);
  assertEquals(pendingEvent, '');
  assertEquals(payloads[0]?.sseEvent, 'interaction.created');
  assertEquals(payloads[0]?.event_type, 'interaction.created');
  const delta = payloads[1]?.delta as Record<string, unknown>;
  assertEquals(delta.signature, 'abc');
  assertEquals(payloads[2]?.eventType, 'sse_done');
  assertEquals(payloads[2]?.sseEvent, 'done');
});

Deno.test('takeSsePayloads carries event name across chunks', () => {
  const first = takeSsePayloads('event: step.start\n');
  assertEquals(first.payloads, []);
  const second = takeSsePayloads(
    'data: {"event_type":"step.start","index":0}\n',
    first.pendingEvent,
  );
  assertEquals(second.payloads[0]?.sseEvent, 'step.start');
  assertEquals(second.payloads[0]?.index, 0);
});

Deno.test('takeSsePayloads handles empty data, non-object JSON, and invalid JSON gracefully', () => {
  const raw = [
    'event: empty_ev',
    'data: ',
    'event: array_ev',
    'data: [1, 2, 3]',
    'event: primitive_ev',
    'data: 42',
    'event: bad_json',
    'data: { invalid syntax',
    '',
  ].join('\n');

  const { payloads } = takeSsePayloads(raw);
  assertEquals(payloads.length, 4);

  // Empty data
  assertEquals(payloads[0].sseEvent, 'empty_ev');
  assertEquals(payloads[0].eventType, 'sse_done');

  // Array data (non-object)
  assertEquals(payloads[1].sseEvent, 'array_ev');
  assertEquals(payloads[1].eventType, 'sse_unparsed');
  assertEquals(payloads[1].data, [1, 2, 3]);

  // Primitive number
  assertEquals(payloads[2].sseEvent, 'primitive_ev');
  assertEquals(payloads[2].eventType, 'sse_unparsed');
  assertEquals(payloads[2].data, 42);

  // Invalid JSON string
  assertEquals(payloads[3].sseEvent, 'bad_json');
  assertEquals(payloads[3].eventType, 'sse_unparsed');
  assertEquals(payloads[3].data, '{ invalid syntax');
});

Deno.test('asObject returns the value for plain objects', () => {
  assertEquals(asObject({ a: 1 }), { a: 1 });
});

Deno.test('asObject returns undefined for arrays', () => {
  assertEquals(asObject([1, 2, 3]), undefined);
});

Deno.test('asObject returns undefined for null', () => {
  assertEquals(asObject(null), undefined);
});

Deno.test('asObject returns undefined for primitives', () => {
  assertEquals(asObject(42), undefined);
  assertEquals(asObject('hello'), undefined);
  assertEquals(asObject(true), undefined);
  assertEquals(asObject(undefined), undefined);
});

Deno.test('dataRecord returns sse_done for empty data with no sseEvent', () => {
  const row = dataRecord('data: ', '');
  assertEquals(row, { eventType: 'sse_done' });
});

Deno.test('dataRecord returns sse_done for [DONE] sentinel', () => {
  const row = dataRecord('data: [DONE]', 'done');
  assertEquals(row, { sseEvent: 'done', eventType: 'sse_done' });
});

Deno.test('dataRecord merges parsed object fields with sseEvent, and row wins on conflicts', () => {
  const row = dataRecord('data: {"sseEvent":"from-payload","x":1}', 'from-arg');
  assertEquals(row, { sseEvent: 'from-arg', x: 1 });
});

Deno.test('dataRecord marks non-object parsed JSON as sse_unparsed', () => {
  const row = dataRecord('data: [1,2]', '');
  assertEquals(row, { eventType: 'sse_unparsed', data: [1, 2] });
});

Deno.test('dataRecord marks invalid JSON as sse_unparsed with raw string data', () => {
  const row = dataRecord('data: {not json', 'ev');
  assertEquals(row, { sseEvent: 'ev', eventType: 'sse_unparsed', data: '{not json' });
});
