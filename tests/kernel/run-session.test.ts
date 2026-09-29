import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { z } from 'zod';
import { TheoremError } from '../../src/guardrails/error.ts';
import type { ResolveHost } from '../../src/guardrails/network.ts';
import {
  clearProfiles,
  invokeTool,
  registerProfile,
  registerTool,
  resetTools,
  runSession,
} from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import type { StageHandler } from '../../src/kernel/stages.ts';
import { prepareTurnToolSnapshot } from '../../src/kernel/tools/mod.ts';
import type { InvokeToolResume } from '../../src/kernel/tools/types.ts';
import type { TurnEvent } from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
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
    defaultKernelScope.tools,
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
    defaultKernelScope.tools,
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

/** A live session over a mock socket whose events are collected as they arrive. */
async function openToolSession(
  allow: string[],
  extra: { onStage?: StageHandler; gateTtlMs?: number; resolveHost?: ResolveHost } = {},
) {
  const profile = defineProfile({
    type: 'live',
    id: `session_live_tools_${allow.join('_')}`,
    identity: { handle: 'live', system: 'hi' },
    models: { gemini31FlashLive: { ...HOST_BINDINGS.gemini31FlashLive, key: 'slotA' } },
    live: { voice: 'Aoede', ingress: { text: true } },
    tools: { allow },
  });
  registerProfile(profile);
  const sockets: MockLiveWebSocket[] = [];
  const session = await runSession(
    {
      profile: profile.id,
      ...(extra.onStage ? { onStage: extra.onStage } : {}),
      ...(extra.resolveHost ? { resolveHost: extra.resolveHost } : {}),
    },
    {
      gemini: { vault: { slotA: 'test-key', slotB: undefined, slotC: undefined, paid: undefined } },
      openWebSocket: () => {
        const socket = new MockLiveWebSocket();
        sockets.push(socket);
        setTimeout(() => socket.open(), 0);
        return Promise.resolve(socket as unknown as WebSocket);
      },
      ...(extra.gateTtlMs !== undefined ? { gateTtlMs: extra.gateTtlMs } : {}),
    },
  );
  const [mock] = sockets;
  if (!mock) throw new Error('no socket opened');
  const events: TurnEvent[] = [];
  const drain = (async () => {
    for await (const ev of session.events()) events.push(ev);
  })();
  const toolResponses = () =>
    mock.sent.flatMap((frame): { id: string; name: string; response: unknown }[] => {
      const parsed = JSON.parse(frame);
      return parsed?.toolResponse?.functionResponses ?? [];
    });
  /** The model calls tools; resolves once the session has held them. */
  const modelCalls = async (...calls: { id: string; name: string; args?: unknown }[]) => {
    mock.deliver({
      toolCall: { functionCalls: calls.map((c) => ({ args: {}, ...c })) },
    });
    for (let i = 0; i < 20; i += 1) {
      const seen = calls.every((c) =>
        events.some((ev) => ev.type === 'tool' && ev.tool.callId === c.id),
      );
      if (seen) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('the session never surfaced the calls');
  };
  const close = async () => {
    mock.close();
    await session.close();
    await drain.catch(() => undefined);
  };
  /** The events the registry process's `invokeTool` yields for one of the model's calls. */
  const invokeFor = async (name: string, callId: string, resume?: InvokeToolResume) => {
    const ran: TurnEvent[] = [];
    for await (const ev of invokeTool({
      profile: profile.id,
      name,
      callId,
      input: {},
      ...(resume ? { resume } : {}),
    })) {
      ran.push(ev);
    }
    return ran;
  };
  return { session, mock, events, toolResponses, modelCalls, invokeFor, close };
}

function registerConfirmTool(): void {
  registerTool({
    type: 'function',
    name: 'live_confirm_tool',
    description: 'needs confirm',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ n: z.number().optional() }),
    output: z.object({ n: z.number() }),
    preTool: () => ({ confirm: { summary: 'confirm live tool' } }),
    handler: ({ n }) => ({ n: n ?? 0 }),
  });
}

function registerLookupTool(): void {
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
}

