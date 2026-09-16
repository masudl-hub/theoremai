import { assertEquals } from '@std/assert';
import { PUBLIC_GENERIC, PUBLIC_UNAVAILABLE } from '../../../src/guardrails/error.ts';
import type { InteractionPart, ProviderCompleteRequest } from '../../../src/kernel/types.ts';
import {
  buildPayload,
  buildSpeechHeaders,
  createSpeechProvider,
  extractInputText,
  requestSpeech,
  streamSpeech,
  yieldSpeechSuccess,
} from '../../../src/providers/openrouter/speech.ts';
import { wrapPcmAsWav } from '../../../src/providers/shared/pcm.ts';
import { HOST_BINDINGS } from '../../fixtures/models.ts';

function createMockSpeechRequest(text: string): ProviderCompleteRequest {
  const spec = HOST_BINDINGS.gemini31FlashTts;
  return {
    model: 'gemini31FlashTts',
    apiId: spec.apiId,
    thinking: 'minimal',
    summaries: undefined,
    maxOutputTokens: 2048,
    temperature: 0.2,
    builtins: [],
    system: '',
    input: [{ type: 'text', text }],
    structured: null,
    image: null,
  };
}

Deno.test('wrapPcmAsWav creates valid 44-byte RIFF/WAVE header', () => {
  const pcm = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const wav = wrapPcmAsWav(pcm, 24000);

  assertEquals(wav.length, 44 + pcm.length);
  const view = new DataView(wav.buffer);

  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  assertEquals(riff, 'RIFF');

  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );
  assertEquals(wave, 'WAVE');

  const fmt = String.fromCharCode(
    view.getUint8(12),
    view.getUint8(13),
    view.getUint8(14),
    view.getUint8(15),
  );
  assertEquals(fmt, 'fmt ');

  assertEquals(view.getUint16(20, true), 1);
  assertEquals(view.getUint16(22, true), 1);
  assertEquals(view.getUint32(24, true), 24000);
  assertEquals(view.getUint16(34, true), 16);

  const dataTag = String.fromCharCode(
    view.getUint8(36),
    view.getUint8(37),
    view.getUint8(38),
    view.getUint8(39),
  );
  assertEquals(dataTag, 'data');
  assertEquals(view.getUint32(40, true), pcm.length);
});

Deno.test('streamSpeech yields error when apiKey is missing', async () => {
  const req = createMockSpeechRequest('Hello world');
  const events = [];
  for await (const event of streamSpeech(req, { apiKey: '' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamSpeech yields error on empty input text', async () => {
  const req = createMockSpeechRequest('');
  const events = [];
  for await (const event of streamSpeech(req, { apiKey: 'test-key' })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamSpeech handles HTTP error from speech endpoint', async () => {
  const req = createMockSpeechRequest('Hello world');
  const mockFetch: typeof fetch = () => Promise.resolve(new Response('Forbidden', { status: 403 }));

  const events = [];
  for await (const event of streamSpeech(req, { apiKey: 'test-key', fetch: mockFetch })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_UNAVAILABLE);
});

Deno.test('streamSpeech yields error when response is empty', async () => {
  const req = createMockSpeechRequest('Hello world');
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(new Uint8Array([]), {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );

  const events = [];
  for await (const event of streamSpeech(req, { apiKey: 'test-key', fetch: mockFetch })) {
    events.push(event);
  }
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, 'error');
  assertEquals((events[0] as { error: string }).error, PUBLIC_GENERIC);
});

Deno.test('streamSpeech yields media, tokens, and done on successful synthesis', async () => {
  const req = {
    ...createMockSpeechRequest('Hello, welcome to the demo!'),
    speech: { format: 'pcm' as const },
  };
  const mockPcmBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

    return Promise.resolve(
      new Response(mockPcmBytes, {
        status: 200,
        headers: {
          'Content-Type': 'audio/pcm',
          'X-Generation-Id': 'gen-12345',
        },
      }),
    );
  };

  const provider = createSpeechProvider({
    apiKey: 'mock-openrouter-key',
    voice: 'Orus',
    fetch: mockFetch,
  });

  const events = [];
  for await (const event of provider.complete(req)) {
    events.push(event);
  }

  assertEquals(capturedUrl, 'https://openrouter.ai/api/v1/audio/speech');
  assertEquals(capturedHeaders.Authorization, 'Bearer mock-openrouter-key');
  assertEquals(capturedBody.model, 'gemini-3.1-flash-tts-preview');
  assertEquals(capturedBody.input, 'Hello, welcome to the demo!');
  assertEquals(capturedBody.voice, 'Orus');
  assertEquals(capturedBody.response_format, 'pcm');

  assertEquals(events.length, 3);
  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/wav');
  assertEquals(typeof mediaEvent.media.data, 'string');

  assertEquals(events[1]?.type, 'tokens');
  const tokenEvent = events[1] as { tokens: { input: number; output: number; total: number } };
  assertEquals(tokenEvent.tokens.input > 0, true);
  assertEquals(tokenEvent.tokens.output > 0, true);

  assertEquals(events[2]?.type, 'done');
});

Deno.test('streamSpeech respects outputs.speech voice and format mp3', async () => {
  const req: ProviderCompleteRequest = {
    ...createMockSpeechRequest('Testing MP3 output'),
    speech: {
      voice: 'Kore',
      format: 'mp3',
    },
  };
  const mockMp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);

  let capturedBody: Record<string, unknown> = {};
  const mockFetch: typeof fetch = (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      new Response(mockMp3Bytes, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
        },
      }),
    );
  };

  const provider = createSpeechProvider({
    apiKey: 'mock-key',
    siteUrl: 'https://theorum.dev',
    siteName: 'Theorum Test',
    fetch: mockFetch,
  });

  const events = [];
  for await (const event of provider.complete(req)) {
    events.push(event);
  }

  assertEquals(capturedBody.voice, 'Kore');
  assertEquals(capturedBody.response_format, 'mp3');
  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/mpeg');
  assertEquals(mediaEvent.media.data, btoa(String.fromCharCode(...mockMp3Bytes)));
});

