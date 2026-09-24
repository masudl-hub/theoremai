import { assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import { runSession } from '../../src/kernel/engine/session/mod.ts';
import {
  clearProfiles,
  defineProfile,
  registerProfile,
} from '../../src/kernel/registry/profiles.ts';
import { prepareTurnToolSnapshot, registerTool, resetTools } from '../../src/kernel/tools/mod.ts';

import { MockLiveWebSocket } from '../fixtures/live-socket.ts';
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
    TheoremError,
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
    TheoremError,
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

  await assertRejects(
    () => session.sendVideo({ data: 'abc', mimeType: 'image/jpeg' }),
    TheoremError,
    'live.ingress.video is disabled',
  );
  (mock as unknown as MockLiveWebSocket)?.close();
  await session.close();
});

Deno.test('runSession sends setup on an already-open socket (fetch upgrade)', async () => {
  clearProfiles();
  resetTools();
  const profile = registerLiveProfile('session_live_preopened');

  const mock = new MockLiveWebSocket();
  mock.readyState = 1;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: {
        vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined },
      },
      openWebSocket: () => Promise.resolve(mock as unknown as WebSocket),
    },
  );

  assertEquals(mock.sent.filter((frame) => frame.includes('"setup"')).length, 1);
  mock.close();
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

  await assertRejects(
    () => session.sendText('hello'),
    TheoremError,
    'live.ingress.text is disabled',
  );
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

  await session.sendText('hello concierge');
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
    TheoremError,
    'outside tools.allow: snap_t1, snap_t2',
  );
});

Deno.test('runSession emits pre_turn before first sendText and post_turn after cycle done', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_stages',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  const stages: string[] = [];
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage }) => {
        stages.push(stage);
      },
    },
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

  const eventsPromise = (async () => {
    const out = [];
    for await (const ev of session.events()) {
      out.push(ev);
      if (stages.includes('post_turn')) break;
    }
    return out;
  })();

  await session.sendText('open cycle');
  assertEquals(stages.includes('pre_turn'), true);

  const liveMock = mock as unknown as MockLiveWebSocket;
  liveMock.deliver({
    serverContent: { turnComplete: true },
  });

  const events = await eventsPromise;
  assertEquals(
    events.some((e) => e.type === 'stage' && e.stage === 'pre_turn'),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
  assertEquals(stages, ['pre_turn', 'before_end', 'post_turn']);

  liveMock.close();
  await session.close();
});

Deno.test('runSession StageContext.history seeds from SessionRequest.history', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_history_seed',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  let seenSeed = false;
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      history: [{ role: 'user', content: 'seeded prior' }],
      onStage: ({ stage, history }) => {
        if (stage === 'pre_turn') {
          seenSeed = history.some((m) => m.role === 'user' && m.content === 'seeded prior');
        }
      },
    },
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
  const drain = (async () => {
    for await (const ev of session.events()) {
      if (ev.type === 'done') break;
    }
  })();
  await session.sendText('hello');
  assertEquals(seenSeed, true);
  (mock as unknown as MockLiveWebSocket).deliver({ serverContent: { turnComplete: true } });
  await drain;
  await session.close();
});

Deno.test('runSession executeTool sends the guarded text a turn sends, never the raw output', async () => {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'function',
    name: 'live_lookup_ssn',
    description: 'returns a record',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string(), ssn: z.string() }),
    handler: () => ({ finding: 'found the record', ssn: '123-45-6789' }),
  });
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_guarded_tool',
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: ['live_lookup_ssn'] },
  });
  registerProfile(profile);
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    { profile: profile.id },
    {
      gemini: { vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined } },
      openWebSocket: () => {
        mock = new MockLiveWebSocket();
        setTimeout(() => mock?.open(), 0);
        return Promise.resolve(mock as unknown as WebSocket);
      },
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  const drain = (async () => {
    for await (const _ev of session.events()) {
      /* keep pump alive */
    }
  })();

  const settled = await session.executeTool({ name: 'live_lookup_ssn', callId: 'c1', input: {} });
  const frame = (mock as unknown as MockLiveWebSocket).sent.find((s) => s.includes('toolResponse'));
  const response = JSON.parse(frame ?? 'null')?.toolResponse?.functionResponses?.[0]?.response;
  assertEquals(response, { result: settled.outputModel?.modelText });
  assertEquals(String(response?.result).startsWith('found the record\n'), true);
  assertEquals(String(response?.result).includes('123-45-6789'), false);

  (mock as unknown as MockLiveWebSocket).close();
  await session.close();
  await drain.catch(() => undefined);
});

