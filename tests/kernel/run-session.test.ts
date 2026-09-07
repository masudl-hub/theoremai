import { assertEquals, assertRejects } from '@std/assert';
import { TheorumError } from '../../src/guardrails/error.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import { resetTools } from '../../src/kernel/tools/mod.ts';

function registerLiveProfile(id: string) {
  const profile = defineProfile({
    type: 'live',
    id,
    identity: { handle: 'live', system: 'hi' },
    model: {
      protocol: 'geminiLive',
      provider: 'google',
      allow: ['gemini31FlashLive'],
      thinking: 'none',
      config: {
        gemini31FlashLive: {
          apiId: 'gemini-3.1-flash-live-preview',
          thinking: { on: 'none', off: 'none' },
          thinkingLevels: ['none'],
          summaries: { on: 'none', off: 'none' },
          builtInTools: [],
          key: 'slotA',
        },
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
    model: {
      protocol: 'geminiInteractions',
      provider: 'google',
      allow: ['m'],
      thinking: 'none',
      config: {
        m: {
          apiId: 'gemini-test',
          thinking: { on: 'none', off: 'none' },
          thinkingLevels: ['none'],
          summaries: { on: 'none', off: 'none' },
          builtInTools: [],
          key: 'slotA',
        },
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