Deno.test('runSession executeTool sends the guarded text a turn sends, never the raw output', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await h.modelCalls({ id: 'c1', name: 'live_lookup_ssn' });

  const settled = await h.session.executeTool({ callId: 'c1' });
  const [answer] = h.toolResponses();
  assertEquals(answer?.response, { result: settled.outputModel?.modelText });
  assertEquals(String(settled.outputModel?.modelText).startsWith('found the record\n'), true);
  assertEquals(String(settled.outputModel?.modelText).includes('123-45-6789'), false);
  await h.close();
});

Deno.test('runSession executeTool runs only a call the model made, once, with its arguments', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await assertRejects(() => h.session.executeTool({ callId: 'never-made' }), TheoremError);

  await h.modelCalls({ id: 'c1', name: 'live_lookup_ssn' });
  await assertRejects(
    () => h.session.executeTool({ callId: 'c1', decision: 'approve' }),
    TheoremError,
    'not waiting on a gate',
  );
  await assertRejects(
    () => h.session.executeTool({ callId: 'c1', input: {} }),
    TheoremError,
    'not waiting on a gate',
  );
  await h.session.executeTool({ callId: 'c1' });
  await assertRejects(() => h.session.executeTool({ callId: 'c1' }), TheoremError, 'not waiting');
  assertEquals(h.toolResponses().length, 1);
  await h.close();
});

Deno.test('runSession records the text it sent the model as the call result in history', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  let history: readonly { role: string; content?: unknown }[] = [];
  const h = await openToolSession(['live_lookup_ssn'], {
    onStage: (ctx) => {
      if (ctx.stage === 'pre_turn') history = ctx.history;
    },
  });
  await h.modelCalls({ id: 'c1', name: 'live_lookup_ssn' });
  await h.session.executeTool({ callId: 'c1' });
  await h.session.sendText('and then?');
  const [answer] = h.toolResponses();
  const recorded = history.find((m) => m.role === 'tool');
  assertEquals({ result: recorded?.content }, answer?.response);
  await h.close();
});

Deno.test('runSession executeTool holds a gate for its decision, then runs the approval', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const stages: string[] = [];
  const h = await openToolSession(['live_confirm_tool'], {
    onStage: ({ stage }) => {
      stages.push(stage);
    },
  });
  await h.modelCalls({ id: 'c-gate', name: 'live_confirm_tool' });

  const gated = await h.session.executeTool({ callId: 'c-gate' });
  assertEquals(gated.gated?.kind, 'confirmation');
  assertEquals(stages.includes('pre_tool'), true);
  assertEquals(h.toolResponses().length, 0);
  await assertRejects(
    () => h.session.executeTool({ callId: 'c-gate' }),
    TheoremError,
    'answer it with a decision',
  );

  stages.length = 0;
  const allowed = await h.session.executeTool({ callId: 'c-gate', decision: 'approve' });
  assertEquals(allowed.failure, undefined);
  assertEquals(allowed.outputRaw, { n: 0 });
  assertEquals(stages.includes('post_tool'), true);
  assertEquals(
    h.toolResponses().map((r) => r.id),
    ['c-gate'],
  );
  await h.close();
});

Deno.test("runSession streams a call's gate and result to the host while the model waits", async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const h = await openToolSession(['live_confirm_tool']);
  await h.modelCalls({ id: 'c-wait', name: 'live_confirm_tool' });
  /** Resolves once the host has read `phase` for the call, with no frame from the model since. */
  const reached = async (phase: string) => {
    for (let i = 0; i < 20; i += 1) {
      if (
        h.events.some(
          (ev) => ev.type === 'tool' && ev.tool.callId === 'c-wait' && ev.tool.phase === phase,
        )
      )
        return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`the host never read the call's ${phase}`);
  };

  await h.session.executeTool({ callId: 'c-wait' });
  await reached('gate');
  await h.session.executeTool({ callId: 'c-wait', decision: 'approve' });
  await reached('complete');
  await h.close();
});

