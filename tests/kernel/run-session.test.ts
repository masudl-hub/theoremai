import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheorumError } from '../../src/guardrails/error.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import { prepareTurnToolSnapshot, registerTool, resetTools } from '../../src/kernel/tools/mod.ts';

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

Deno.test('runSession setup declarations equal the full allow list regardless of loadTier', async () => {
  clearProfiles();
  resetTools();
  for (const [name, loadTier] of [
    ['session_t0', 'T0'],
    ['session_t1', 'T1'],
    ['session_t2', 'T2'],
  ] as const) {
    registerTool({
      type: 'function',
      name,
      description: `${loadTier} tool`,
      category: 'test',
      access: 'read-only',
      paths: ['*'],
      loadTier,
      permission: 'auto',
      input: z.object({}),
      output: z.object({ finding: z.string() }),
      handler: () => ({ finding: 'ok' }),
    });
  }
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_all_tiers',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede' },
    tools: { allow: ['session_t0', 'session_t1', 'session_t2'] },
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

  const liveMock = mock as unknown as MockLiveWebSocket;
  const setupFrame = liveMock.sent.find((frame) => frame.includes('"setup"'));
  const parsed = JSON.parse(setupFrame ?? '{}') as {
    setup?: { tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> };
  };
  const declared = (parsed.setup?.tools ?? []).flatMap((t) =>
    (t.functionDeclarations ?? []).map((d) => d.name),
  );
  assertEquals(declared, ['session_t0', 'session_t1', 'session_t2']);

  liveMock.close();
  await session.close();
});

function registerTieredSessionTools(): void {
  for (const [name, loadTier] of [
    ['snap_t0', 'T0'],
    ['snap_t1', 'T1'],
    ['snap_t2', 'T2'],
  ] as const) {
    registerTool({
      type: 'function',
      name,
      description: `${loadTier} tool`,
      category: 'test',
      access: 'read-only',
      paths: ['live-call'],
      loadTier,
      permission: 'auto',
      input: z.object({}),
      output: z.object({ finding: z.string() }),
      handler: () => ({ finding: 'ok' }),
    });
  }
}

function defineSnapshotLiveProfile(id: string, allow: string[]) {
  return defineProfile({
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
    tools: { allow },
  });
}

async function openWithMock(req: Parameters<typeof runSession>[0]) {
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(req, {
    gemini: {
      vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
    },
    openWebSocket: () => {
      mock = new MockLiveWebSocket();
      setTimeout(() => mock?.open(), 0);
      return Promise.resolve(mock as unknown as WebSocket);
    },
  });
  return { session, mock: mock as unknown as MockLiveWebSocket };
}

function declaredToolNames(mock: MockLiveWebSocket): string[] {
  const setupFrame = mock.sent.find((frame) => frame.includes('"setup"'));
  const parsed = JSON.parse(setupFrame ?? '{}') as {
    setup?: { tools?: Array<{ functionDeclarations?: Array<{ name: string }> }> };
  };
  return (parsed.setup?.tools ?? []).flatMap((t) =>
    (t.functionDeclarations ?? []).map((d) => d.name),
  );
}

Deno.test('runSession declares a host-supplied snapshot when the registry is not local', async () => {
  clearProfiles();
  resetTools();
  registerTieredSessionTools();
  const allow = ['snap_t0', 'snap_t1', 'snap_t2'];
  const profile = defineSnapshotLiveProfile('session_snapshot_remote', allow);
  registerProfile(profile);

  // The registry-owning process resolves the snapshot …
  const snapshot = await prepareTurnToolSnapshot(
    profile,
    { profile: profile.id, path: 'live-call', input: { text: '' } },
    'gemini31FlashLive',
  );
  assertEquals(
    snapshot.wire.map((w) => w.name),
    allow,
  );

  // … and the relay process has the profile but not the tools.
  resetTools();
  const { session, mock } = await openWithMock({
    profile: profile.id,
    path: 'live-call',
    snapshot,
  });
  assertEquals(declaredToolNames(mock), allow);
  const setupFrame = mock.sent.find((frame) => frame.includes('"setup"')) ?? '';
  assertEquals(setupFrame.includes('"T1 tool"'), true);

  mock.close();
  await session.close();
});

Deno.test('runSession without a snapshot declares nothing when the registry is not local', async () => {
  clearProfiles();
  resetTools();
  const profile = defineSnapshotLiveProfile('session_snapshot_missing', ['snap_t0']);
  registerProfile(profile);

  const { session, mock } = await openWithMock({ profile: profile.id, path: 'live-call' });
  assertEquals(declaredToolNames(mock), []);

  mock.close();
  await session.close();
});

Deno.test('runSession refuses a snapshot that declares tools outside tools.allow', async () => {
  clearProfiles();
  resetTools();
  registerTieredSessionTools();
  const wide = defineSnapshotLiveProfile('session_snapshot_wide', [
    'snap_t0',
    'snap_t1',
    'snap_t2',
  ]);
  registerProfile(wide);
  const snapshot = await prepareTurnToolSnapshot(
    wide,
    { profile: wide.id, path: 'live-call', input: { text: '' } },
    'gemini31FlashLive',
  );

  const narrow = defineSnapshotLiveProfile('session_snapshot_narrow', ['snap_t0']);
  registerProfile(narrow);

  await assertRejects(
    () => openWithMock({ profile: narrow.id, path: 'live-call', snapshot }),
    TheorumError,
    'outside tools.allow: snap_t1, snap_t2',
  );
});