// -- extractInputText ------------------------------------------

Deno.test('extractInputText joins multiple text parts with a space', () => {
  const input: InteractionPart[] = [
    { type: 'text', text: 'Hello' },
    { type: 'text', text: 'world' },
  ];
  assertEquals(extractInputText(input), 'Hello world');
});

Deno.test('extractInputText ignores non-text parts', () => {
  const input: InteractionPart[] = [
    { type: 'text', text: 'Hello' },
    { type: 'image', mimeType: 'image/png', data: 'base64data' },
    { type: 'text', text: 'world' },
  ];
  assertEquals(extractInputText(input), 'Hello world');
});

Deno.test('extractInputText trims surrounding whitespace', () => {
  const input: InteractionPart[] = [{ type: 'text', text: '  padded  ' }];
  assertEquals(extractInputText(input), 'padded');
});

Deno.test('extractInputText returns empty string for no text parts', () => {
  const input: InteractionPart[] = [{ type: 'image', mimeType: 'image/png', data: 'base64data' }];
  assertEquals(extractInputText(input), '');
});

Deno.test('extractInputText returns empty string for empty input array', () => {
  assertEquals(extractInputText([]), '');
});

// -- buildSpeechHeaders ------------------------------------------------

Deno.test('buildSpeechHeaders sets Authorization and Content-Type only by default', () => {
  const headers = buildSpeechHeaders('secret-key', {});
  assertEquals(headers.Authorization, 'Bearer secret-key');
  assertEquals(headers['Content-Type'], 'application/json');
  assertEquals(headers['HTTP-Referer'], undefined);
  assertEquals(headers['X-Title'], undefined);
});

Deno.test('buildSpeechHeaders adds HTTP-Referer when siteUrl is set', () => {
  const headers = buildSpeechHeaders('secret-key', { siteUrl: 'https://theorum.dev' });
  assertEquals(headers['HTTP-Referer'], 'https://theorum.dev');
});

Deno.test('buildSpeechHeaders adds X-Title when siteName is set', () => {
  const headers = buildSpeechHeaders('secret-key', { siteName: 'Theorum' });
  assertEquals(headers['X-Title'], 'Theorum');
});

Deno.test('buildSpeechHeaders adds both when siteUrl and siteName are set', () => {
  const headers = buildSpeechHeaders('secret-key', {
    siteUrl: 'https://theorum.dev',
    siteName: 'Theorum',
  });
  assertEquals(headers['HTTP-Referer'], 'https://theorum.dev');
  assertEquals(headers['X-Title'], 'Theorum');
});

