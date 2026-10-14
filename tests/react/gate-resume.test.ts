import { assertEquals } from '@std/assert';
import { labelDefault, type TurnEvent } from '../../mod.ts';
import { sessionAfter } from '../../react/src/client/run-commit.ts';
import {
  type RunOutcome,
  resumeInterfaceTool,
  streamInterfaceDraftTurn,
  streamInterfaceTurn,
} from '../../react/src/client/run-session.ts';
import type {
  ChatLineSink,
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
import type { ToolFailure } from '../../src/kernel/turn-events.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { toolSnapshot } from '../fixtures/events.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';
import { unskippedView } from '../fixtures/stream-view.ts';

registerGooglePreset();
function textInterface(): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'gate_resume_bot',
      type: 'text',
      identity: { handle: 'gate_resume_bot', system: 'You reply.' },
      models: { fast: HOST_BINDINGS.gemini35FlashLite },
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return iface;
}
const REF = 'ref-1';
/** The host's line once it holds the person's message. */
const POSTED = { type: 'conversation', ref: REF, posted: true } as const;
/** A host that keeps the conversation: each run streams what the test gives it. */
function hostTransport(runs: {
  turn?: (request: TheoremTurnRequest, onLine: ChatLineSink) => Promise<void>;
  invoke?: (request: TheoremInvokeRequest, onLine: ChatLineSink) => Promise<void>;
}): TheoremTransport {
  const unused = () => Promise.reject(new Error('unused'));
  return {
    turn: runs.turn ?? unused,
    invoke: runs.invoke ?? unused,
    steer: unused,
    describe: unused,
    conversation: unused,
    rewind: unused,
  };
}
/** The session a run leaves, as the page draws it: the paused reply's events beside the transcript. */
function sessionOf(outcome: RunOutcome): InterfaceTurnSession {
  if (outcome.failure) throw new Error(outcome.failure.error);
  return sessionAfter(outcome.session, outcome.events);
}
/** A reply paused on what `transport`'s first turn streams, sent from a fresh session. */
async function pausedOn(iface: ComposerProfileInterface, transport: TheoremTransport) {
  return sessionOf(
    await streamInterfaceTurn({
      iface,
      transport,
      session: emptyInterfaceTurnSession(),
      scope: {},
      view: unskippedView,
      onUserBlocks: () => {},
      text: 'Look up a and b',
      pendingFiles: [],
      pendingVoice: [],
    }),
  );
}
/** The user's answer to the gate `session` waits on, in the conversation the host keeps. */
function answer(
  iface: ComposerProfileInterface,
  transport: TheoremTransport,
  session: InterfaceTurnSession,
  action: 'allow' | 'deny',
) {
  return resumeInterfaceTool({
    iface,
    transport,
    session,
    scope: { conversation: REF },
    resolution: { action },
    view: unskippedView,
  });
}
/** Whether `events` hold call `callId` in `phase`. */
function callIn(events: readonly TurnEvent[], callId: string, phase: string): boolean {
  return events.some(
    (event) => event.type === 'tool' && event.tool.callId === callId && event.tool.phase === phase,
  );
}
const at = 0;
const request = (callId: string, thoughtSignature?: string): TurnEvent => ({
  type: 'tool',
  tool: {
    name: 'lookup',
    callId,
    operationId: callId,
    arguments: { q: callId },
    stepId: 'step-1',
    ...(thoughtSignature ? { thoughtSignature } : {}),
  },
});
const complete = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: {
    name: 'lookup',
    callId,
    operationId: callId,
    at,
    phase: 'complete',
    output: {},
    readBack: `read ${callId}`,
  },
});
Deno.test('a gate on a later call of a step waits on that call, and its answer goes on from it', async () => {
  const answers: TheoremInvokeRequest[] = [];
  const transport = hostTransport({
    turn: (_request, onLine) => {
      onLine(POSTED);
      for (const event of [
        request('a', 'sig'),
        complete('a'),
        request('b'),
        gate('b'),
        { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
      ] satisfies TurnEvent[]) {
        onLine(event);
      }
      return Promise.resolve();
    },
    invoke: (request_, onLine) => {
      answers.push(request_);
      onLine(complete('b'));
      onLine({ type: 'text', text: 'Both looked up.' });
      onLine({ type: 'conversation', ref: REF });
      return Promise.resolve();
    },
  });
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  assertEquals(paused.gatedTool?.callId, 'b');
  const resumed = await answer(iface, transport, paused, 'allow');
  assertEquals(
    answers.map(({ conversation, gateId, operationId, decision }) => ({
      conversation,
      gateId,
      operationId,
      decision,
    })),
    [{ conversation: REF, gateId: 'b', operationId: 'b', decision: 'approve' }],
  );
  assertEquals(resumed.events.at(-1), { type: 'text', text: 'Both looked up.' });
  assertEquals(sessionOf(resumed).gatedTool, null);
});
const gate = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: {
    name: 'lookup',
    callId,
    operationId: callId,
    at,
    phase: 'gate',
    gate: { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
  },
});
/** What the host settles an answered gate with: the call's result, or its refusal. */
const settled = (answer_: TheoremInvokeRequest): TurnEvent =>
  answer_.decision === 'approve'
    ? complete(answer_.gateId)
    : failureEvent(
        { name: 'lookup', callId: answer_.gateId, operationId: answer_.operationId },
        { code: 'denied', kind: 'declined', message: 'declined' },
      );
