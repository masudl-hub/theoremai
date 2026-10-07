/// <reference lib="dom" />
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
import { pageToolMismatch } from '../../react/src/client/live/live-page-tool.ts';
import { runLiveToolCall } from '../../react/src/client/live/run-live-tool-call.ts';
import { LiveSessionClient, type LiveSocket } from '../../react/src/client/live-client.ts';
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
import {
  parseLiveClientMessage,
  parseLiveOpenMessage,
} from '../../react/src/server/request-check.ts';
import { liveSessionOpen } from '../../react/src/server/turn-input.ts';
import { assertMalformed } from '../fixtures/malformed.ts';

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

/** An envelope as the relay sends it: its JSON text. */
function readEnvelope(raw: unknown) {
  return parseLiveServerEnvelope(JSON.stringify(raw));
}

/** A relay envelope that fails its check: `malformed`, and the call goes on. */
function assertBadEnvelope(raw: unknown): void {
  assertMalformed(readEnvelope(raw));
}

Deno.test('parseLiveServerEnvelope parses ready, events, error, and tool result payloads', () => {
  assertEquals(
    readEnvelope({
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
    readEnvelope({
      type: 'events',
      events: [{ type: 'thought', text: 'thinking' }],
    }),
    {
      type: 'events',
      events: [{ type: 'thought', text: 'thinking' }],
    },
  );

  assertEquals(readEnvelope({ type: 'error', error: 'Relay disconnected' }), {
    type: 'error',
    error: 'Relay disconnected',
  });

  assertEquals(readEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'settled' }), {
    type: 'executeToolResult',
    callId: 'call_1',
    status: 'settled',
  });
  const gate: ToolGate = { kind: 'confirmation', tool: 'getWeather' };
  assertEquals(
    readEnvelope({ type: 'executeToolResult', callId: 'call_1', status: 'gated', gate }),
    { type: 'executeToolResult', callId: 'call_1', status: 'gated', gate },
  );
  const body: HostErrorBody = {
    error: 'Sorry, that step is no longer waiting for approval.',
    errorKind: 'request',
  };
  assertEquals(
    readEnvelope({
      type: 'executeToolResult',
      callId: 'call_1',
      status: 'refused',
      body,
    }),
    { type: 'executeToolResult', callId: 'call_1', status: 'refused', body },
  );
});

Deno.test('an envelope or event of a kind this client does not know arrives as unsupported', () => {
  const envelope = { type: 'presence', who: 'relay' };
  assertEquals(readEnvelope(envelope), {
    type: 'unsupported',
    received: 'presence',
    raw: envelope,
  });
  const event = { type: 'sparkle', level: 3 };
  assertEquals(readEnvelope({ type: 'events', events: [event] }), {
    type: 'events',
    events: [{ type: 'unsupported', received: 'sparkle', raw: event }],
  });
});

