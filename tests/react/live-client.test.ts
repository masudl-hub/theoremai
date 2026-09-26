import { assertEquals, assertThrows } from '@std/assert';
import { TheoremError, type ToolGate, type TurnEvent } from '../../mod.ts';
import {
  float32Rms,
  float32RmsToLevel,
  INPUT_LEVEL_GAIN,
  timeDomainBytesToLevel,
} from '../../react/src/client/audio-level.ts';
import { clientFailure } from '../../react/src/client/failure.ts';
import { applyLiveTurnToolEvent } from '../../react/src/client/live/apply-live-turn-tool-event.ts';
import { runLiveToolCall } from '../../react/src/client/live/run-live-tool-call.ts';
import { isPermissionDeniedError } from '../../react/src/client/live-errors.ts';
import {
  type ExecuteToolOnRelay,
  parseLiveServerEnvelope,
} from '../../react/src/client/live-messages.ts';
import {
  downsampleAndConvertToInt16,
  pcm16BytesToFloat32,
} from '../../react/src/client/pcm-downsample.ts';
import type { HostErrorBody } from '../../react/src/client/transport.ts';
import { parseLiveClientMessage } from '../../react/src/server/request-check.ts';
import { neverMalformed } from '../fixtures/live-envelope.ts';

Deno.test('isPermissionDeniedError detects permission denial variants', () => {
  assertEquals(isPermissionDeniedError(null), false);
  assertEquals(isPermissionDeniedError('not an error'), false);
  assertEquals(isPermissionDeniedError(new Error('Normal error')), false);

  const notAllowed = new Error('Permission not allowed');
  notAllowed.name = 'NotAllowedError';
  assertEquals(isPermissionDeniedError(notAllowed), true);

  const permDenied = new Error('Permission denied');
  permDenied.name = 'PermissionDeniedError';
  assertEquals(isPermissionDeniedError(permDenied), true);

  assertEquals(isPermissionDeniedError(new Error('User denied audio permission')), true);
});

/** A relay envelope this client knows the kind of, but that fails its schema. */
function assertBadEnvelope(raw: unknown): void {
  const err = assertThrows(() => parseLiveServerEnvelope(raw, neverMalformed), TheoremError);
  assertEquals(err.kind, 'bad_response');
  // The failure names what broke, never the value.
  assertEquals(err.message.includes('secret-value'), false);
}

Deno.test('parseLiveServerEnvelope parses ready, events, error, and tool result payloads', () => {
  assertEquals(
    parseLiveServerEnvelope(
      {
        type: 'ready',
        profile: 'chat',
        sessionId: 'sess_1',
      },
      neverMalformed,
    ),
    {
      type: 'ready',
      profile: 'chat',
      sessionId: 'sess_1',
    },
  );

  assertEquals(
    parseLiveServerEnvelope(
      {
        type: 'events',
        events: [{ type: 'thought', text: 'thinking' }],
      },
      neverMalformed,
    ),
    {
      type: 'events',
      events: [{ type: 'thought', text: 'thinking' }],
    },
  );

  assertEquals(
    parseLiveServerEnvelope({ type: 'error', error: 'Relay disconnected' }, neverMalformed),
    {
      type: 'error',
      error: 'Relay disconnected',
    },
  );

  assertEquals(
    parseLiveServerEnvelope(
      { type: 'executeToolResult', callId: 'call_1', status: 'settled' },
      neverMalformed,
    ),
    { type: 'executeToolResult', callId: 'call_1', status: 'settled' },
  );
  const gate: ToolGate = { kind: 'confirmation', tool: 'getWeather' };
  assertEquals(
    parseLiveServerEnvelope(
      { type: 'executeToolResult', callId: 'call_1', status: 'gated', gate },
      neverMalformed,
    ),
    { type: 'executeToolResult', callId: 'call_1', status: 'gated', gate },
  );
  const body: HostErrorBody = {
    error: 'Sorry, that step is no longer waiting for approval.',
    errorKind: 'request',
  };
  assertEquals(
    parseLiveServerEnvelope(
      {
        type: 'executeToolResult',
        callId: 'call_1',
        status: 'refused',
        body,
      },
      neverMalformed,
    ),
    { type: 'executeToolResult', callId: 'call_1', status: 'refused', body },
  );
});

