import { assertEquals, assertExists, assertRejects } from '@std/assert';
import { TheorumError } from '../../../../src/guardrails/error.ts';
import type { GeminiTransport } from '../../../../src/providers/google/keys.ts';
import { openGoogleLiveSession } from '../../../../src/providers/google/live/session.ts';
import {
  createLiveQueue,
  readGeminiLiveErrorMessage,
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

  await assertRejects(() => openGoogleLiveSession(req, transport), TheorumError);
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

Deno.test('readGeminiLiveErrorMessage extracts error details', () => {
  assertEquals(readGeminiLiveErrorMessage({}), null);
  assertEquals(readGeminiLiveErrorMessage({ error: null }), null);
  assertEquals(
    readGeminiLiveErrorMessage({
      error: { message: 'Invalid payload', status: 'INVALID_ARGUMENT' },
    }),
    'INVALID_ARGUMENT: Invalid payload',
  );
  assertEquals(
    readGeminiLiveErrorMessage({
      error: { message: 'Quota exceeded' },
    }),
    'Quota exceeded',
  );
  assertEquals(
    readGeminiLiveErrorMessage({
      error: { status: 'UNKNOWN' },
    }),
    'Gemini returned an error during live session.',
  );
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
  });
  const item1 = await queue.next();
  assertEquals(item1?.type, 'batch');

  const pendingNext = queue.next();
  queue.push({ type: 'closed' });
  const item2 = await pendingNext;
  assertEquals(item2?.type, 'closed');

  queue.close();
  assertEquals(queue.isClosed(), true);
  const itemAfterClose = await queue.next();
  assertEquals(itemAfterClose, undefined);
  assertExists(queue);
});

Deno.test('turnPhaseFromMessage: interactionStatus is authoritative over turnComplete', () => {
  assertEquals(turnPhaseFromMessage({ serverContent: { turnComplete: true } }, []), 'complete');
  assertEquals(
    turnPhaseFromMessage({ serverContent: { modelTurn: { parts: [] } } }, []),
    'streaming',
  );
  assertEquals(
    turnPhaseFromMessage(
      { serverContent: { turnComplete: true }, interactionStatus: 'IN_PROGRESS' },
      [],
    ),
    'streaming',
  );
  assertEquals(turnPhaseFromMessage({ interactionStatus: 'IDLE' }, []), 'complete');
  assertEquals(turnPhaseFromMessage({ interaction_status: 'IDLE' }, []), 'complete');
  assertEquals(
    turnPhaseFromMessage({ serverContent: { interrupted: true }, interactionStatus: 'IDLE' }, [
      { type: 'done', interrupted: true, stop: { kind: 'interrupted' } },
    ]),
    'abort',
  );
});
