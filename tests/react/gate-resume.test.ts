import { assertEquals } from '@std/assert';
import type { TurnEvent, TurnHistoryMessage } from '../../mod.ts';
import {
  abandonGatedInterfaceTool,
  resumeInterfaceTool,
  streamInterfaceTurn,
} from '../../react/src/client/run-session.ts';
import type { TheoremInvokeRequest, TheoremTransport } from '../../react/src/client/transport.ts';
import {
  type ComposerProfileInterface,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  interfaceFromProfile,
} from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { failureEvent } from '../../src/kernel/tools/events.ts';
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
const settled = (answer: TheoremInvokeRequest): TurnEvent => {
  if (answer.decision === 'approve') return complete(answer.gateId);
  return failureEvent(
    { name: 'lookup', callId: answer.gateId },
    answer.decision === 'deny'
      ? { code: 'denied', kind: 'declined', message: 'declined' }
      : { code: 'cancelled', kind: 'cancelled', message: 'cancelled' },
  );
};

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

Deno.test('send now while gated abandons every waiting call through the host, without the model', async () => {
  const decisions: [string, string][] = [];
  let turns = 0;
  const transport: TheoremTransport = {
    turn: (_request, onEvent) => {
      turns += 1;
      for (const event of [
        request('a'),
        gate('a'),
        request('b'),
        gate('b'),
        { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
      ] satisfies TurnEvent[]) {
        onEvent(event);
      }
      return Promise.resolve();
    },
    invoke: (request_, onEvent) => {
      decisions.push([request_.gateId, request_.decision]);
      onEvent(settled(request_));
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

  const abandoned = await abandonGatedInterfaceTool({
    iface,
    transport,
    session: paused.session,
    onStream: () => {},
  });
  if (!abandoned.ok) throw new Error(abandoned.error);
  assertEquals(decisions, [
    ['a', 'abandon'],
    ['b', 'abandon'],
  ]);
  assertEquals(turns, 1);
  assertEquals(abandoned.session.gatedTool, null);
  assertEquals(abandoned.session.assistantEvents, []);
  assertEquals(
    abandoned.session.history
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id),
    ['a', 'b'],
  );
});

Deno.test('an abandon the host fails keeps what it settled and still waits on the rest', async () => {
  const transport: TheoremTransport = {
    turn: (_request, onEvent) => {
      for (const event of [
        request('a'),
        gate('a'),
        request('b'),
        gate('b'),
        { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
      ] satisfies TurnEvent[]) {
        onEvent(event);
      }
      return Promise.resolve();
    },
    invoke: (request_, onEvent) => {
      if (request_.gateId === 'b') return Promise.reject(new Error('host down'));
      onEvent(settled(request_));
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

  const failed = await abandonGatedInterfaceTool({
    iface,
    transport,
    session: paused.session,
    onStream: () => {},
  });
  assertEquals(failed.ok, false);
  if (failed.ok) return;
  assertEquals(failed.session?.gatedTool?.callId, 'b');
});
