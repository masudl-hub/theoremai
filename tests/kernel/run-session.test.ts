import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { TheorumError } from '../../src/guardrails/error.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import { resetTools } from '../../src/kernel/tools/mod.ts';

import { HOST_BINDINGS } from '../fixtures/models.ts';

function registerLiveProfile(id: string) {
  const profile = defineProfile({
    type: 'live',
    id,
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede' },
    tools: { allow: [] },
  });
  registerProfile(profile);
  return profile;
}

/** Minimal WebSocket stand-in that completes Live setup and accepts scripted upstream frames. */
class MockLiveWebSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
    if (data.includes('"setup"')) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ setupComplete: true }) }),
        );
      });
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.dispatchEvent(new Event('open'));
  }

  deliver(payload: unknown): void {
    const data = JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

Deno.test('runSession rejects non-live profiles', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'text',
    id: 'session_reject_text',
    identity: { handle: 't' },
    models: {
      m: {
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: 'gemini-test',
        efforts: { normal: 'none' },
        summaries: false,
        builtInTools: [],
        key: 'slotA',
      },
    },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: {},
  });
  registerProfile(profile);

  await assertRejects(
    () =>
      runSession(
        { profile: profile.id },
        { gemini: { vault: { slotA: 'k', slotB: undefined, slotC: undefined, paid: undefined } } },
      ),
    TheorumError,
    "runSession requires profile.type 'live'",
  );
});

Deno.test('runSession requires registered live profile with gemini vault', async () => {
  clearProfiles();
  resetTools();
  const profile = registerLiveProfile('session_live_missing_key');

  await assertRejects(
    () =>
      runSession(
        { profile: profile.id },
        {
          gemini: {
            vault: { slotA: undefined, slotB: undefined, slotC: undefined, paid: undefined },
          },
        },
      ),
    TheorumError,
  );
  assertEquals(profile.type, 'live');
});

Deno.test('runSession sendVideo rejects when live.ingress.video is disabled', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_no_video',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { video: false } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => {
        mock = new MockLiveWebSocket();
        setTimeout(() => mock?.open(), 0);
        return Promise.resolve(mock as unknown as WebSocket);
      },
    },
  );

  await new Promise((r) => setTimeout(r, 0));

  assertThrows(
    () => session.sendVideo({ data: 'abc', mimeType: 'image/jpeg' }),
    TheorumError,
    'live.ingress.video is disabled',
  );
  (mock as unknown as MockLiveWebSocket)?.close();
  await session.close();
});

Deno.test('runSession sendText rejects when live.ingress.text is disabled', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_no_text',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: false } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => {
        mock = new MockLiveWebSocket();
        setTimeout(() => mock?.open(), 0);
        return Promise.resolve(mock as unknown as WebSocket);
      },
    },
  );

  await new Promise((r) => setTimeout(r, 0));

  assertThrows(() => session.sendText('hello'), TheorumError, 'live.ingress.text is disabled');
  (mock as unknown as MockLiveWebSocket)?.close();
  await session.close();
});

Deno.test('runSession sendText frames sanitized realtime input when text ingress enabled', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_text',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [] },
    guardrails: { sanitizeInput: true, redactSensitive: true },
  });
  registerProfile(profile);

  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => {
        mock = new MockLiveWebSocket();
        setTimeout(() => mock?.open(), 0);
        return Promise.resolve(mock as unknown as WebSocket);
      },
    },
  );

  await new Promise((r) => setTimeout(r, 0));

  session.sendText('hello concierge');
  const liveMock = mock as unknown as MockLiveWebSocket;
  const textFrame = liveMock.sent.find((frame) => frame.includes('"realtimeInput"'));
  assertEquals(textFrame !== undefined, true);
  const parsed = JSON.parse(textFrame ?? '{}') as {
    realtimeInput?: { text?: string };
  };
  assertEquals(parsed.realtimeInput?.text?.includes('<user_data>'), true);
  assertEquals(parsed.realtimeInput?.text?.includes('hello concierge'), true);

  liveMock.close();
  await session.close();
});

Deno.test('runSession abort phase still forwards tool events', async () => {
  clearProfiles();
  resetTools();
  const profile = registerLiveProfile('session_live_abort_tools');

  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => {
        mock = new MockLiveWebSocket();
        // Macrotask so performLiveSetup can attach onopen/message before open fires.
        setTimeout(() => mock?.open(), 0);
        return Promise.resolve(mock as unknown as WebSocket);
      },
    },
  );

  assertEquals(mock !== null, true);
  const liveMock = mock as unknown as MockLiveWebSocket;

  const collected: Array<{ type: string; name?: string; interrupted?: boolean }> = [];
  const drain = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'tool') {
        collected.push({ type: 'tool', name: event.tool?.name });
      } else if (event.type === 'done') {
        collected.push({ type: 'done', interrupted: event.interrupted === true });
      }
      if (event.type === 'done' && event.interrupted) break;
    }
  })();

  // After setup, inject toolCall + barge-in in one upstream frame (abort turnPhase).
  await new Promise((r) => setTimeout(r, 0));
  liveMock.deliver({
    toolCall: {
      functionCalls: [{ id: 'call_1', name: 'navigate', args: { path: '/#use' } }],
    },
    serverContent: { interrupted: true },
  });
  // onmessage handler is async — let the batch enqueue before socket close.
  await new Promise((r) => setTimeout(r, 0));
  liveMock.close();

  await drain;
  await session.close();

  assertEquals(
    collected.some((e) => e.type === 'tool' && e.name === 'navigate'),
    true,
  );
  assertEquals(
    collected.some((e) => e.type === 'done' && e.interrupted === true),
    true,
  );
});
