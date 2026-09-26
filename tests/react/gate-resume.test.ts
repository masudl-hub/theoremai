import { assertEquals } from '@std/assert';
import { lexiconDefault, type TurnEvent, type TurnHistoryMessage } from '../../mod.ts';
import {
  resumeInterfaceTool,
  streamInterfaceDraftTurn,
  streamInterfaceTurn,
} from '../../react/src/client/run-session.ts';
import type {
  TheoremInvokeRequest,
  TheoremTransport,
  TheoremTurnRequest,
} from '../../react/src/client/transport.ts';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  interfaceFromProfile,
  type TranscriptBlock,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { failureEvent } from '../../src/kernel/tools/events.ts';
import { formatToolFailureForModel, formatToolResult } from '../../src/kernel/tools/model-text.ts';
import type { ToolFailure } from '../../src/kernel/turn-events.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { toolSnapshot } from '../fixtures/events.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';

registerGooglePreset();

function textInterface(): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'gate_resume_bot',
      type: 'text',
      identity: { handle: 'gate_resume_bot', system: 'You reply.' },
      models: { fast: HOST_BINDINGS.gemini35FlashLite },
      key: 'slotA',
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return iface;
}

const at = 0;
const request = (callId: string, thoughtSignature?: string): TurnEvent => ({
  type: 'tool',
  tool: {
    name: 'lookup',
    callId,
    arguments: { q: callId },
    stepId: 'step-1',
    ...(thoughtSignature ? { thoughtSignature } : {}),
  },
});
const complete = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: { name: 'lookup', callId, at, phase: 'complete', output: {}, readBack: `read ${callId}` },
});

