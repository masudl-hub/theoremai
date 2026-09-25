import { assertEquals } from '@std/assert';
import { structuredEvent } from '../../../src/providers/shared/structured-output.ts';

Deno.test('structured output: structuredEvent parses JSON and fails loudly otherwise', () => {
  assertEquals(structuredEvent('{"status":"ok"}'), {
    type: 'structured',
    structured: { status: 'ok' },
  });
  assertEquals(structuredEvent('not json'), {
    type: 'error',
    errorKind: 'bad_response',
    errorInternal: 'structured output was not valid JSON',
  });
});