/** A walked-away call, as the host settles it. */
const CANCELLED: ToolFailure = { code: 'cancelled', kind: 'cancelled', message: 'cancelled' };
const cancelled = (callId: string): TurnEvent =>
  failureEvent({ name: 'lookup', callId }, CANCELLED);
Deno.test('a step with two gates asks for each in order, then goes on once', async () => {
  const decisions: [string, string][] = [];
  const transport = hostTransport({
    turn: (_request, onLine) => {
      onLine(POSTED);
      for (const event of [
        request('a', 'sig'),
        gate('a'),
        request('b'),
        complete('b'),
        request('c'),
        gate('c'),
        { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
      ] satisfies TurnEvent[]) {
        onLine(event);
      }
      return Promise.resolve();
    },
    invoke: (request_, onLine) => {
      decisions.push([request_.gateId, request_.decision]);
      onLine(settled(request_));
      // The host goes on with the reply once no call waits.
      if (request_.gateId === 'c') onLine({ type: 'text', text: 'Done.' });
      onLine({ type: 'conversation', ref: REF });
      return Promise.resolve();
    },
  });
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  assertEquals(paused.gatedTool?.callId, 'a');
  const second = sessionOf(await answer(iface, transport, paused, 'allow'));
  assertEquals(second.gatedTool?.callId, 'c');
  const done = await answer(iface, transport, second, 'deny');
  assertEquals(sessionOf(done).gatedTool, null);
  assertEquals(done.events.at(-1), { type: 'text', text: 'Done.' });
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
/** A host whose first turn pauses on gates a and b; `walk` answers the next. */
function pausedOnTwoTransport(
  walk: (request: TheoremTurnRequest, onLine: ChatLineSink) => Promise<void>,
): TheoremTransport {
  let turns = 0;
  return hostTransport({
    turn: (request_, onLine) => {
      turns += 1;
      if (turns > 1) return walk(request_, onLine);
      onLine(POSTED);
      for (const event of pausedOnTwoGates) onLine(event);
      return Promise.resolve();
    },
    invoke: () => Promise.reject(new Error('walking away sends no answer of its own')),
  });
}
/** A message sent while the reply waits on its gates. */
async function walkAway(
  iface: ComposerProfileInterface,
  transport: TheoremTransport,
  session: InterfaceTurnSession,
  walk: boolean,
) {
  const posted: TranscriptBlock[][] = [];
  const outcome = await streamInterfaceDraftTurn({
    iface,
    transport,
    session,
    scope: { conversation: REF },
    draft: { text: 'Never mind' },
    walkAway: walk,
    view: unskippedView,
    onUserBlocks: (blocks) => posted.push(blocks),
  });
  return { outcome, posted };
}
Deno.test('a message sent while gated walks away from every waiting call in its own request', async () => {
  const requests: TheoremTurnRequest[] = [];
  const transport = pausedOnTwoTransport((request_, onLine) => {
    requests.push(request_);
    onLine(cancelled('a'));
    onLine(cancelled('b'));
    onLine(POSTED);
    onLine({ type: 'text', text: 'Sure.' });
    onLine({ type: 'done', stop: { kind: 'completed' } });
    return Promise.resolve();
  });
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  const { outcome, posted } = await walkAway(iface, transport, paused, true);
  const [walk] = requests;
  assertEquals(walk?.conversation, REF);
  assertEquals(walk?.abandon, [
    { callId: 'a', operationId: 'a' },
    { callId: 'b', operationId: 'b' },
  ]);
  assertEquals(Object.keys(walk?.replay?.abandon ?? {}), ['a', 'b']);
  assertEquals(walk?.replay?.abandon?.b?.input, { q: 'b' });
  assertEquals(walk?.input, { text: 'Never mind' });
  // The paused reply posts settled, then the message, once the host has it.
  assertEquals(posted.length, 1);
  assertEquals(
    posted[0]?.map((block) =>
      block.kind === 'tool' ? `${block.tool.callId}:${block.tool.state?.phase}` : block.kind,
    ),
    ['a:error', 'b:error', 'turn-done', 'user-text'],
  );
  assertEquals(outcome.posted, true);
  // The run's events are the new reply's alone.
  assertEquals(outcome.events, [
    { type: 'text', text: 'Sure.' },
    { type: 'done', stop: { kind: 'completed' } },
  ]);
  assertEquals(sessionOf(outcome).gatedTool, null);
});
Deno.test('a walk-away that fails before its calls settle leaves the reply waiting and the message unposted', async () => {
  const transport = pausedOnTwoTransport(() => Promise.reject(new Error('host down')));
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  const { outcome, posted } = await walkAway(iface, transport, paused, true);
  assertEquals(outcome.failure?.errorKind, 'internal');
  assertEquals(outcome.posted, false);
  assertEquals(outcome.events, []);
  assertEquals(posted, []);
});
Deno.test('a walk-away the host settled but failed before posting leaves the message unposted', async () => {
  const transport = pausedOnTwoTransport((_request, onLine) => {
    onLine(cancelled('a'));
    onLine(cancelled('b'));
    onLine({ type: 'conversation', ref: REF });
    return Promise.reject(new Error('host down'));
  });
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  const { outcome, posted } = await walkAway(iface, transport, paused, true);
  assertEquals(outcome.posted, false);
  assertEquals(outcome.events, []);
  assertEquals(posted, []);
});
Deno.test('a message sent while gated, without walking away, is refused', async () => {
  const transport = pausedOnTwoTransport(() => Promise.reject(new Error('unused')));
  const iface = textInterface();
  const paused = await pausedOn(iface, transport);
  const { outcome, posted } = await walkAway(iface, transport, paused, false);
  assertEquals(outcome.failure?.error, labelDefault('session.gate_pending'));
  assertEquals(posted, []);
});
/** A host whose first turn pauses on `paused`, and whose answer streams `answered`, then the network drops. */
function cutAnswer(paused: TurnEvent[], answered: TurnEvent[]): TheoremTransport {
  return hostTransport({
    turn: (_request, onLine) => {
      onLine(POSTED);
      for (const event of paused) onLine(event);
      return Promise.resolve();
    },
    invoke: (_request, onLine) => {
      for (const event of answered) onLine(event);
      return Promise.reject(new TypeError('network connection lost'));
    },
  });
}
const running = (callId: string): TurnEvent => ({
  type: 'tool',
  tool: { name: 'lookup', callId, operationId: callId, at, phase: 'running' },
});
/** A failed answer's session, as the page draws it until it reads the host's conversation. */
function failedSession(outcome: RunOutcome): InterfaceTurnSession {
  if (!outcome.failure) throw new Error('expected the answer to fail');
  return sessionAfter(outcome.session, outcome.events);
}
Deno.test('an answer the network lost before its call settled leaves the reply waiting on the same gate', async () => {
  const iface = textInterface();
  const transport = cutAnswer(pausedOnTwoGates, [running('a')]);
  const paused = await pausedOn(iface, transport);
  const answered = await answer(iface, transport, paused, 'allow');
  assertEquals(answered.events, paused.assistantEvents);
  assertEquals(failedSession(answered).gatedTool?.callId, 'a');
});
Deno.test('an answer the network lost after its call settled keeps the result, and the reply waits on its next gate', async () => {
  const iface = textInterface();
  const transport = cutAnswer(pausedOnTwoGates, [running('a'), complete('a')]);
  const paused = await pausedOn(iface, transport);
  const answered = await answer(iface, transport, paused, 'allow');
  const session = failedSession(answered);
  assertEquals(session.gatedTool?.callId, 'b');
  assertEquals(callIn(session.assistantEvents, 'a', 'complete'), true);
});
Deno.test('an answer the network lost after its only call settled leaves nothing waiting', async () => {
  const iface = textInterface();
  const pausedOnOne: TurnEvent[] = [
    request('a'),
    gate('a'),
    { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
  ];
  const transport = cutAnswer(pausedOnOne, [complete('a')]);
  const paused = await pausedOn(iface, transport);
  const answered = await answer(iface, transport, paused, 'allow');
  assertEquals(callIn(answered.events, 'a', 'complete'), true);
  assertEquals(failedSession(answered).gatedTool, null);
});