Deno.test('a gate on a later call of a step resumes with the whole step in history', async () => {
  const sent: TurnHistoryMessage[][] = [];
  let turns = 0;
  const transport: TheoremTransport = {
    turn: (request_, onEvent) => {
      sent.push(request_.input.history ?? []);
      turns += 1;
      if (turns === 1) {
        for (const event of [
          request('a', 'sig'),
          complete('a'),
          request('b'),
          {
            type: 'tool',
            tool: {
              name: 'lookup',
              callId: 'b',
              at,
              phase: 'gate',
              gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
            },
          },
          { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
        ] satisfies TurnEvent[]) {
          onEvent(event);
        }
      } else {
        onEvent({ type: 'text', text: 'Both looked up.' });
      }
      return Promise.resolve();
    },
    invoke: (_request, onEvent) => {
      onEvent(complete('b'));
      return Promise.resolve();
    },
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
  const iface = textInterface();

  const paused = await streamInterfaceTurn({
    iface,
    transport,
    session: emptyInterfaceTurnSession(),
    onStream: () => {},
    text: 'Look up a and b',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (!paused.ok) throw new Error(paused.error);
  assertEquals(paused.session.gatedTool?.callId, 'b');
  assertEquals(paused.session.history, [{ role: 'user', content: 'Look up a and b' }]);

  const resumed = await resumeInterfaceTool({
    iface,
    transport,
    session: paused.session,
    resolution: { action: 'allow' },
    onStream: () => {},
  });
  if (!resumed.ok) throw new Error(resumed.error);

  const step: TurnHistoryMessage[] = [
    { role: 'user', content: 'Look up a and b' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"a"}' },
          thoughtSignature: 'sig',
        },
        { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":"b"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', name: 'lookup', content: 'read a' },
    { role: 'tool', tool_call_id: 'b', name: 'lookup', content: 'read b' },
  ];
  assertEquals(sent[1], step);
  assertEquals(resumed.session.history, [
    ...step,
    { role: 'assistant', content: 'Both looked up.' },
  ]);
});

const gate = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: {
    name: 'lookup',
    callId,
    at,
    phase: 'gate',
    gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
  },
});

/** What the host settles an answered gate with: the call's result, or its refusal. */
const settled = (answer: TheoremInvokeRequest): TurnEvent =>
  answer.decision === 'approve'
    ? complete(answer.gateId)
    : failureEvent(
        { name: 'lookup', callId: answer.gateId },
        { code: 'denied', kind: 'declined', message: 'declined' },
      );

/** A walked-away call, as the host settles it. */
const CANCELLED: ToolFailure = { code: 'cancelled', kind: 'cancelled', message: 'cancelled' };
const cancelled = (callId: string): TurnEvent =>
  failureEvent({ name: 'lookup', callId }, CANCELLED);

/** What the model reads for a walked-away call. */
function cancelledReadBack(): string {
  return formatToolResult(formatToolFailureForModel(CANCELLED));
}

Deno.test('a step with two gates asks for each in order, then continues once', async () => {
  const sent: TurnHistoryMessage[][] = [];
  const decisions: [string, string][] = [];
  const transport: TheoremTransport = {
    turn: (request_, onEvent) => {
      sent.push(request_.input.history ?? []);
      const events: TurnEvent[] =
        sent.length === 1
          ? [
              request('a', 'sig'),
              gate('a'),
              request('b'),
              complete('b'),
              request('c'),
              gate('c'),
              { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
            ]
          : [{ type: 'text', text: 'Done.' }];
      for (const event of events) onEvent(event);
      return Promise.resolve();
    },
    invoke: (request_, onEvent) => {
      decisions.push([request_.gateId, request_.decision]);
      onEvent(settled(request_));
      onEvent({ type: 'done', stop: { kind: 'completed' } });
      return Promise.resolve();
    },
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
  const iface = textInterface();
  const resume = (session: InterfaceTurnSession, action: 'allow' | 'deny') =>
    resumeInterfaceTool({ iface, transport, session, resolution: { action }, onStream: () => {} });

  const paused = await streamInterfaceTurn({
    iface,
    transport,
    session: emptyInterfaceTurnSession(),
    onStream: () => {},
    text: 'Look up a, b and c',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (!paused.ok) throw new Error(paused.error);
  assertEquals(paused.session.gatedTool?.callId, 'a');

  const second = await resume(paused.session, 'allow');
  if (!second.ok) throw new Error(second.error);
  assertEquals(second.session.gatedTool?.callId, 'c');
  assertEquals(sent.length, 1);

  const done = await resume(second.session, 'deny');
  if (!done.ok) throw new Error(done.error);
  assertEquals(done.session.gatedTool, null);
  assertEquals(sent.length, 2);
  const [user, assistant, ...results] = sent[1] ?? [];
  assertEquals(user, { role: 'user', content: 'Look up a, b and c' });
  assertEquals(
    assistant?.role === 'assistant' ? assistant.tool_calls?.map((call) => call.id) : undefined,
    ['a', 'b', 'c'],
  );
  assertEquals(
    results.map((message) => (message.role === 'tool' ? message.tool_call_id : '')),
    ['a', 'b', 'c'],
  );
  // The host settled the refusal: the browser sent the answer, not a failure of its own.
  assertEquals(decisions, [
    ['a', 'approve'],
    ['c', 'deny'],
  ]);
});

const pausedOnTwoGates: TurnEvent[] = [
  request('a'),
  gate('a'),
  request('b'),
  gate('b'),
  { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
];

/** A reply paused on gates a and b, sent from a fresh session. */
async function pausedOnTwo(iface: ComposerProfileInterface, transport: TheoremTransport) {
  const paused = await streamInterfaceTurn({
    iface,
    transport,
    session: emptyInterfaceTurnSession(),
    onStream: () => {},
    text: 'Look up a and b',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (!paused.ok) throw new Error(paused.error);
  return paused.session;
}

const openStep: TurnHistoryMessage[] = [
  { role: 'user', content: 'Look up a and b' },
  {
    role: 'assistant',
    tool_calls: [
      { id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
      { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":"b"}' } },
    ],
  },
];

Deno.test('a message sent while gated walks away from every waiting call in its own request', async () => {
  const requests: TheoremTurnRequest[] = [];
  const transport: TheoremTransport = {
    turn: (request_, onEvent) => {
      requests.push(request_);
      const events: TurnEvent[] =
        requests.length === 1
          ? pausedOnTwoGates
          : [
              cancelled('a'),
              cancelled('b'),
              { type: 'text', text: 'Sure.' },
              { type: 'done', stop: { kind: 'completed' } },
            ];
      for (const event of events) onEvent(event);
      return Promise.resolve();
    },
    invoke: () => Promise.reject(new Error('walking away sends no answer of its own')),
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
  const iface = textInterface();
  const paused = await pausedOnTwo(iface, transport);

  const posted: TranscriptBlock[][] = [];
  const sent = await streamInterfaceDraftTurn({
    iface,
    transport,
    session: paused,
    draft: { text: 'Never mind' },
    walkAway: { workedMs: 1200 },
    onStream: () => {},
    onUserBlocks: (blocks) => posted.push(blocks),
  });
  if (!sent.ok) throw new Error(sent.error);

  const walk = requests[1];
  assertEquals(walk.abandon, ['a', 'b']);
  assertEquals(Object.keys(walk.replay?.abandon ?? {}), ['a', 'b']);
  assertEquals(walk.replay?.abandon?.b?.input, { q: 'b' });
  // The model reads the paused step with its calls open; the host answers them.
  assertEquals(walk.input.history, openStep);
  assertEquals(walk.input.text, 'Never mind');

  // The paused reply posts settled, carrying its work, then the message.
  assertEquals(posted.length, 1);
  assertEquals(
    posted[0].map((block) =>
      block.kind === 'tool' ? `${block.tool.callId}:${block.tool.state?.phase}` : block.kind,
    ),
    ['a:error', 'b:error', 'turn-done', 'user-text'],
  );
  const done = posted[0].find((block) => block.kind === 'turn-done');
  assertEquals(done?.kind === 'turn-done' ? done.workedMs : undefined, 1200);
  assertEquals(sent.userBlocks, posted[0]);

  assertEquals(sent.session.gatedTool, null);
  assertEquals(sent.session.history, [
    ...openStep,
    { role: 'tool', tool_call_id: 'a', name: 'lookup', content: cancelledReadBack() },
    { role: 'tool', tool_call_id: 'b', name: 'lookup', content: cancelledReadBack() },
    { role: 'user', content: 'Never mind' },
    { role: 'assistant', content: 'Sure.' },
  ]);
});

Deno.test('a walk-away that fails before its calls settle leaves the reply waiting and the message unposted', async () => {
  let turns = 0;
  const transport: TheoremTransport = {
    turn: (_request, onEvent) => {
      turns += 1;
      if (turns > 1) return Promise.reject(new Error('host down'));
      for (const event of pausedOnTwoGates) onEvent(event);
      return Promise.resolve();
    },
    invoke: () => Promise.reject(new Error('unused')),
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
  const iface = textInterface();
  const paused = await pausedOnTwo(iface, transport);

  const posted: TranscriptBlock[][] = [];
  const sent = await streamInterfaceDraftTurn({
    iface,
    transport,
    session: paused,
    draft: { text: 'Never mind' },
    walkAway: { workedMs: 0 },
    onStream: () => {},
    onUserBlocks: (blocks) => posted.push(blocks),
  });
  assertEquals(sent.ok, false);
  if (sent.ok) return;
  assertEquals(sent.session, undefined);
  assertEquals(posted, []);
});

Deno.test('a message sent while gated, without walking away, is refused', async () => {
  const transport: TheoremTransport = {
    turn: (_request, onEvent) => {
      for (const event of pausedOnTwoGates) onEvent(event);
      return Promise.resolve();
    },
    invoke: () => Promise.reject(new Error('unused')),
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
  const iface = textInterface();
  const paused = await pausedOnTwo(iface, transport);
  const sent = await streamInterfaceDraftTurn({
    iface,
    transport,
    session: paused,
    draft: { text: 'Never mind' },
    onStream: () => {},
  });
  assertEquals(sent.ok ? undefined : sent.error, lexiconDefault('session.gate_pending'));
});

/** A transport whose first turn pauses on `paused`, and whose answer streams `answered`, then the network drops. */
function cutAnswer(paused: TurnEvent[], answered: TurnEvent[]): TheoremTransport {
  return {
    turn: (_request, onEvent) => {
      for (const event of paused) onEvent(event);
      return Promise.resolve();
    },
    invoke: (_request, onEvent) => {
      for (const event of answered) onEvent(event);
      return Promise.reject(new TypeError('network connection lost'));
    },
    steer: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
  };
}

const running = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: { name: 'lookup', callId, at, phase: 'running' },
});

Deno.test('an answer the network lost before its call settled leaves the reply waiting on the same gate', async () => {
  const iface = textInterface();
  const transport = cutAnswer(pausedOnTwoGates, [running('a')]);
  const paused = await pausedOnTwo(iface, transport);
  const answered = await resumeInterfaceTool({
    iface,
    transport,
    session: paused,
    resolution: { action: 'allow' },
    onStream: () => {},
  });
  assertEquals(answered.ok, false);
  if (answered.ok) return;
  // No session: the reply waits as it did, and the host puts the call back to be answered again.
  assertEquals(answered.session, undefined);
});

Deno.test('an answer the network lost after its call settled keeps the result, and the reply waits on its next gate', async () => {
  const iface = textInterface();
  const transport = cutAnswer(pausedOnTwoGates, [running('a'), complete('a')]);
  const paused = await pausedOnTwo(iface, transport);
  const answered = await resumeInterfaceTool({
    iface,
    transport,
    session: paused,
    resolution: { action: 'allow' },
    onStream: () => {},
  });
  if (answered.ok) throw new Error('expected the answer to fail');
  assertEquals(answered.session?.gatedTool?.callId, 'b');
  assertEquals(
    answered.session?.assistantEvents.some(
      (event) =>
        event.type === 'tool' && event.tool.callId === 'a' && event.tool.phase === 'complete',
    ),
    true,
  );
});

Deno.test('an answer the network lost after its only call settled commits the reply as far as it got', async () => {
  const iface = textInterface();
  const pausedOnOne: TurnEvent[] = [
    request('a'),
    gate('a'),
    { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
  ];
  const transport = cutAnswer(pausedOnOne, [complete('a')]);
  const paused = await streamInterfaceTurn({
    iface,
    transport,
    session: emptyInterfaceTurnSession(),
    onStream: () => {},
    text: 'Look up a',
    pendingFiles: [],
    pendingVoice: [],
  });
  if (!paused.ok) throw new Error(paused.error);
  const answered = await resumeInterfaceTool({
    iface,
    transport,
    session: paused.session,
    resolution: { action: 'allow' },
    onStream: () => {},
  });
  if (answered.ok) throw new Error('expected the answer to fail');
  assertEquals(answered.session?.gatedTool, null);
  assertEquals(answered.session?.history, [
    { role: 'user', content: 'Look up a' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', name: 'lookup', content: 'read a' },
  ]);
});