Deno.test('runSession executeTool gates, resumes granted, and denies via granted false', async () => {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'function',
    name: 'live_confirm_tool',
    description: 'needs confirm',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    // Host onStage pre_tool runs after catalog permission; use preTool confirm for gate.
    preTool: () => ({ confirm: { summary: 'confirm live tool' } }),
    handler: () => ({ ok: true }),
  });
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_execute_tool',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: ['live_confirm_tool'] },
  });
  registerProfile(profile);

  const stages: string[] = [];
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage }) => {
        stages.push(stage);
      },
    },
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
  const drain = (async () => {
    for await (const _ev of session.events()) {
      /* keep pump alive */
    }
  })();

  const gated = await session.executeTool({
    name: 'live_confirm_tool',
    callId: 'c-gate',
    input: {},
  });
  assertEquals(gated.gated?.kind, 'confirmation');
  assertEquals(stages.includes('pre_tool'), true);
  const sentAfterGate = (mock as unknown as MockLiveWebSocket).sent.filter((s) =>
    s.includes('toolResponse'),
  );
  assertEquals(sentAfterGate.length, 0);

  stages.length = 0;
  const allowed = await session.executeTool({
    name: 'live_confirm_tool',
    callId: 'c-ok',
    input: {},
    resume: { granted: true },
  });
  assertEquals(allowed.failure, undefined);
  assertEquals(allowed.gated, undefined);
  assertEquals(stages.includes('post_tool'), true);
  const sentAfterOk = (mock as unknown as MockLiveWebSocket).sent.filter(
    (s) => s.includes('toolResponse') || s.includes('functionResponse'),
  );
  assertEquals(sentAfterOk.length > 0, true);

  stages.length = 0;
  const gated2 = await session.executeTool({
    name: 'live_confirm_tool',
    callId: 'c-deny',
    input: {},
  });
  assertEquals(Boolean(gated2.gated), true);
  const denied = await session.executeTool({
    name: 'live_confirm_tool',
    callId: 'c-deny',
    input: {},
    resume: { granted: false },
  });
  assertEquals(denied.failure?.code, 'denied');
  assertEquals(denied.failure?.kind, 'declined');
  assertEquals(stages.includes('post_tool'), true);

  (mock as unknown as MockLiveWebSocket).close();
  await session.close();
  await drain.catch(() => undefined);
});

Deno.test('runSession pre_turn inject schedules realtime text and lands in later history', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_inject',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  let beforeEndSawInject = false;
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage, history }) => {
        if (stage === 'pre_turn') {
          return { inject: [{ role: 'user', content: 'injected steer' }] };
        }
        if (stage === 'before_end') {
          beforeEndSawInject = history.some(
            (m) =>
              m.role === 'user' &&
              typeof m.content === 'string' &&
              m.content.includes('injected steer'),
          );
        }
      },
    },
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
  const eventsPromise = (async () => {
    for await (const ev of session.events()) {
      if (ev.type === 'done' && beforeEndSawInject) break;
    }
  })();

  await session.sendText('user open');
  const liveMock = mock as unknown as MockLiveWebSocket;
  const injectedWire = liveMock.sent.some((s) => s.includes('injected steer'));
  assertEquals(injectedWire, true);
  liveMock.deliver({ serverContent: { turnComplete: true } });
  await eventsPromise;
  assertEquals(beforeEndSawInject, true);
  await session.close();
});

Deno.test('runSession before_end inject schedules realtime text and still emits done/post_turn', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_before_end_inject',
    identity: { handle: 'live', system: 'hi' },
    models: {
      gemini31FlashLive: {
        ...HOST_BINDINGS.gemini31FlashLive,
        key: 'slotA',
      },
    },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow: [] },
  });
  registerProfile(profile);

  const stages: string[] = [];
  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage }) => {
        stages.push(stage);
        if (stage === 'before_end') {
          return { inject: [{ role: 'user', content: 'before-end steer' }] };
        }
      },
    },
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
  const eventsPromise = (async () => {
    const out = [];
    for await (const ev of session.events()) {
      out.push(ev);
      if (stages.includes('post_turn')) break;
    }
    return out;
  })();

  await session.sendText('open');
  const liveMock = mock as unknown as MockLiveWebSocket;
  liveMock.deliver({ serverContent: { turnComplete: true } });
  const events = await eventsPromise;
  assertEquals(stages, ['pre_turn', 'before_end', 'post_turn']);
  assertEquals(
    events.some((e) => e.type === 'done'),
    true,
  );
  assertEquals(
    liveMock.sent.some((s) => s.includes('before-end steer')),
    true,
  );

  liveMock.close();
  await session.close();
});
