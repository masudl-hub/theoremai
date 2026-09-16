import { assertEquals } from '@std/assert';
import {
  float32Rms,
  float32RmsToLevel,
  INPUT_LEVEL_GAIN,
  timeDomainBytesToLevel,
} from '../../react/src/client/audio-level.ts';
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
      error: 'Relay disconnected',
    },
  );

  assertEquals(
    parseLiveServerEnvelope({
      type: 'executeToolResult',
      callId: 'call_1',
      name: 'getWeather',
      status: 'complete',
      output: { temp: 72 },
    }),
    {
      type: 'executeToolResult',
      callId: 'call_1',
      name: 'getWeather',
      status: 'complete',
      output: { temp: 72 },
      gate: undefined,
      awaiting: undefined,
      failure: undefined,
    },
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
