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

Deno.test('readGeminiApiError reads the named code of a stream error', () => {
  assertEquals(
    readGeminiApiError({
      error: { code: 'rate_limit_exceeded', message: 'x' },
      event_type: 'error',
    })?.kind,
    'rate_limit',
  );
  assertEquals(
    readGeminiApiError({ error: { code: 'something_new', message: 'x' } })?.kind,
    'bad_response',
  );
});

Deno.test('every documented named code keeps the kind its HTTP status has', () => {
  const kinds: Record<string, string> = {
    invalid_request: 'unsupported',
    authentication: 'auth',
    payment_required: 'auth',
    permission_denied: 'auth',
    model_not_found: 'unsupported',
    quota_exceeded: 'rate_limit',
    too_many_requests: 'rate_limit',
    cancelled: 'cancelled',
    api_error: 'unavailable',
    service_unavailable: 'unavailable',
    deadline_exceeded: 'timeout',
    internal_server_error: 'unavailable',
    gateway_timeout: 'timeout',
    safety: 'safety',
    prohibited_content: 'safety',
    image_safety: 'safety',
    malformed_function_call: 'bad_response',
    no_image: 'bad_response',
  };
  const read = Object.fromEntries(
    Object.keys(kinds).map((code) => [
      code,
      readGeminiApiError({ error: { code, message: 'x' } })?.kind,
    ]),
  );
  assertEquals(read, kinds);
});

Deno.test('an overloaded model mid-stream is unavailable, not a bad response', () => {
  assertEquals(
    shape(
      readGeminiApiError({
        error: { code: 'service_unavailable', message: 'high demand' },
        event_type: 'error',
      }),
    ),
    { kind: 'unavailable', message: 'high demand' },
  );
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