Deno.test('an envelope or event of a kind this client does not know arrives as unsupported', () => {
  const envelope = { type: 'presence', who: 'relay' };
  assertEquals(parseLiveServerEnvelope(envelope, neverMalformed), {
    type: 'unsupported',
    received: 'presence',
    raw: envelope,
  });
  const event = { type: 'sparkle', level: 3 };
  assertEquals(parseLiveServerEnvelope({ type: 'events', events: [event] }, neverMalformed), {
    type: 'events',
    events: [{ type: 'unsupported', received: 'sparkle', raw: event }],
  });
});

Deno.test('a malformed envelope or gate is a bad response', () => {
  assertBadEnvelope(null);
  assertBadEnvelope('string');
  assertBadEnvelope([]);
  assertBadEnvelope({ type: 'ready', profile: 7 });
  // A gated reply without its gate, a gate that fails its schema, or a status the relay does not send.
  assertBadEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'gated' });
  assertBadEnvelope({
    type: 'executeToolResult',
    callId: 'call_1',
    status: 'gated',
    gate: { kind: 'confirmation', tool: 7 },
  });
  assertBadEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'complete' });
  assertBadEnvelope({ type: 'error', errorKind: 'secret-value' });
});

Deno.test("a malformed event is reported and left out; the envelope's other events stand", () => {
  const reported: TheoremError[] = [];
  const parsed = parseLiveServerEnvelope(
    {
      type: 'events',
      events: [
        { type: 'thought', text: 'before' },
        { type: 'text', text: { secret: 'secret-value' } },
        { text: 'no kind' },
        { type: 'thought', text: 'after' },
      ],
    },
    (error) => reported.push(error),
  );
  assertEquals(parsed, {
    type: 'events',
    events: [
      { type: 'thought', text: 'before' },
      { type: 'thought', text: 'after' },
    ],
  });
  assertEquals(
    reported.map((error) => error.kind),
    ['bad_response', 'bad_response'],
  );
  // The report names what broke, never the value.
  assertEquals(
    reported.some((error) => error.message.includes('secret-value')),
    false,
  );
});

Deno.test('audio-level calculates RMS and scales levels within bounds', () => {
  assertEquals(float32Rms(new Float32Array([])), 0);
  assertEquals(timeDomainBytesToLevel(new Uint8Array([])), 0);

  const silent = new Float32Array([0, 0, 0, 0]);
  assertEquals(float32Rms(silent), 0);
  assertEquals(float32RmsToLevel(silent), 0);

  const tones = new Float32Array([0.5, -0.5, 0.5, -0.5]);
  assertEquals(float32Rms(tones), 0.5);
  assertEquals(float32RmsToLevel(tones), Math.min(1, 0.5 * INPUT_LEVEL_GAIN));

  const byteSilence = new Uint8Array([128, 128, 128, 128]);
  assertEquals(timeDomainBytesToLevel(byteSilence), 0);
});

Deno.test('downsampleAndConvertToInt16 converts sample rates and round-trips with pcm16BytesToFloat32', () => {
  const float32 = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const int16SameRate = downsampleAndConvertToInt16(float32, 16000, 16000);
  assertEquals(int16SameRate.length, float32.length);

  const float32Downsampled = downsampleAndConvertToInt16(float32, 48000, 16000);
  assertEquals(float32Downsampled.length, Math.round(float32.length / 3));

  const bytes = new Uint8Array(int16SameRate.buffer);
  const recoveredFloat32 = pcm16BytesToFloat32(bytes);
  assertEquals(recoveredFloat32.length, float32.length);
  assertEquals(Math.abs(recoveredFloat32[0] - float32[0]) < 0.001, true);
  assertEquals(Math.abs(recoveredFloat32[1] - float32[1]) < 0.001, true);
});

function liveToolFailure(event: TurnEvent) {
  const reported: unknown[] = [];
  applyLiveTurnToolEvent(event, {
    gateCallId: undefined,
    withdrawGate: () => {},
    clearInterim: () => {},
    clearActiveTool: () => {},
    reportFailure: (err) => reported.push(err),
    setActiveTool: () => {},
  });
  assertEquals(reported.length, 1);
  return clientFailure(reported[0], { 'error.failed': 'Tool failed.' });
}

