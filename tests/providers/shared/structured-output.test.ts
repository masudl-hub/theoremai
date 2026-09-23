import { assertEquals } from '@std/assert';
import { parseStructuredOutput } from '../../../src/providers/shared/structured-output.ts';

Deno.test('structured output: parseStructuredOutput parses JSON and fails loudly otherwise', () => {
  assertEquals(parseStructuredOutput('{"status":"ok"}'), {
    ok: true,
    structured: { status: 'ok' },
  });
  assertEquals(parseStructuredOutput('not json'), {
    ok: false,
    error: 'structured output was not valid JSON',
  });
});
