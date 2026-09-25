import type { TheoremError } from '../../../src/guardrails/error.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import { readGeminiApiError, readNonOkError } from '../../../src/providers/google/api-error.ts';

function shape(err: TheoremError | null): { kind: string; message: string } | null {
  return err ? { kind: err.kind, message: err.message } : null;
}

Deno.test('readGeminiApiError reads only the error object', () => {
  assertEquals(
    shape(readGeminiApiError({ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } })),
    { kind: 'unsupported', message: 'INVALID_ARGUMENT: bad' },
  );
  assertEquals(shape(readGeminiApiError({ error: { message: 'Quota exceeded' } })), {
    kind: 'bad_response',
    message: 'Quota exceeded',
  });
  assertEquals(shape(readGeminiApiError({ error: { code: 500 } })), {
    kind: 'unavailable',
    message: 'Gemini returned an error.',
  });
  assertEquals(shape(readGeminiApiError({ error: { code: 429, message: '' } })), {
    kind: 'rate_limit',
    message: 'Gemini returned an error.',
  });
  assertEquals(readGeminiApiError({}), null);
  assertEquals(readGeminiApiError({ error: null }), null);
  assertEquals(readGeminiApiError({ error: 'bad' }), null);
  assertEquals(readGeminiApiError({ event_type: 'error', message: 'bad' }), null);
});

Deno.test('readGeminiApiError ignores a code that is not an HTTP status', () => {
  assertEquals(readGeminiApiError({ error: { code: 7, message: 'x' } })?.kind, 'bad_response');
  assertEquals(readGeminiApiError({ error: { code: '429', message: 'x' } })?.kind, 'bad_response');
});

Deno.test('readNonOkError takes the kind from the status and the detail from the body', async () => {
  assertEquals(shape(await readNonOkError(new Response('', { status: 503 }))), {
    kind: 'unavailable',
    message: 'HTTP 503',
  });
  assertEquals(shape(await readNonOkError(new Response('not json', { status: 400 }))), {
    kind: 'unsupported',
    message: 'Gemini HTTP 400: not json',
  });
  assertEquals(
    shape(await readNonOkError(new Response('{"error":{"message":"bad"}}', { status: 401 }))),
    { kind: 'auth', message: 'bad' },
  );
  assertEquals(shape(await readNonOkError(new Response('{"error":{}}', { status: 429 }))), {
    kind: 'rate_limit',
    message: 'Gemini returned an error.',
  });
});