// -- buildPayload -------------------------------------------------

Deno.test('buildPayload omits response_format when speech.format is unset', () => {
  const req = createMockSpeechRequest('hi');
  const payload = buildPayload(req, 'hi there', undefined, undefined);
  assertEquals('response_format' in payload, false);
  assertEquals(payload.input, 'hi there');
  assertEquals('voice' in payload, false);
});

Deno.test('buildPayload prefers speech.voice over configVoice', () => {
  const req = createMockSpeechRequest('hi');
  const payload = buildPayload(req, 'hi there', { voice: 'Kore' }, 'fallback-voice');
  assertEquals(payload.voice, 'Kore');
});

Deno.test('buildPayload falls back to configVoice when speech.voice is absent', () => {
  const req = createMockSpeechRequest('hi');
  const payload = buildPayload(req, 'hi there', undefined, 'fallback-voice');
  assertEquals(payload.voice, 'fallback-voice');
});

Deno.test('buildPayload honors speech.format', () => {
  const req = createMockSpeechRequest('hi');
  const payload = buildPayload(req, 'hi there', { format: 'mp3' }, undefined);
  assertEquals(payload.response_format, 'mp3');
});

Deno.test('buildPayload uses apiId on the wire', () => {
  const req = createMockSpeechRequest('hi');
  const payload = buildPayload(req, 'hi there', undefined, undefined);
  assertEquals(payload.model, req.apiId);
});

// -- yieldSpeechSuccess -------------------------------------------

Deno.test('yieldSpeechSuccess wraps pcm bytes as wav media', () => {
  const rawBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const events = [...yieldSpeechSuccess(rawBytes, 'hello world', 'pcm')];

  assertEquals(events.length, 3);
  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/wav');
  assertEquals(typeof mediaEvent.media.data, 'string');
});

Deno.test('yieldSpeechSuccess passes mp3 bytes through unwrapped', () => {
  const rawBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  const events = [...yieldSpeechSuccess(rawBytes, 'hello world', 'mp3')];

  assertEquals(events[0]?.type, 'media');
  const mediaEvent = events[0] as { media: { mimeType: string; data: string } };
  assertEquals(mediaEvent.media.mimeType, 'audio/mpeg');
  assertEquals(mediaEvent.media.data, btoa(String.fromCharCode(...rawBytes)));
});

Deno.test('yieldSpeechSuccess computes token counts from text and byte lengths', () => {
  const rawBytes = new Uint8Array(250);
  const text = 'a'.repeat(40);
  const events = [...yieldSpeechSuccess(rawBytes, text, 'mp3')];

  assertEquals(events[1]?.type, 'tokens');
  const tokenEvent = events[1] as { tokens: { input: number; output: number; total: number } };
  assertEquals(tokenEvent.tokens.input, 10);
  assertEquals(tokenEvent.tokens.output, 3);
  assertEquals(tokenEvent.tokens.total, 13);
});

Deno.test('yieldSpeechSuccess floors token counts at 1', () => {
  const rawBytes = new Uint8Array(1);
  const events = [...yieldSpeechSuccess(rawBytes, 'a', 'mp3')];

  const tokenEvent = events[1] as { tokens: { input: number; output: number; total: number } };
  assertEquals(tokenEvent.tokens.input, 1);
  assertEquals(tokenEvent.tokens.output, 1);
  assertEquals(tokenEvent.tokens.total, 2);
});

Deno.test('yieldSpeechSuccess ends with a done event', () => {
  const rawBytes = new Uint8Array([1, 2, 3]);
  const events = [...yieldSpeechSuccess(rawBytes, 'hi', 'mp3')];
  assertEquals(events[2]?.type, 'done');
});

Deno.test('createSpeechProvider exposes complete() and requestSpeech sends POST', async () => {
  const provider = createSpeechProvider({ apiKey: 'key' });
  assertEquals(typeof provider.complete, 'function');

  let capturedUrl = '';
  const mockFetch: typeof fetch = (input) => {
    capturedUrl = String(input);
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  };
  const req = createMockSpeechRequest('say hello');
  const res = await requestSpeech('secret-key', 'say hello', req, {
    apiKey: 'secret-key',
    fetch: mockFetch,
  });
  assertEquals(res.status, 200);
  assertEquals(capturedUrl, 'https://openrouter.ai/api/v1/audio/speech');
});