Deno.test('a malformed envelope or gate arrives as malformed', () => {
  assertMalformed(parseLiveServerEnvelope('{not json'));
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

Deno.test("a malformed event arrives as malformed in its place; the envelope's other events stand", () => {
  const parsed = readEnvelope({
    type: 'events',
    events: [
      { type: 'thought', text: 'before' },
      { type: 'text', text: { secret: 'secret-value' } },
      { text: 'no kind' },
      { type: 'thought', text: 'after' },
    ],
  });
  if (parsed.type !== 'events') throw new Error('expected an events envelope');
  const [before, badText, noKind, after] = parsed.events;
  assertEquals(
    [before, after],
    [
      { type: 'thought', text: 'before' },
      { type: 'thought', text: 'after' },
    ],
  );
  assertEquals(assertMalformed(badText), "a 'text' line failed its wire check: text invalid_type");
  assertEquals(
    assertMalformed(noKind),
    'a line without a kind failed its wire check: type invalid_type',
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

Deno.test('a page tool answers its call with the page output; any other call runs on the relay', async () => {
  const sent: unknown[] = [];
  const seen: unknown[] = [];
  const call = (name: string, callId: string) =>
    runLiveToolCall({
      executeToolOnRelay: (args) => {
        sent.push(args);
        return Promise.resolve({ status: 'settled' });
      },
      pageTools: {
        highlight: (args, made) => {
          seen.push([args, made]);
          return { output: { success: true } };
        },
      },
      name,
      toolArgs: { target: 'pricing' },
      callId,
      sessionPermissions: [],
      setSessionPermissions: () => {},
      waitForGateDecision: () => Promise.resolve('withdrawn'),
    });
  await call('highlight', 'call-page');
  await call('lookup', 'call-relay');
  // A name the model made up is not looked up on the object's prototype.
  await call('toString', 'call-proto');
  assertEquals(seen, [[{ target: 'pricing' }, { callId: 'call-page' }]]);
  assertEquals(sent, [
    { callId: 'call-page', output: { success: true } },
    { callId: 'call-relay' },
    { callId: 'call-proto' },
  ]);
});

Deno.test('a relay reads each live message by its schema; a malformed one is a request error', () => {
  assertEquals(parseLiveClientMessage(JSON.stringify({ type: 'text', text: 'hi', extra: 1 })), {
    type: 'text',
    text: 'hi',
  });
  assertEquals(
    parseLiveClientMessage(JSON.stringify({ type: 'context', context: { page: '/' } })),
    { type: 'context', context: { page: '/' } },
  );
  // The open message is the call's first, and only its first.
  assertThrows(() => parseLiveClientMessage(JSON.stringify({ type: 'open' })), TheoremError);
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

/** The provider's resumption handle, as the session sends it. */
function handleEvent(handle: string): TurnEvent {
  return {
    type: 'evidence',
    sessionResumptionHandle: handle,
    evidence: { provider: 'google', kind: 'session_resumption', resumable: true, raw: {} },
  };
}

/** A socket the test drives, and timers it fires by hand. */
function liveHarness() {
  const sockets: Array<LiveSocket & { sent: unknown[]; state: number }> = [];
  const timers: Array<{ run: () => void; ms: number; id: number }> = [];
  const real = {
    AudioContext: Reflect.get(globalThis, 'AudioContext'),
    location: Reflect.get(globalThis, 'location'),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
  };
  let now = 1_000_000;
  Reflect.set(
    globalThis,
    'AudioContext',
    class {
      state = 'running';
      close() {}
    },
  );
  Reflect.set(globalThis, 'location', { protocol: 'https:', host: 'example.test' });
  Reflect.set(globalThis, 'setTimeout', (run: () => void, ms: number) => {
    const id = timers.length + 1;
    timers.push({ run, ms, id });
    return id;
  });
  Reflect.set(globalThis, 'clearTimeout', (id: number) => {
    const at = timers.findIndex((timer) => timer.id === id);
    if (at !== -1) timers.splice(at, 1);
  });
  Date.now = () => now;
  return {
    sockets,
    createSocket: (): LiveSocket => {
      const socket = {
        state: WebSocket.CONNECTING as number,
        get readyState() {
          return this.state;
        },
        binaryType: 'blob' as BinaryType,
        sent: [] as unknown[],
        send(data: string) {
          this.sent.push(JSON.parse(data));
        },
        close: () => {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as LiveSocket & { sent: unknown[]; state: number };
      sockets.push(socket);
      return socket;
    },
    /** The socket opens, and the relay says the session is ready. */
    async ready(socket: LiveSocket & { state: number }, events: unknown[] = []) {
      socket.state = WebSocket.OPEN;
      socket.onopen?.call(socket as never, new Event('open'));
      const say = (envelope: unknown) =>
        socket.onmessage?.call(
          socket as never,
          new MessageEvent('message', { data: JSON.stringify(envelope) }),
        );
      say({ type: 'ready' });
      if (events.length) say({ type: 'events', events });
      await new Promise<void>((resolve) => real.setTimeout(resolve, 0));
    },
    drop(socket: LiveSocket & { state: number }) {
      socket.state = WebSocket.CLOSED;
      socket.onclose?.call(socket as never, new CloseEvent('close'));
    },
    /** The reconnect waits, without the 20 second connect timeout. */
    waits: () => timers.filter((timer) => timer.ms !== 20_000).map((timer) => timer.ms),
    advance(ms: number) {
      now += ms;
    },
    fire(ms: number) {
      const at = timers.findIndex((timer) => timer.ms === ms);
      const [timer] = timers.splice(at, 1);
      timer.run();
    },
    restore() {
      Reflect.set(globalThis, 'AudioContext', real.AudioContext);
      Reflect.set(globalThis, 'location', real.location);
      Reflect.set(globalThis, 'setTimeout', real.setTimeout);
      Reflect.set(globalThis, 'clearTimeout', real.clearTimeout);
      Date.now = real.now;
    },
  };
}

Deno.test('a call opens with its slots, context and host message; a changed context follows once', async () => {
  const live = liveHarness();
  const client = new LiveSessionClient({
    createSocket: live.createSocket,
    openMessage: { type: 'draft' },
    slots: { language: 'fr' },
    context: { page: '/docs' },
    voiceIngress: false,
    onToolCall: async () => {},
  });
  try {
    await client.connect();
    const [socket] = live.sockets;
    client.sendText('hello');
    // Set before the call is through: it goes with the opening.
    client.setContext({ page: '/pricing' });
    assertEquals(socket.sent, []);

    await live.ready(socket);
    client.sendText('hello');
    client.setContext({ page: '/pricing' });
    client.setContext({ page: '/pricing', cart: 2 });
    assertEquals(socket.sent, [
      {
        type: 'open',
        slots: { language: 'fr' },
        context: { page: '/pricing' },
        host: { type: 'draft' },
      },
      { type: 'text', text: 'hello' },
      { type: 'context', context: { page: '/pricing', cart: 2 } },
    ]);
  } finally {
    client.disconnect();
    live.restore();
  }
});

Deno.test('a dropped call with a resumption handle reconnects, and reports the time away', async () => {
  const live = liveHarness();
  const statuses: string[] = [];
  const client = new LiveSessionClient({
    createSocket: live.createSocket,
    context: { page: '/docs' },
    voiceIngress: false,
    onStatusChange: (status) => void statuses.push(status),
    onToolCall: async () => {},
  });
  try {
    await client.connect();
    await live.ready(live.sockets[0], [handleEvent('handle-1')]);
    live.drop(live.sockets[0]);
    assertEquals(statuses, ['connecting', 'listening', 'reconnecting']);
    assertEquals(live.waits(), [500]);

    // The first try fails before it is ready: the next waits longer.
    live.advance(500);
    live.fire(500);
    await Promise.resolve();
    live.drop(live.sockets[1]);
    assertEquals(live.waits(), [1000]);

    // The page moved on while the call was away.
    client.setContext({ page: '/pricing' });
    live.advance(1000);
    live.fire(1000);
    await Promise.resolve();
    await live.ready(live.sockets[2]);
    assertEquals(live.sockets[2].sent, [
      {
        type: 'open',
        context: { page: '/pricing' },
        resume: { handle: 'handle-1', awayMs: 1500 },
      },
    ]);
    assertEquals(statuses.slice(3), ['reconnecting', 'reconnecting', 'listening']);
  } finally {
    client.disconnect();
    live.restore();
  }
});

const ENDED_EVENT = {
  type: 'session',
  session: {
    kind: 'ended',
    message: 'The call ended.',
    ended: { cause: 'go_away', code: 1000, closedAfterMs: 10 },
  },
};

Deno.test('a call the provider ends at its limit is taken up again when it has a handle', async () => {
  const live = liveHarness();
  const statuses: string[] = [];
  let ended = 0;
  const client = new LiveSessionClient({
    createSocket: live.createSocket,
    voiceIngress: false,
    onStatusChange: (status) => void statuses.push(status),
    onSessionEnded: () => void ended++,
    onToolCall: async () => {},
  });
  try {
    await client.connect();
    await live.ready(live.sockets[0], [handleEvent('handle-1'), ENDED_EVENT]);
    assertEquals(statuses, ['connecting', 'listening', 'reconnecting']);
    assertEquals(ended, 0);
    live.fire(500);
    await Promise.resolve();
    await live.ready(live.sockets[1]);
    assertEquals(live.sockets[1].sent, [
      { type: 'open', resume: { handle: 'handle-1', awayMs: 0 } },
    ]);
    assertEquals(statuses.at(-1), 'listening');
  } finally {
    client.disconnect();
    live.restore();
  }
});

Deno.test('a drop with no handle, or after the session ended, ends the call; five failed tries fail it', async () => {
  const live = liveHarness();
  const statuses: string[] = [];
  const errors: string[] = [];
  const options = {
    createSocket: live.createSocket,
    voiceIngress: false,
    onStatusChange: (status: string) => void statuses.push(status),
    onError: (err: Error) => void errors.push(err instanceof TheoremError ? err.kind : 'other'),
    onToolCall: async () => {},
  };
  const client = new LiveSessionClient(options);
  try {
    await client.connect();
    await live.ready(live.sockets[0]);
    live.drop(live.sockets[0]);
    assertEquals(statuses, ['connecting', 'listening', 'disconnected']);

    await client.connect();
    await live.ready(live.sockets[1], [ENDED_EVENT]);
    live.drop(live.sockets[1]);
    assertEquals(statuses.slice(3), ['connecting', 'listening', 'disconnected']);

    await client.connect();
    await live.ready(live.sockets[2], [handleEvent('handle-3')]);
    live.drop(live.sockets[2]);
    for (const [index, ms] of [500, 1000, 2000, 4000, 8000].entries()) {
      assertEquals(live.waits(), [ms]);
      live.fire(ms);
      await Promise.resolve();
      live.drop(live.sockets[3 + index]);
    }
    assertEquals(live.waits(), []);
    assertEquals(statuses.at(-1), 'error');
    assertEquals(errors, ['network']);
  } finally {
    client.disconnect();
    live.restore();
  }
});

Deno.test('a relay reads the open message into the session request, with the host context as server', () => {
  const open = parseLiveOpenMessage(
    JSON.stringify({
      type: 'open',
      slots: { language: 'fr' },
      context: { page: '/docs' },
      resume: { handle: 'handle-1', awayMs: 4200 },
      host: { type: 'draft' },
    }),
  );
  assertEquals(liveSessionOpen(open, { tier: 'pro' }), {
    slots: { language: 'fr' },
    context: { client: { page: '/docs' }, server: { tier: 'pro' } },
    sessionResumptionHandle: 'handle-1',
    awayMs: 4200,
  });
  assertEquals(liveSessionOpen(parseLiveOpenMessage('{"type":"open"}')), {});
  for (const bad of [
    '{not json',
    '{"type":"text","text":"hi"}',
    '{"type":"open","resume":{"handle":"","awayMs":0}}',
    '{"type":"open","resume":{"handle":"h","awayMs":-1}}',
    '{"type":"open","slots":{"language":2}}',
  ]) {
    assertEquals(assertThrows(() => parseLiveOpenMessage(bad), TheoremError).kind, 'request');
  }
});

Deno.test('pageToolMismatch names a page tool with no handler, and a handler for no page tool', () => {
  assertEquals(pageToolMismatch(['highlight', 'scroll'], ['highlight', 'lookup']), {
    unanswered: ['scroll'],
    unused: ['lookup'],
  });
  assertEquals(pageToolMismatch([], []), { unanswered: [], unused: [] });
});
