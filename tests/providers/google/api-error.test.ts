import { publicError, type TheoremError } from '../../../src/guardrails/error.ts';
import { labelDefault } from '../../../src/guardrails/labels.ts';
import { assertEquals } from '../../../src/kernel/engine/assert.ts';
import {
  readGeminiApiError,
  readNonOkError,
  statedOrStatusError,
} from '../../../src/providers/google/api-error.ts';

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
  // As sent mid-stream on 28/09/2026 by gemma-4-31b-it and gemini-3.7-flash.
  assertEquals(
    readGeminiApiError({
      error: {
        message:
          'gemini-3.7-flash is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.',
        code: 'service_unavailable',
      },
      event_type: 'error',
    })?.kind,
    'unavailable',
  );
  assertEquals(
    readGeminiApiError({
      error: { message: 'Internal error encountered.', code: 'api_error' },
      event_type: 'error',
    })?.kind,
    'unavailable',
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

/** Google's body for a bad key: a 400, named as the key only by its `ErrorInfo` reason. */
const INVALID_KEY = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
      },
    ],
  },
};

Deno.test('a refused key is auth, not the 400 it arrives as', async () => {
  assertEquals(readGeminiApiError(INVALID_KEY)?.kind, 'auth');
  const response = new Response(JSON.stringify(INVALID_KEY), { status: 400 });
  assertEquals(shape(await readNonOkError(response)), {
    kind: 'auth',
    message: 'INVALID_ARGUMENT: API key not valid. Please pass a valid API key.',
  });
});

Deno.test('an overloaded Gemini reads as busy, not down', async () => {
  // recorded 2026-10-20: the Interactions reply that failed a Studio turn twice
  const busy = {
    error: {
      message:
        'gemini-3.5-flash-lite is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.',
      code: 'service_unavailable',
    },
  };
  const named = readGeminiApiError(busy);
  assertEquals(named?.kind, 'unavailable');
  assertEquals(publicError(named), labelDefault('model.busy'));
  const status = await readNonOkError(new Response(JSON.stringify(busy), { status: 503 }));
  assertEquals(status.kind, 'unavailable');
  assertEquals(publicError(status), labelDefault('model.busy'));
  assertEquals(
    publicError(statedOrStatusError(null, 529, 'overloaded')),
    labelDefault('model.busy'),
  );
});

Deno.test('a provider fault that is not overload keeps the unavailable wording', () => {
  for (const code of [500, 502]) {
    const err = readGeminiApiError({ error: { code, message: 'x' } });
    assertEquals(err?.kind, 'unavailable');
    assertEquals(publicError(err), labelDefault('error.unavailable'));
  }
});