Deno.test('runSession executeTool runs an approval with the edited input, and only an approval takes one', async () => {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'function',
    name: 'live_always_confirm',
    description: 'asks every time',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: z.object({ n: z.number() }),
    output: z.object({ n: z.number() }),
    handler: ({ n }) => ({ n }),
  });
  const h = await openToolSession(['live_always_confirm']);
  await h.modelCalls({ id: 'c-edit', name: 'live_always_confirm', args: { n: 1 } });
  await h.session.executeTool({ callId: 'c-edit' });
  await assertRejects(
    () => h.session.executeTool({ callId: 'c-edit', decision: 'deny', input: { n: 2 } }),
    TheoremError,
    'only an approval takes edited input',
  );
  const edited = await h.session.executeTool({
    callId: 'c-edit',
    decision: 'approve',
    input: { n: 2 },
  });
  assertEquals(edited.outputRaw, { n: 2 });
  await h.close();
  const running = h.events.findLast(
    (ev) => ev.type === 'tool' && ev.tool.callId === 'c-edit' && ev.tool.phase === 'running',
  );
  assertEquals(
    running?.type === 'tool' && running.tool.phase === 'running' ? running.tool.edited : undefined,
    { from: { n: 1 }, to: { n: 2 } },
  );
});

Deno.test('runSession executeTool settles a denial: the model reads it', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const h = await openToolSession(['live_confirm_tool']);
  await h.modelCalls({ id: 'c-deny', name: 'live_confirm_tool' });
  await h.session.executeTool({ callId: 'c-deny' });
  const denied = await h.session.executeTool({ callId: 'c-deny', decision: 'deny' });
  assertEquals(denied.failure?.code, 'denied');
  assertEquals(denied.failure?.kind, 'declined');
  assertEquals(
    h.toolResponses().map((r) => r.id),
    ['c-deny'],
  );
  await h.close();
});

Deno.test('runSession settles an expired gate as abandoned, then refuses the decision', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const h = await openToolSession(['live_confirm_tool'], { gateTtlMs: 1 });
  await h.modelCalls({ id: 'c-late', name: 'live_confirm_tool' });
  await h.session.executeTool({ callId: 'c-late' });
  await new Promise((r) => setTimeout(r, 5));

  const refused = await assertRejects(
    () => h.session.executeTool({ callId: 'c-late', decision: 'approve' }),
    TheoremError,
  );
  assertEquals(refused.copy, { key: 'session.gate_expired' });
  assertEquals(
    h.toolResponses().map((r) => r.id),
    ['c-late'],
  );
  await assertRejects(() => h.session.executeTool({ callId: 'c-late' }), TheoremError);
  await h.close();
  const abandoned = h.events.find(
    (ev) => ev.type === 'tool' && ev.tool.callId === 'c-late' && ev.tool.phase === 'error',
  );
  assertEquals(
    abandoned?.type === 'tool' && abandoned.tool.phase === 'error'
      ? abandoned.tool.failure.kind
      : undefined,
    'cancelled',
  );
});

Deno.test('runSession refuses a gateTtlMs that is not a positive number', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  await assertRejects(
    () => openToolSession(['live_confirm_tool'], { gateTtlMs: 0 }),
    TheoremError,
    'runSession gateTtlMs',
  );
});

Deno.test('runSession keeps a session_consent approval for the rest of the session', async () => {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'function',
    name: 'live_consent_tool',
    description: 'asks once per session',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'session_consent',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
  const h = await openToolSession(['live_consent_tool']);
  await h.modelCalls({ id: 'c-first', name: 'live_consent_tool' });
  assertEquals((await h.session.executeTool({ callId: 'c-first' })).gated?.kind, 'permission');
  await h.session.executeTool({ callId: 'c-first', decision: 'approve' });

  await h.modelCalls({ id: 'c-second', name: 'live_consent_tool' });
  const second = await h.session.executeTool({ callId: 'c-second' });
  assertEquals(second.gated, undefined);
  assertEquals(second.outputRaw, { ok: true });
  await h.close();
});

