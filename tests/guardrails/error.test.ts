import {
  describeError,
  isAbortError,
  PUBLIC_ACTION,
  PUBLIC_CANARY,
  PUBLIC_CANCELLED,
  PUBLIC_FILE_COUNT,
  PUBLIC_FILE_SIZE,
  PUBLIC_FILE_TYPE,
  PUBLIC_GENERIC,
  PUBLIC_IMAGE_SIZE,
  PUBLIC_UNAVAILABLE,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  UPSTREAM_FAILED,
} from '../../src/guardrails/error.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';

Deno.test('publicError covers all exact mappings and rules', () => {
  assertEquals(publicError(new TheoremError(UPSTREAM_FAILED)), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheoremError('empty Gemini stream')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('Gemini HTTP 500'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('OpenRouter HTTP 401'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('TTS HTTP 503'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new Error('ECONNREFUSED 127.0.0.1')), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(new TheoremError('canary leaked')), PUBLIC_CANARY);
  assertEquals(
    publicError(new TheoremError('Turn withheld: egress disclosure violation')),
    PUBLIC_CANARY,
  );
  assertEquals(
    publicError(new TheoremError('expected JSON object')),
    'Something was wrong with that request.',
  );
  assertEquals(
    publicError(new TheoremError('structured output was not valid JSON')),
    'Something was wrong with that request.',
  );
  assertEquals(publicError(new TheoremError('malformed Gemini Live message')), PUBLIC_UNAVAILABLE);
  assertEquals(
    publicError(new TheoremError('malformed Gemini Live message during setup')),
    PUBLIC_UNAVAILABLE,
  );
  assertEquals(
    publicError(new TheoremError('user input cannot be placed in the system block')),
    PUBLIC_GENERIC,
  );
  assertEquals(publicError(new TheoremError('attachment data must be base64')), PUBLIC_FILE_TYPE);
  assertEquals(publicError(new TheoremError('attachment is too large')), PUBLIC_FILE_SIZE);
  assertEquals(
    publicError(new TheoremError('attachments exceed the per-turn budget')),
    PUBLIC_FILE_SIZE,
  );
  assertEquals(
    publicError(new TheoremError('Tool input validation failed')),
    "That question isn't valid.",
  );
  assertEquals(
    publicError(new TheoremError('This profile does not accept text input')),
    PUBLIC_ACTION,
  );

  assertEquals(publicError("Tool 'ask_user' is not enabled on this turn"), PUBLIC_ACTION);
  assertEquals(publicError("Tool 'host_tool' is not registered"), PUBLIC_ACTION);
  assertEquals(publicError("Tool 'googleSearch' is not allowed on this profile"), PUBLIC_ACTION);
  assertEquals(publicError("Unknown model select 'ultra'"), PUBLIC_ACTION);
  assertEquals(publicError('Grounding tools conflict'), PUBLIC_ACTION);

  assertEquals(
    publicError(new TheoremError("MIME 'image/gif' is not accepted on host-profile")),
    PUBLIC_FILE_TYPE,
  );
  assertEquals(
    publicError(new TheoremError('Profile pinned does not accept voice')),
    PUBLIC_FILE_TYPE,
  );
  assertEquals(publicError(new TheoremError('At most 5 files are allowed')), PUBLIC_FILE_COUNT);
  assertEquals(
    publicError(new TheoremError('Each file must be under 2MB')),
    'Each file must be under 2MB',
  );
  assertEquals(
    publicError(new TheoremError('Those files together are too large')),
    'Those files together are too large',
  );
  assertEquals(publicError(new TheoremError('Invalid aspect or size')), PUBLIC_IMAGE_SIZE);
  assertEquals(publicError(new TheoremError('Profile must pin thinking')), PUBLIC_GENERIC);
  assertEquals(publicError(new TheoremError('Profile has no models')), PUBLIC_GENERIC);

  const wire = [
    publicError(new TheoremError('host key slot not configured')),
    publicError('Gemini HTTP 429'),
    publicError(new Error('fetch failed: dns')),
  ].join(' ');
  assertEquals(wire.includes('GEMINI'), false);
  assertEquals(wire.includes('429'), false);
  assertEquals(wire.includes('dns'), false);
  assertEquals(
    publicError(new TheoremError('Only 5 files per message.')),
    'Only 5 files per message.',
  );
  assertEquals(publicError(PUBLIC_UNAVAILABLE), PUBLIC_UNAVAILABLE);
  assertEquals(publicError(PUBLIC_GENERIC), PUBLIC_GENERIC);

  const mapped = toErrorEvent('Gemini HTTP 400: model_turn is not supported');
  assertEquals(mapped.error, PUBLIC_UNAVAILABLE);
  assertEquals(mapped.errorInternal, 'Gemini HTTP 400: model_turn is not supported');
});

Deno.test('isAbortError returns false for non-objects and non-AbortError names', () => {
  assertEquals(isAbortError(null), false);
  assertEquals(isAbortError(undefined), false);
  assertEquals(isAbortError('AbortError'), false);
  assertEquals(isAbortError(42), false);
  assertEquals(isAbortError({ name: 'Error' }), false);
  assertEquals(isAbortError(new Error('oops')), false);
});

Deno.test('isAbortError returns true for objects with AbortError name', () => {
  assertEquals(isAbortError({ name: 'AbortError' }), true);
  assertEquals(isAbortError(new DOMException('aborted', 'AbortError')), true);
});

Deno.test('throwIfAborted is a no-op when signal is undefined or not aborted', () => {
  throwIfAborted(undefined);
  throwIfAborted(new AbortController().signal);
});

Deno.test('throwIfAborted re-throws an AbortError reason directly', () => {
  const ctrl = new AbortController();
  ctrl.abort(new DOMException('aborted', 'AbortError'));
  assertThrows(() => throwIfAborted(ctrl.signal), DOMException);
});

Deno.test('throwIfAborted wraps a non-AbortError reason in DOMException', () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error('some other reason'));
  assertThrows(() => throwIfAborted(ctrl.signal), DOMException);
});

