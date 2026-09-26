import { assertEquals } from '@std/assert';
import type { ToolGate, TurnEvent } from '../../mod.ts';
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
import { parseLiveServerEnvelope } from '../../react/src/client/live-messages.ts';
import {
  downsampleAndConvertToInt16,
  pcm16BytesToFloat32,
} from '../../react/src/client/pcm-downsample.ts';

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

Deno.test('parseLiveServerEnvelope parses ready, events, error, and tool result payloads', () => {
  assertEquals(parseLiveServerEnvelope(null), null);
  assertEquals(parseLiveServerEnvelope('string'), null);
  assertEquals(parseLiveServerEnvelope([]), null);

  assertEquals(
    parseLiveServerEnvelope({
      type: 'ready',
      profile: 'chat',
      sessionId: 'sess_1',
    }),
    {
      type: 'ready',
      profile: 'chat',
      sessionId: 'sess_1',
    },
  );

  assertEquals(
    parseLiveServerEnvelope({
      type: 'events',
      events: [{ type: 'thought', text: 'thinking' }],
    }),
    {
      type: 'events',
      events: [{ type: 'thought', text: 'thinking' }],
    },
  );

  assertEquals(
    parseLiveServerEnvelope({
      type: 'error',
      error: 'Relay disconnected',
    }),
    {
      type: 'error',
      body: { type: 'error', error: 'Relay disconnected' },
    },
  );

  assertEquals(
    parseLiveServerEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'settled' }),
    { type: 'executeToolResult', callId: 'call_1', status: 'settled' },
  );
  const gate: ToolGate = { kind: 'confirmation', tool: 'getWeather' };
  assertEquals(
    parseLiveServerEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'gated', gate }),
    { type: 'executeToolResult', callId: 'call_1', status: 'gated', gate },
  );
  const body = {
    error: 'Sorry, that step is no longer waiting for approval.',
    errorKind: 'request',
  };
  assertEquals(
    parseLiveServerEnvelope({
      type: 'executeToolResult',
      callId: 'call_1',
      status: 'refused',
      body,
    }),
    { type: 'executeToolResult', callId: 'call_1', status: 'refused', body },
  );
  // A gated reply without its gate, or a status the relay does not send, is not a reply.
  assertEquals(
    parseLiveServerEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'gated' }),
    null,
  );
  assertEquals(
    parseLiveServerEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'complete' }),
    null,
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

Deno.test('a live call the model withdrew at its gate sends nothing more and reports nothing', async () => {
  const sent: unknown[] = [];
  const reported: unknown[] = [];
  await runLiveToolCall({
    client: {
      executeToolOnRelay: (args) => {
        sent.push(args);
        return Promise.resolve({
          status: 'gated',
          gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
        });
      },
    },
    name: 'lookup',
    toolArgs: {},
    callId: 'call-gated',
    sessionPermissions: [],
    setSessionPermissions: () => {},
    waitForGateDecision: () => Promise.resolve('withdrawn'),
    reportFailure: (err) => reported.push(err),
  });
  assertEquals(sent, [{ callId: 'call-gated' }]);
  assertEquals(reported, []);
});
