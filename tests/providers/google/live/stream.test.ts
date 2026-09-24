import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { TheoremError } from '../../../../src/guardrails/error.ts';
import type { GeminiTransport } from '../../../../src/providers/google/keys.ts';
import { openGoogleLiveSession } from '../../../../src/providers/google/live/session.ts';
import {
  attachLiveSessionHandlers,
  createLiveQueue,
  performLiveSetup,
  readMessageData,
  sendInitialPayloads,
  turnPhaseFromMessage,
} from '../../../../src/providers/google/live/stream.ts';
import { stubCompleteRequest } from '../../../fixtures/provider-request.ts';

Deno.test('openGoogleLiveSession rejects when API key is missing', async () => {
  const transport: GeminiTransport = {
    vault: { slotA: undefined, slotB: undefined, slotC: undefined, paid: undefined },
  };
  const req = stubCompleteRequest({
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    keySlot: 'slotA',
  });

  await assertRejects(() => openGoogleLiveSession(req, transport), TheoremError);
});

Deno.test('openGoogleLiveSession rejects when pre-aborted', async () => {
  const transport: GeminiTransport = {
    vault: { slotA: 'valid-mock-key', slotB: undefined, slotC: undefined, paid: undefined },
  };
  const controller = new AbortController();
  controller.abort();

  const req = stubCompleteRequest({
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    keySlot: 'slotA',
    signal: controller.signal,
  });

  // Aborted before WebSocket open — setup fails or abort surfaces.
  await assertRejects(() => openGoogleLiveSession(req, transport));
});

Deno.test('readMessageData handles strings, ArrayBuffers, and Blobs', async () => {
  const str = await readMessageData('hello');
  assertEquals(str, 'hello');

  const buf = new TextEncoder().encode('buffer text').buffer;
  const fromBuf = await readMessageData(buf);
  assertEquals(fromBuf, 'buffer text');

  const blob = new Blob(['blob text']);
  const fromBlob = await readMessageData(blob);
  assertEquals(fromBlob, 'blob text');

  const fromNumber = await readMessageData(12345);
  assertEquals(fromNumber, '12345');
});

Deno.test('sendInitialPayloads sends history and input payloads over websocket', () => {
  const sent: string[] = [];
  const mockWs = {
    send: (payload: string) => sent.push(payload),
  };

  const req = stubCompleteRequest({
    history: [{ role: 'user', content: 'hello' }],
    input: [{ type: 'text', text: 'live input' }],
  });

  sendInitialPayloads(mockWs, req);
  assertEquals(sent.length, 2);
  assertEquals(sent[0]?.includes('clientContent'), true);
  assertEquals(sent[1]?.includes('realtimeInput'), true);
});

Deno.test('createLiveQueue queues session batches and resolves async next', async () => {
  const queue = createLiveQueue();
  assertEquals(queue.isClosed(), false);

  queue.push({
    type: 'batch',
    events: [{ type: 'text', text: 'hi' }],
    turnPhase: 'streaming',
    row: { serverContent: { modelTurn: { parts: [{ text: 'hi' }] } } },
  });
  const item1 = await queue.next();
  assertEquals(item1?.type, 'batch');

  const pendingNext = queue.next();
  queue.push({ type: 'closed', code: 1000, reason: '' });
  const item2 = await pendingNext;
  assertEquals(item2?.type, 'closed');

  queue.close();
  assertEquals(queue.isClosed(), true);
  const itemAfterClose = await queue.next();
  assertEquals(itemAfterClose, undefined);
  assertExists(queue);
});

Deno.test('turnPhaseFromMessage: serverContent.interactionStatus is authoritative over turnComplete', () => {
  assertEquals(turnPhaseFromMessage({ serverContent: { turnComplete: true } }, []), 'complete');
  assertEquals(
    turnPhaseFromMessage({ serverContent: { modelTurn: { parts: [] } } }, []),
    'streaming',
  );
  // gemini-3.8-live-extended-thinking (probe 23/09/2026): a tool flow sends
  // turnComplete + IN_PROGRESS before the tool call, then turnComplete + IDLE.
  assertEquals(
    turnPhaseFromMessage(
      { serverContent: { turnComplete: true, interactionStatus: 'IN_PROGRESS' } },
      [],
    ),
    'streaming',
  );
  assertEquals(
    turnPhaseFromMessage({ serverContent: { turnComplete: true, interactionStatus: 'IDLE' } }, []),
    'complete',
  );
  // Only serverContent carries it; a top-level field is not the wire shape.
  assertEquals(
    turnPhaseFromMessage(
      { serverContent: { turnComplete: true }, interactionStatus: 'IN_PROGRESS' },
      [],
    ),
    'complete',
  );
  assertEquals(
    turnPhaseFromMessage({ serverContent: { interrupted: true, interactionStatus: 'IDLE' } }, [
      { type: 'done', interrupted: true, stop: { kind: 'interrupted' } },
    ]),
    'abort',
  );
});

Deno.test('turnPhaseFromMessage: an empty frame keeps the turn streaming', () => {
  // gemini-3.8-live sends bare `{}` frames mid-turn (probe 23/09/2026).
  assertEquals(turnPhaseFromMessage({}, []), 'streaming');
});

/** A socket that stays connecting until the test fires its handlers. */
class FakeLiveSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function liveRequest() {
  return stubCompleteRequest({
    model: 'gemini-3.1-flash-live-preview',
    apiId: 'gemini-3.1-flash-live-preview',
    keySlot: 'slotA',
  });
}

async function setupFailure(fire: (ws: FakeLiveSocket) => void): Promise<TheoremError> {
  const ws = new FakeLiveSocket();
  const setup = performLiveSetup(ws as unknown as WebSocket, liveRequest());
  fire(ws);
  const err = await setup.catch((e: unknown) => e);
  if (!(err instanceof TheoremError)) throw new Error('expected a TheoremError');
  return err;
}

Deno.test('Live setup failures carry the kind of their close code', async () => {
  for (const [code, kind] of [
    [1006, 'network'],
    [1007, 'unsupported'],
    [1008, 'unsupported'],
    [1011, 'unavailable'],
    [1013, 'unavailable'],
    [1000, 'unavailable'],
  ] as const) {
    const err = await setupFailure((ws) => ws.onclose?.({ code, reason: 'closed' }));
    assertEquals(err.kind, kind);
  }
});

Deno.test('Live setup: a socket error is network, an error frame is its status kind', async () => {
  assertEquals((await setupFailure((ws) => ws.onerror?.())).kind, 'network');
  const denied = await setupFailure((ws) =>
    ws.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ error: { code: 403, message: 'key rejected' } }),
      }),
    ),
  );
  assertEquals(denied.kind, 'auth');
  const garbled = await setupFailure((ws) =>
    ws.dispatchEvent(new MessageEvent('message', { data: '{not json' })),
  );
  assertEquals(garbled.kind, 'bad_response');
});

Deno.test('Live session closes: normal carries no error, abnormal carries its kind', async () => {
  for (const [code, kind] of [
    [1000, undefined],
    [1006, 'network'],
    [1008, 'unsupported'],
    [1011, 'unavailable'],
    [4000, 'unavailable'],
  ] as const) {
    const ws = new FakeLiveSocket();
    const queue = createLiveQueue();
    attachLiveSessionHandlers(ws as unknown as WebSocket, queue);
    ws.onclose?.({ code, reason: 'closed' });
    const item = await queue.next();
    assertEquals(item?.type === 'closed' ? item.error?.kind : 'not closed', kind);
  }
});