Deno.test('describeError extracts message from Error instances', () => {
  assertEquals(describeError(new Error('boom')), 'boom');
});

Deno.test('describeError returns string unchanged', () => {
  assertEquals(describeError('detail text'), 'detail text');
});

Deno.test('describeError stringifies non-string non-Error values', () => {
  assertEquals(describeError(42), '42');
  assertEquals(describeError(null), 'null');
});

Deno.test('publicError maps DOMException AbortError to CANCELLED', () => {
  assertEquals(publicError(new DOMException('aborted', 'AbortError')), PUBLIC_CANCELLED);
});

Deno.test('publicError maps generic Error to UNAVAILABLE', () => {
  assertEquals(publicError(new Error('fetch failed: internal detail')), PUBLIC_UNAVAILABLE);
});

Deno.test('publicError maps text containing "aborted" to CANCELLED', () => {
  assertEquals(publicError('operation was aborted by user'), PUBLIC_CANCELLED);
  assertEquals(publicError('Aborted'), PUBLIC_CANCELLED);
});

Deno.test('publicError maps The/This operation was aborted to CANCELLED', () => {
  assertEquals(publicError('The operation was aborted.'), PUBLIC_CANCELLED);
  assertEquals(publicError('This operation was aborted'), PUBLIC_CANCELLED);
});

Deno.test('publicError returns ALREADY_PUBLIC strings unchanged', () => {
  assertEquals(publicError(PUBLIC_ACTION), PUBLIC_ACTION);
  assertEquals(publicError(PUBLIC_CANARY), PUBLIC_CANARY);
  assertEquals(publicError(PUBLIC_CANCELLED), PUBLIC_CANCELLED);
  assertEquals(publicError(PUBLIC_FILE_COUNT), PUBLIC_FILE_COUNT);
  assertEquals(publicError(PUBLIC_IMAGE_SIZE), PUBLIC_IMAGE_SIZE);
});

Deno.test('publicError pass-through for Only/Each/Those file messages', () => {
  assertEquals(publicError('Only 3 files per message.'), 'Only 3 files per message.');
  assertEquals(publicError('Each file must be under 10MB'), 'Each file must be under 10MB');
  assertEquals(publicError('Those files together are too big'), 'Those files together are too big');
});

Deno.test('publicError maps attachment string to FILE_SIZE via catch-all rule', () => {
  assertEquals(publicError('attachment blob rejected'), PUBLIC_FILE_SIZE);
});

Deno.test('publicError maps Speech HTTP to UNAVAILABLE', () => {
  assertEquals(publicError('Speech HTTP 503'), PUBLIC_UNAVAILABLE);
  assertEquals(publicError('OpenRouter TTS HTTP 429'), PUBLIC_UNAVAILABLE);
});

Deno.test('publicError maps mid-string TTS HTTP to UNAVAILABLE (kills t.includes removal)', () => {
  // strings that contain 'TTS HTTP' not at the start require the includes() fallback.
  assertEquals(publicError('Provider: TTS HTTP 503 error'), PUBLIC_UNAVAILABLE);
});

Deno.test('publicError maps mid-string Speech HTTP to UNAVAILABLE (kills t.includes removal)', () => {
  assertEquals(publicError('Provider: Speech HTTP 503 error'), PUBLIC_UNAVAILABLE);
});

