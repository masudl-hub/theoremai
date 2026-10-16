import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../../src/guardrails/error.ts';
import {
  callProtocol,
  checkBinding,
  createProviderRegistry,
  defineProvider,
  query,
  type TurnRequest,
} from '../../../src/kernel/protocols/mod.ts';
import type { JsonObject } from '../../../src/kernel/provider-contract.ts';
import { geminiLive } from '../../../src/providers/gemini/live-protocol.ts';

// Frames follow the shapes recorded from gemini-3.1-flash-live (23/09/2026); text is synthetic.

/** A WebSocket that opens on the next tick and answers each frame it is sent from a script. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sent: JsonObject[] = [];
  constructor(
    readonly url: string,
    private readonly answer: (frame: JsonObject, socket: FakeSocket) => void,
  ) {
    super();
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    }, 0);
  }
  send(text: string) {
    const frame = JSON.parse(text) as JsonObject;
    this.sent.push(frame);
    this.answer(frame, this);
  }
  receive(frame: JsonObject, binary = false) {
    const text = JSON.stringify(frame);
    const data = binary ? new Blob([text]) : text;
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  close(code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

const google = defineProvider({
  id: 'google-test',
  name: 'Google',
  description: 'A test Gemini host.',
  key: z.string(),
  authorize: query('key'),
  serves: () => [{ protocol: geminiLive, baseUrl: 'wss://gemini.test/ws' }],
});

const request = {
  system: 'Be brief.',
  input: [{ type: 'text', text: 'Hello' }],
  builtins: [],
  structured: null,
  image: null,
} as unknown as TurnRequest;

function open(
  answer: (frame: JsonObject, socket: FakeSocket) => void,
  turn: Partial<TurnRequest> = {},
  vault: Record<string, string> = { main: 'k-main' },
  fallbackKeySlot?: string,
) {
  const sockets: FakeSocket[] = [];
  const registry = createProviderRegistry();
  registry.register(google, { keySlot: 'main', ...(fallbackKeySlot ? { fallbackKeySlot } : {}) });
  const provider = registry.require('google-test', 'gemini-live');
  const call = callProtocol({
    provider,
    binding: checkBinding(
      provider,
      { protocol: 'geminiLive', provider: 'google-test', apiId: 'gemini-live' },
      'live',
    ),
    profileType: 'live',
    vault,
    openWebSocket: async (url) => {
      const socket = new FakeSocket(url, answer);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    wait: async () => {},
  });
  return { sockets, session: () => call.openSession({ ...request, ...turn }) };
}

/** Answers setup, then speaks one turn after the first input. */
function script(frame: JsonObject, socket: FakeSocket) {
  if (frame.setup) queueMicrotask(() => socket.receive({ setupComplete: {} }, true));
  if (frame.realtimeInput)
    queueMicrotask(() => {
      socket.receive({ serverContent: { modelTurn: { parts: [{ text: 'Hi there.' }] } } });
      socket.receive({ sessionResumptionUpdate: { newHandle: 'h-1', resumable: true } });
      socket.receive({
        serverContent: { turnComplete: true },
        usageMetadata: { promptTokenCount: 3, responseTokenCount: 2 },
      });
      socket.close(1000, 'bye');
    });
}

Deno.test('geminiLive signs in with the key in the query, waits for setup, and speaks a turn', async () => {
  const { sockets, session } = open(script);
  const live = await session();
  const events = await Array.fromAsync(live.events());
  const url = new URL(sockets[0]?.url ?? '');
  assertEquals(
    url.origin + url.pathname,
    'wss://gemini.test/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
  );
  assertEquals(url.searchParams.get('key'), 'k-main');
  const setup = sockets[0]?.sent[0]?.setup as JsonObject;
  assertEquals(setup.model, 'models/gemini-live');
  assertEquals(setup.inputAudioTranscription, {});
  assertEquals(sockets[0]?.sent[1], { realtimeInput: { text: 'Hello' } });
  assertEquals(
    events.filter((event) => event.type === 'text'),
    [{ type: 'text', text: 'Hi there.' }],
  );
  const done = events.filter((event) => event.type === 'done');
  assertEquals(done, [{ type: 'done', stop: { kind: 'completed' }, state: { liveHandle: 'h-1' } }]);
  assertEquals(live.closeInfo?.(), { code: 1000, reason: 'bye' });
});

Deno.test('a quota close at setup reopens on the fallback key', async () => {
  const { sockets, session } = open(
    (frame, socket) => {
      if (frame.setup && new URL(socket.url).searchParams.get('key') === 'k-main')
        queueMicrotask(() => socket.close(1011, 'You exceeded your current quota.'));
      else script(frame, socket);
    },
    {},
    { main: 'k-main', spare: 'k-spare' },
    'spare',
  );
  const live = await session();
  await Array.fromAsync(live.events());
  assertEquals(
    sockets.map((socket) => new URL(socket.url).searchParams.get('key')),
    ['k-main', 'k-spare'],
  );
});

Deno.test('a bad key closing setup is an auth error', async () => {
  const { session } = open((frame, socket) => {
    if (frame.setup)
      queueMicrotask(() => socket.close(1007, 'API key not valid. Please pass a valid API key.'));
  });
  const error = await assertRejects(() => session(), TheoremError);
  assertEquals(error.kind, 'auth');
});

Deno.test('a resumed session sends its handle and only what came after it', async () => {
  const { sockets, session } = open(script, {
    state: { liveHandle: 'h-0' },
    stateHistoryLength: 2,
    history: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ],
  });
  const live = await session();
  await Array.fromAsync(live.events());
  const setup = sockets[0]?.sent[0]?.setup as JsonObject;
  assertEquals(setup.sessionResumption, { handle: 'h-0' });
  const content = sockets[0]?.sent[1]?.clientContent as JsonObject;
  assertEquals((content.turns as JsonObject[]).length, 1);
});