Deno.test('runSession makes a key typed at a sign-in gate the slot credential, for the rest of the session', async () => {
  clearProfiles();
  resetTools();
  registerTool({
    type: 'http',
    name: 'live_tracker',
    description: 'Read tracker items',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    endpoint: 'https://api.tracker.example/items',
    method: 'GET',
    auth: { slot: 'tracker', type: 'bearer', onUnauthenticated: 'gate' },
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  });
  const original = globalThis.fetch;
  const sent: (string | null)[] = [];
  globalThis.fetch = (_input: Request | URL | string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(Response.json({ ok: true }));
  };
  try {
    const h = await openToolSession(['live_tracker'], {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
    });
    await h.modelCalls({ id: 'c-sign', name: 'live_tracker' });
    assertEquals((await h.session.executeTool({ callId: 'c-sign' })).gated?.kind, 'auth');
    await assertRejects(
      () => h.session.executeTool({ callId: 'c-sign', decision: 'deny', secret: 'k' }),
      TheoremError,
      'only an approval',
    );
    await assertRejects(
      () => h.session.executeTool({ callId: 'c-sign', decision: 'approve', secret: '  ' }),
      TheoremError,
      'non-empty',
    );
    const signed = await h.session.executeTool({
      callId: 'c-sign',
      decision: 'approve',
      secret: 'typed-key-123',
    });
    assertEquals(signed.outputRaw, { ok: true });

    await h.modelCalls({ id: 'c-again', name: 'live_tracker' });
    assertEquals((await h.session.executeTool({ callId: 'c-again' })).outputRaw, { ok: true });
    assertEquals(sent, ['Bearer typed-key-123', 'Bearer typed-key-123']);
    await h.close();
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('runSession answers a call a stage stopped, then ends the cycle cancelled', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const stages: string[] = [];
  const h = await openToolSession(['live_lookup_ssn'], {
    onStage: ({ stage }) => {
      stages.push(stage);
      return stage === 'pre_tool' ? { abort: { reason: 'host stopped it' } } : undefined;
    },
  });
  await h.session.sendText('look it up');
  await h.modelCalls({ id: 'c-stop', name: 'live_lookup_ssn' });

  const stopped = await h.session.executeTool({ callId: 'c-stop' });
  assertEquals(stopped.failure?.kind, 'cancelled');
  assertEquals(stopped.outputRaw, undefined);
  const [answer] = h.toolResponses();
  assertEquals(answer?.id, 'c-stop');
  assertStringIncludes(
    JSON.stringify(answer?.response),
    "'live_lookup_ssn' was stopped before it ran.",
  );
  assertEquals(stages.slice(-2), ['pre_tool', 'post_turn']);
  await assertRejects(
    () => h.session.executeTool({ callId: 'c-stop' }),
    TheoremError,
    'not waiting to run',
  );
  await h.close();

  const error = h.events.find((ev) => ev.type === 'tool' && ev.tool.phase === 'error');
  assertEquals(
    error?.type === 'tool' && error.tool.phase === 'error' ? error.tool.failure.kind : undefined,
    'cancelled',
  );
  const done = h.events.find((ev) => ev.type === 'done');
  assertEquals(done?.type === 'done' ? done.stop : undefined, {
    kind: 'cancelled',
    native: 'host stopped it',
  });
});

Deno.test('runSession answers a call stopped after it ran with its own result, then ends the cycle cancelled', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const stages: string[] = [];
  const h = await openToolSession(['live_lookup_ssn'], {
    onStage: ({ stage }) => {
      stages.push(stage);
      return stage === 'post_tool' ? { abort: true } : undefined;
    },
  });
  await h.session.sendText('look it up');
  await h.modelCalls({ id: 'c-ran', name: 'live_lookup_ssn' });

  const ran = await h.session.executeTool({ callId: 'c-ran' });
  assertEquals(ran.failure, undefined);
  const [answer] = h.toolResponses();
  assertEquals(answer?.id, 'c-ran');
  assertStringIncludes(JSON.stringify(answer?.response), 'found the record');
  assertEquals(stages.slice(-2), ['post_tool', 'post_turn']);
  await assertRejects(
    () => h.session.executeTool({ callId: 'c-ran' }),
    TheoremError,
    'not waiting to run',
  );
  await h.close();

  const done = h.events.find((ev) => ev.type === 'done');
  assertEquals(done?.type === 'done' ? done.stop : undefined, { kind: 'cancelled' });
});

Deno.test('runSession refuses a typed key on a gate that is not a sign-in', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const h = await openToolSession(['live_confirm_tool']);
  await h.modelCalls({ id: 'c-stray', name: 'live_confirm_tool' });
  await h.session.executeTool({ callId: 'c-stray' });
  await assertRejects(
    () => h.session.executeTool({ callId: 'c-stray', decision: 'approve', secret: 'stray' }),
    TheoremError,
    'answers only a sign-in gate',
  );
  const approved = await h.session.executeTool({ callId: 'c-stray', decision: 'approve' });
  assertEquals(approved.outputRaw, { n: 0 });
  await h.close();
});

