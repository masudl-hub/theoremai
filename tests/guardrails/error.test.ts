import {
  describeError,
  ERROR_KINDS,
  type ErrorKind,
  errorKind,
  isAbortError,
  isTimeoutError,
  kindOfHttpStatus,
  publicError,
  TheoremError,
  throwIfAborted,
  toErrorEvent,
  withPublicWording,
} from '../../src/guardrails/error.ts';
import { lexiconDefault, overrideLexicon, resetLexicon } from '../../src/guardrails/lexicon.ts';
import { assertEquals, assertThrows } from '../../src/kernel/engine/assert.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';

/** The locked user lines, one per kind. */
const LOCKED: Record<ErrorKind, string> = {
  config: 'Sorry, something went wrong.',
  request: 'Sorry, something went wrong.',
  input: "Sorry, that file can't be used here.",
  action: "Sorry, that isn't available here.",
  auth: "Sorry, the assistant can't connect at the moment.",
  rate_limit: 'Sorry, things are a little busy just now. Please try again in a moment.',
  unsupported: "Sorry, that isn't something the assistant can do.",
  unavailable: "Sorry, the model isn't available at the moment. Please try again shortly.",
  bad_response: "Sorry, that reply didn't come through properly. Please try again.",
  network: "Sorry, the model couldn't be reached. Please try again.",
  timeout: 'Sorry, that took longer than expected. Please try again.',
  safety: "Sorry, that reply couldn't be shown. Please try again.",
  blocked: "Sorry, that step wasn't allowed, so it was skipped.",
  declined: 'No problem, that step was skipped.',
  failed: "Sorry, one of the steps didn't work. Please try again.",
  cancelled: 'Cancelled.',
  internal: 'Sorry, something went wrong.',
};

Deno.test('every kind has its locked wording', () => {
  assertEquals([...ERROR_KINDS].sort(), Object.keys(LOCKED).sort());
  for (const kind of ERROR_KINDS) {
    assertEquals(lexiconDefault(`error.${kind}`), LOCKED[kind]);
    assertEquals(publicError(new TheoremError(kind, 'raw detail')), LOCKED[kind]);
  }
});