Deno.test('publicError maps aspect or size to IMAGE_SIZE', () => {
  assertEquals(publicError('Invalid aspect or size for image'), PUBLIC_IMAGE_SIZE);
});

Deno.test('toErrorEvent with non-Error thrown value', () => {
  const ev = toErrorEvent({ notAnError: true });
  assertEquals(ev.type, 'error');
  assertEquals(ev.error, PUBLIC_UNAVAILABLE);
  assertEquals(typeof ev.errorInternal, 'string');
});

Deno.test('toErrorEvent preserves internal detail alongside public message', () => {
  const ev = toErrorEvent(new TheoremError('canary leaked'));
  assertEquals(ev.error, PUBLIC_CANARY);
  assertEquals(ev.errorInternal, 'canary leaked');
});

Deno.test('publicError maps "Only" text without "file" to GENERIC (kills && → || mutation)', () => {
  // Ensures Rule 5 requires BOTH startsWith('Only ') AND includes('file')
  assertEquals(publicError('Only records were updated'), PUBLIC_GENERIC);
  assertEquals(publicError('Only one attempt allowed'), PUBLIC_GENERIC);
});

Deno.test('publicError maps "does not accept attachments" rule to FILE_TYPE', () => {
  assertEquals(publicError('Profile does not accept attachments'), PUBLIC_FILE_TYPE);
});

Deno.test('publicError maps "does not accept voice" to FILE_TYPE', () => {
  assertEquals(publicError('Profile does not accept voice'), PUBLIC_FILE_TYPE);
});

Deno.test('publicError maps "not allowed" phrase to ACTION', () => {
  assertEquals(publicError('Action not allowed'), PUBLIC_ACTION);
});

Deno.test('publicError maps "not registered" phrase to ACTION', () => {
  assertEquals(publicError('Tool not registered'), PUBLIC_ACTION);
});

Deno.test('publicError maps "not enabled on this turn" to ACTION', () => {
  assertEquals(publicError('Feature not enabled on this turn'), PUBLIC_ACTION);
});

Deno.test('publicError maps "must pin thinking" and "has no models" both to GENERIC', () => {
  assertEquals(publicError('Profile must pin thinking budget'), PUBLIC_GENERIC);
  assertEquals(publicError('Registry has no models'), PUBLIC_GENERIC);
});

Deno.test('describeError stringifies Error with empty message via fallback', () => {
  const err = new Error('');
  // err.message is '' (falsy), so the && err.message guard is false → uses String(err) = 'Error'
  assertEquals(describeError(err), 'Error');
});

Deno.test('TheoremError name is TheoremError', () => {
  assertEquals(new TheoremError('test').name, 'TheoremError');
});

Deno.test('UPSTREAM_FAILED constant is the literal string upstream failed', () => {
  assertEquals(UPSTREAM_FAILED, 'upstream failed');
});

Deno.test('PUBLIC_GENERIC constant is the expected user-safe copy', () => {
  assertEquals(PUBLIC_GENERIC, 'Something went wrong. Try again.');
});

Deno.test('PUBLIC_FILE_COUNT constant is the expected user-safe copy', () => {
  assertEquals(PUBLIC_FILE_COUNT, 'Too many files for one message.');
});

Deno.test('PUBLIC_FILE_SIZE constant is the expected user-safe copy', () => {
  assertEquals(PUBLIC_FILE_SIZE, 'That file is too large.');
});

Deno.test('PUBLIC_IMAGE_SIZE constant is the expected user-safe copy', () => {
  assertEquals(PUBLIC_IMAGE_SIZE, "That image size isn't supported.");
});

Deno.test('PUBLIC_CANCELLED constant is the expected user-safe copy', () => {
  assertEquals(PUBLIC_CANCELLED, 'Cancelled.');
});

Deno.test('publicError does not map a string starting with Error: Gemini to UNAVAILABLE (anchor mutation)', () => {
  assertEquals(publicError('Error: Gemini HTTP 500'), PUBLIC_GENERIC);
});

Deno.test('throwIfAborted re-throws the exact same AbortError object not a new one', () => {
  const ctrl = new AbortController();
  const reason = new DOMException('specific abort reason', 'AbortError');
  ctrl.abort(reason);
  let caught: unknown;
  try {
    throwIfAborted(ctrl.signal);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught === reason, true);
});

Deno.test('throwIfAborted wraps non-AbortError with correct message and name', () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error('underlying cause'));
  let caught: DOMException | undefined;
  try {
    throwIfAborted(ctrl.signal);
  } catch (e) {
    caught = e as DOMException;
  }
  assertEquals(caught?.message, 'The operation was aborted.');
  assertEquals(caught?.name, 'AbortError');
});