Deno.test('runSession answers a malformed call itself: the model reads the failure', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await h.modelCalls({ id: 'c-bad', name: 'live_lookup_ssn', args: 'not an object' });
  const failed = h.events.find(
    (ev) => ev.type === 'tool' && ev.tool.callId === 'c-bad' && ev.tool.phase === 'error',
  );
  const readBack =
    failed?.type === 'tool' && failed.tool.phase === 'error' ? failed.tool.readBack : undefined;
  assertEquals(h.toolResponses(), [
    { id: 'c-bad', name: 'live_lookup_ssn', response: { result: readBack } },
  ]);
  await assertRejects(() => h.session.executeTool({ callId: 'c-bad' }), TheoremError);
  await h.close();
});

Deno.test('runSession lets go of a call the model cancels', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await h.modelCalls({ id: 'c-gone', name: 'live_lookup_ssn' });
  h.mock.deliver({ toolCallCancellation: { ids: ['c-gone'] } });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await assertRejects(() => h.session.executeTool({ callId: 'c-gone' }), TheoremError);
  assertEquals(h.toolResponses().length, 0);
  await h.close();
});

Deno.test('runSession answerToolCall settles a call another process ran, with its readBack', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await h.modelCalls({ id: 'c-split', name: 'live_lookup_ssn' });
  const ran = await h.invokeFor('live_lookup_ssn', 'c-split');
  const complete = ran.find((ev) => ev.type === 'tool' && ev.tool.phase === 'complete');
  const readBack =
    complete?.type === 'tool' && complete.tool.phase === 'complete'
      ? complete.tool.readBack
      : undefined;

  const answered = h.session.answerToolCall({ callId: 'c-split', events: ran });
  assertEquals(answered.outputRaw, { finding: 'found the record', ssn: '123-45-6789' });
  assertEquals(h.toolResponses(), [
    { id: 'c-split', name: 'live_lookup_ssn', response: { result: readBack } },
  ]);
  assertThrows(
    () => h.session.answerToolCall({ callId: 'c-split', events: ran }),
    TheoremError,
    'not waiting for an answer',
  );
  await h.close();
  assertEquals(
    h.events.some(
      (ev) => ev.type === 'tool' && ev.tool.callId === 'c-split' && ev.tool.phase === 'complete',
    ),
    true,
  );
});

Deno.test('runSession answerToolCall holds a gate open until a later run answers it', async () => {
  clearProfiles();
  resetTools();
  registerConfirmTool();
  const h = await openToolSession(['live_confirm_tool']);
  await h.modelCalls({ id: 'c-split-gate', name: 'live_confirm_tool' });

  const gatedRun = await h.invokeFor('live_confirm_tool', 'c-split-gate');
  const gated = h.session.answerToolCall({ callId: 'c-split-gate', events: gatedRun });
  assertEquals(gated.gated?.kind, 'confirmation');
  assertEquals(h.toolResponses().length, 0);

  const approvedRun = await h.invokeFor('live_confirm_tool', 'c-split-gate', { granted: true });
  const approved = h.session.answerToolCall({ callId: 'c-split-gate', events: approvedRun });
  assertEquals(approved.outputRaw, { n: 0 });
  assertEquals(
    h.toolResponses().map((r) => r.id),
    ['c-split-gate'],
  );
  await h.close();
});