Deno.test('errorKind reads the kind where the failure named it', () => {
  assertEquals(errorKind(new TheoremError('rate_limit', 'Gemini HTTP 429')), 'rate_limit');
  assertEquals(errorKind(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assertEquals(errorKind(new DOMException('aborted', 'AbortError')), 'cancelled');
  assertEquals(errorKind(new Error('boom')), 'internal');
  // Message text never decides a kind.
  assertEquals(errorKind('Gemini HTTP 500'), 'internal');
  assertEquals(errorKind(new Error('fetch failed')), 'internal');
});

Deno.test('kindOfHttpStatus maps provider statuses to kinds', () => {
  const cases: Array<[number, ErrorKind]> = [
    [400, 'unsupported'],
    [401, 'auth'],
    [402, 'auth'],
    [403, 'auth'],
    [404, 'unsupported'],
    [408, 'timeout'],
    [422, 'unsupported'],
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'timeout'],
    [524, 'timeout'],
  ];
  for (const [status, kind] of cases) assertEquals(kindOfHttpStatus(status), kind);
});

Deno.test('publicError never carries the raw detail', () => {
  const raw = 'Gemini HTTP 401: API key sk-synthetic-000 is invalid';
  const text = publicError(new TheoremError('auth', raw));
  assertEquals(text.includes('401'), false);
  assertEquals(text.includes('sk-synthetic'), false);
  assertEquals(publicError(new Error(raw)), LOCKED.internal);
});

Deno.test('publicError prefers the failure copy over its kind', () => {
  const err = new TheoremError('input', 'too many attachments: 6 > 5', {
    copy: { key: 'attachments.too_many_files', params: { maxFiles: 5 } },
  });
  assertEquals(publicError(err), 'Sorry, only 5 files can be sent per message.');
});

Deno.test('wording resolves profile lexicon, then overrideLexicon, then the default', () => {
  const err = new TheoremError('rate_limit', 'HTTP 429');
  try {
    assertEquals(publicError(err), LOCKED.rate_limit);
    overrideLexicon({ 'error.rate_limit': 'Host-wide: busy.' });
    assertEquals(publicError(err), 'Host-wide: busy.');
    assertEquals(publicError(err, { 'error.rate_limit': 'Profile: busy.' }), 'Profile: busy.');
    // A profile that leaves the key unset falls through to the host.
    assertEquals(publicError(err, { 'error.auth': 'Profile: key.' }), 'Host-wide: busy.');
  } finally {
    resetLexicon();
  }
});

Deno.test('toErrorEvent carries the builder world only', () => {
  const ev = toErrorEvent(new TheoremError('unavailable', 'Gemini HTTP 503'));
  assertEquals(ev, { type: 'error', errorKind: 'unavailable', errorInternal: 'Gemini HTTP 503' });
  const odd = toErrorEvent({ notAnError: true });
  assertEquals(odd.errorKind, 'internal');
  assertEquals(odd.errorInternal, '[object Object]');
});

Deno.test('toErrorEvent keeps a failure copy for the host boundary', () => {
  const copy = {
    key: 'attachments.file_too_large' as const,
    params: { maxBytes: 2 * 1024 * 1024 },
  };
  const ev = toErrorEvent(new TheoremError('input', 'image/png is 3000000 bytes', { copy }));
  assertEquals(ev.errorCopy, copy);
  assertEquals(
    withPublicWording(ev).error,
    'Sorry, that file is too large. Each file needs to be 2 MB or smaller.',
  );
});

Deno.test('withPublicWording words error events with the profile lexicon', () => {
  const ev = toErrorEvent(new TheoremError('auth', 'no key in slot free'));
  assertEquals(withPublicWording(ev).error, LOCKED.auth);
  const lexicon = { 'error.auth': 'Add your API key in settings to continue.' };
  assertEquals(withPublicWording(ev, lexicon).error, lexicon['error.auth']);
  assertEquals(withPublicWording(ev, lexicon).errorInternal, 'no key in slot free');
});

Deno.test('withPublicWording keeps wording already set', () => {
  const ev = { ...toErrorEvent(new TheoremError('failed', 'x')), error: 'Host copy.' };
  assertEquals(withPublicWording(ev).error, 'Host copy.');
});

Deno.test('withPublicWording words a failed tool step with its tool name', () => {
  const ev = {
    type: 'tool' as const,
    tool: {
      name: 'send_email',
      phase: 'error' as const,
      failure: { code: 'network_blocked', kind: 'blocked' as const, message: 'blocked host' },
    },
  };
  assertEquals(withPublicWording(ev).tool?.failure?.error, LOCKED.blocked);
  const lexicon = { 'error.blocked': "Sorry, '{tool}' wasn't allowed." };
  assertEquals(
    withPublicWording(ev, lexicon).tool?.failure?.error,
    "Sorry, 'send_email' wasn't allowed.",
  );
  assertEquals(withPublicWording(ev, lexicon).tool?.failure?.message, 'blocked host');
});

Deno.test('withPublicWording leaves other events untouched', () => {
  const ev = { type: 'text' as const, text: 'hi' };
  assertEquals(withPublicWording(ev), ev);
});

Deno.test('TheoremError carries its name, kind, and copy', () => {
  const err = new TheoremError('config', 'bad profile', { copy: { key: 'error.internal' } });
  assertEquals(err.name, 'TheoremError');
  assertEquals(err.kind, 'config');
  assertEquals(err.copy, { key: 'error.internal' });
  assertEquals(new TheoremError('config', 'x').copy, undefined);
});

Deno.test('isAbortError and isTimeoutError read the error name only', () => {
  assertEquals(isAbortError(null), false);
  assertEquals(isAbortError('AbortError'), false);
  assertEquals(isAbortError(new Error('oops')), false);
  assertEquals(isAbortError({ name: 'AbortError' }), true);
  assertEquals(isAbortError(new DOMException('aborted', 'AbortError')), true);
  assertEquals(isTimeoutError(new DOMException('timed out', 'TimeoutError')), true);
  assertEquals(isTimeoutError(new DOMException('aborted', 'AbortError')), false);
});

Deno.test('throwIfAborted is a no-op when signal is undefined or not aborted', () => {
  throwIfAborted(undefined);
  throwIfAborted(new AbortController().signal);
});

Deno.test('throwIfAborted re-throws the exact abort or timeout reason', () => {
  for (const reason of [
    new DOMException('specific abort reason', 'AbortError'),
    new DOMException('timed out', 'TimeoutError'),
  ]) {
    const ctrl = new AbortController();
    ctrl.abort(reason);
    let caught: unknown;
    try {
      throwIfAborted(ctrl.signal);
    } catch (e) {
      caught = e;
    }
    assertEquals(caught === reason, true);
  }
});

Deno.test('throwIfAborted wraps any other reason in an AbortError', () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error('underlying cause'));
  assertThrows(() => throwIfAborted(ctrl.signal), DOMException);
  let caught: DOMException | undefined;
  try {
    throwIfAborted(ctrl.signal);
  } catch (e) {
    caught = e as DOMException;
  }
  assertEquals(caught?.message, 'The operation was aborted.');
  assertEquals(caught?.name, 'AbortError');
});

Deno.test('describeError returns the raw detail', () => {
  assertEquals(describeError(new Error('boom')), 'boom');
  assertEquals(describeError('detail text'), 'detail text');
  assertEquals(describeError(42), '42');
  assertEquals(describeError(null), 'null');
  assertEquals(describeError(new Error('')), 'Error');
});

Deno.test('withPublicWording words an ended session with the profile lexicon', () => {
  const ev: TurnEvent = {
    type: 'session',
    session: { kind: 'ended', ended: { cause: 'go_away', code: 1000, closedAfterMs: 0 } },
  };
  assertEquals(
    withPublicWording(ev).session?.message,
    'The call has ended. Please start a new one to carry on.',
  );
  const lexicon = { 'live.session_ended': 'That call is over. Start another any time.' };
  assertEquals(withPublicWording(ev, lexicon).session?.message, lexicon['live.session_ended']);
  const worded = {
    ...ev,
    session: { ...ev.session, kind: 'ended' as const, message: 'Host copy.' },
  };
  assertEquals(withPublicWording(worded).session?.message, 'Host copy.');
});