Deno.test('a live tool error shows the user wording, never the model message', () => {
  const failure = liveToolFailure({
    type: 'tool',
    tool: {
      name: 'search',
      callId: 'call-1',
      at: 0,
      phase: 'error',
      failure: {
        code: 'upstream',
        kind: 'unavailable',
        message: 'model: retry later',
        error: 'Search is down.',
      },
    },
  });
  assertEquals(failure, {
    error: 'Search is down.',
    errorKind: 'unavailable',
    errorInternal: 'model: retry later',
  });
});

Deno.test('a live gate closes when the model cancels its call, with nothing reported', () => {
  const seen: string[] = [];
  const args = {
    gateCallId: 'call-gated',
    withdrawGate: () => seen.push('withdraw'),
    clearInterim: () => {},
    clearActiveTool: () => seen.push('clear'),
    reportFailure: () => seen.push('report'),
    setActiveTool: () => {},
  };
  applyLiveTurnToolEvent(
    { type: 'tool', tool: { name: 'search', callId: 'call-other', at: 0, phase: 'cancel' } },
    args,
  );
  assertEquals(seen, []);
  applyLiveTurnToolEvent(
    { type: 'tool', tool: { name: 'lookup', callId: 'call-gated', at: 0, phase: 'cancel' } },
    args,
  );
  assertEquals(seen, ['withdraw', 'clear']);
});

/** A relay that holds every call on a permission gate until it is answered. */
function gatedRelay(sent: unknown[]): ExecuteToolOnRelay {
  return (args) => {
    sent.push(args);
    return Promise.resolve({
      status: 'gated',
      gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
    });
  };
}

Deno.test('a live call the model withdrew at its gate sends nothing more', async () => {
  const sent: unknown[] = [];
  await runLiveToolCall({
    executeToolOnRelay: gatedRelay(sent),
    name: 'lookup',
    toolArgs: {},
    callId: 'call-gated',
    sessionPermissions: [],
    setSessionPermissions: () => {},
    waitForGateDecision: () => Promise.resolve('withdrawn'),
  });
  assertEquals(sent, [{ callId: 'call-gated' }]);
});

Deno.test('a live deny goes to the session, which settles the call; nothing else is sent', async () => {
  const sent: unknown[] = [];
  await runLiveToolCall({
    executeToolOnRelay: gatedRelay(sent),
    name: 'lookup',
    toolArgs: {},
    callId: 'call-gated',
    sessionPermissions: [],
    setSessionPermissions: () => {},
    waitForGateDecision: () => Promise.resolve({ action: 'deny' }),
  });
  assertEquals(sent, [{ callId: 'call-gated' }, { callId: 'call-gated', decision: 'deny' }]);
});

Deno.test('a relay reads each live message by its schema; a malformed one is a request error', () => {
  assertEquals(parseLiveClientMessage(JSON.stringify({ type: 'text', text: 'hi', extra: 1 })), {
    type: 'text',
    text: 'hi',
  });
  assertEquals(
    parseLiveClientMessage(
      JSON.stringify({ type: 'executeTool', callId: 'c', decision: 'approve', input: { id: 2 } }),
    ),
    { type: 'executeTool', callId: 'c', decision: 'approve', input: { id: 2 } },
  );
  for (const [text, message] of [
    ['{nope', 'live message must be JSON'],
    [
      JSON.stringify({ type: 'video', data: 'x' }),
      'live message failed its check: mimeType invalid_type',
    ],
    [
      JSON.stringify({ type: 'executeTool', callId: '' }),
      'live message failed its check: callId too_small',
    ],
    [
      JSON.stringify({ type: 'executeTool', callId: 'c', decision: 'maybe' }),
      'live message failed its check: decision invalid_value',
    ],
    [JSON.stringify({ type: 'wave' }), 'live message failed its check: type invalid_union'],
  ] as const) {
    const err = assertThrows(() => parseLiveClientMessage(text), TheoremError);
    assertEquals([err.kind, err.message], ['request', message]);
  }
});