Deno.test('runSession answerToolCall refuses a run that is not an answer to that call', async () => {
  clearProfiles();
  resetTools();
  registerLookupTool();
  const h = await openToolSession(['live_lookup_ssn']);
  await h.modelCalls({ id: 'c-a', name: 'live_lookup_ssn' });
  const other = await h.invokeFor('live_lookup_ssn', 'c-other');
  assertThrows(
    () => h.session.answerToolCall({ callId: 'c-a', events: other }),
    TheoremError,
    'carries a call of its own',
  );
  const own = await h.invokeFor('live_lookup_ssn', 'c-a');
  const unsettled = own.filter((ev) => !(ev.type === 'tool' && ev.tool.phase === 'complete'));
  assertThrows(
    () => h.session.answerToolCall({ callId: 'c-a', events: unsettled }),
    TheoremError,
    'settled nothing',
  );
  assertThrows(
    () => h.session.answerToolCall({ callId: 'never-made', events: own }),
    TheoremError,
    'not waiting for an answer',
  );
  assertEquals(h.toolResponses().length, 0);
  await h.close();
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
          return { inject: [{ role: 'user', content: 'injected steer' }], injectId: 'steer-live' };
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
    const out: TurnEvent[] = [];
    for await (const ev of session.events()) {
      out.push(ev);
      if (ev.type === 'done' && beforeEndSawInject) break;
    }
    return out;
  })();

  await session.sendText('user open');
  const liveMock = mock as unknown as MockLiveWebSocket;
  const injectedWire = liveMock.sent.some((s) => s.includes('injected steer'));
  assertEquals(injectedWire, true);
  liveMock.deliver({ serverContent: { turnComplete: true } });
  const events = await eventsPromise;
  assertEquals(beforeEndSawInject, true);
  assertEquals(
    eventsOf(events, 'stage').filter((e) => e.injected !== undefined),
    [{ type: 'stage', stage: 'pre_turn', injected: [{ id: 'steer-live' }] }],
  );
  await session.close();
});

Deno.test('runSession refuses an inject live cannot write as text, whole, and never reports it landed', async () => {
  clearProfiles();
  resetTools();
  const profile = defineProfile({
    type: 'live',
    id: 'session_live_inject_parts',
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

  let mock: MockLiveWebSocket | null = null;
  const session = await runSession(
    {
      profile: profile.id,
      onStage: ({ stage }) => {
        if (stage !== 'pre_turn') return undefined;
        return {
          inject: [
            { role: 'user', content: 'text half' },
            { role: 'user', content: 'see photo', parts: [{ type: 'text', text: 'see photo' }] },
          ],
          injectId: 'steer-photo',
        };
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
    const out: TurnEvent[] = [];
    for await (const ev of session.events()) {
      out.push(ev);
      if (ev.type === 'done') break;
    }
    return out;
  })();

  await session.sendText('open');
  const liveMock = mock as unknown as MockLiveWebSocket;
  liveMock.deliver({ serverContent: { turnComplete: true } });
  const events = await eventsPromise;
  assertEquals(
    liveMock.sent.some((s) => s.includes('text half')),
    false,
  );
  const stageEvents = eventsOf(events, 'stage');
  assertEquals(
    stageEvents.filter((e) => e.injected !== undefined),
    [],
  );
  assertEquals(
    stageEvents.flatMap((e) => e.stageWarnings ?? []).map((w) => [w.code, w.field]),
    [['inject_invalid_messages', 'inject']],
  );
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
          return { inject: [{ role: 'user', content: 'before-end steer' }], injectId: 'steer-end' };
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
      if (ev.type === 'stage' && ev.stage === 'post_turn') break;
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
  assertEquals(
    eventsOf(events, 'stage').filter((e) => e.injected !== undefined),
    [{ type: 'stage', stage: 'before_end', injected: [{ id: 'steer-end' }] }],
  );

  liveMock.close();
  await session.close();
});
