import { assert, assertEquals } from '@std/assert';
import type { ComposerProfileInterface } from '../../src/interface/mod.ts';
import { interfaceFromProfile } from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { failureEvent } from '../../src/kernel/tools/events.ts';
import type { TurnEvent } from '../../src/kernel/turn-events.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import {
  type ChatLineSink,
  type TheoremInvokeRequest,
  type TheoremSteerRequest,
  type TheoremStopRequest,
  TheoremStreamError,
  type TheoremTransport,
  type TheoremTurnRequest,
} from '../../web/src/client/transport.ts';
import { toolSnapshot } from '../fixtures/events.ts';
import { CHAT_MEDIA_LIMITS, HOST_BINDINGS } from '../fixtures/models.ts';

registerGooglePreset();

/** A stateless text profile that allows steering: the page keeps the transcript. */
function textInterface(): ComposerProfileInterface {
  const iface = interfaceFromProfile(
    defineProfile({
      id: 'chat_controller_bot',
      type: 'text',
      identity: { handle: 'chat_controller_bot', system: 'You reply.' },
      models: { fast: HOST_BINDINGS.gemini35FlashLite },
      tools: { allow: [] },
      inputs: { text: true, ...CHAT_MEDIA_LIMITS },
    }),
    defaultKernelScope.tools,
  );
  if (iface.type !== 'text') throw new Error('expected a text interface');
  return { ...iface, allowSteering: true, providerContinuation: { history: 'stateless' } };
}

/** One turn the host is streaming: the test writes its lines and ends it. */
type OpenTurn = {
  request: TheoremTurnRequest;
  signal?: AbortSignal;
  line: ChatLineSink;
  end(): void;
};

/** A host whose turns stay open until the test ends them. */
function heldHost() {
  const turns: OpenTurn[] = [];
  const steers: TheoremSteerRequest[] = [];
  const stops: TheoremStopRequest[] = [];
  const transport: TheoremTransport = {
    turn: (request, onLine, signal) =>
      new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The run was stopped', 'AbortError')),
        );
        turns.push({ request, signal, line: onLine, end: resolve });
      }),
    steer: (request) => {
      steers.push(request);
      return Promise.resolve();
    },
    // The host stops the turn where it stands: its stream ends cancelled.
    stop: (request) => {
      stops.push(request);
      const turn = turns.find((open) => open.request.turnId === request.turnId);
      turn?.line({ type: 'done', stop: { kind: 'cancelled' } });
      turn?.end();
      return Promise.resolve();
    },
    invoke: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
    conversation: () => Promise.reject(new Error('unused')),
    rewind: () => Promise.reject(new Error('unused')),
  };
  return { transport, turns, steers, stops };
}

/** Lets every pending promise and microtask run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function textOf(request: TheoremTurnRequest): string | undefined {
  return request.input.text;
}

/** Replies `text` and ends the turn. */
function reply(turn: OpenTurn, text: string): void {
  turn.line({ type: 'text', text });
  turn.line({ type: 'done', stop: { kind: 'completed' } });
  turn.end();
}

/** The transcript's messages and replies, in order. */
function said(blocks: readonly { kind: string; text?: string }[]): [string, string | undefined][] {
  return blocks.flatMap((b) =>
    b.kind === 'user-text' || b.kind === 'text' ? [[b.kind, b.text]] : [],
  );
}

Deno.test('a draft sent at idle joins the transcript with its reply, and the composer empties', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Hello');
  const sent = chat.submit();
  await settle();
  assertEquals(textOf(host.turns[0].request), 'Hello');
  assertEquals(chat.getState().phase, 'streaming');
  assertEquals(chat.getState().draftText, '');
  reply(host.turns[0], 'Hi there');
  await sent;
  const state = chat.getState();
  assertEquals(state.phase, 'idle');
  assertEquals(state.streaming, false);
  assertEquals(state.delivery, 'read');
  assert(state.blocks.some((b) => b.kind === 'user-text'));
  assert(state.blocks.some((b) => b.kind === 'text'));
});

Deno.test("a steer goes to the running turn by its id, and shows where the turn's stage lands it", async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('First');
  const sent = chat.submit();
  await settle();
  chat.setDraftText('Also the fern');
  await chat.enqueue('steer');
  const [steer] = chat.getState().pendingMessages;
  assertEquals(steer.kind, 'steer');
  assertEquals(host.steers.length, 1);
  assertEquals(host.steers[0].turnId, host.turns[0].request.turnId);
  assertEquals(host.steers[0].id, steer.id);
  assert(host.steers[0].inject.length > 0);
  host.turns[0].line({ type: 'text', text: 'Looking' });
  host.turns[0].line({
    type: 'stage',
    stage: 'post_tool',
    injected: [{ id: steer.id, messages: host.steers[0].inject }],
  });
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[0], 'Noted');
  await sent;
  await settle();
  assertEquals(host.turns.length, 1);
  assertEquals(said(chat.getState().blocks), [
    ['user-text', 'First'],
    ['text', 'Looking'],
    ['user-text', 'Also the fern'],
    ['text', 'Noted'],
  ]);
});

Deno.test('a steer the turn never took is the next message sent', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('First');
  void chat.submit();
  await settle();
  chat.setDraftText('Late steer');
  await chat.enqueue('steer');
  reply(host.turns[0], 'Done');
  await settle();
  assertEquals(host.turns.length, 2);
  assertEquals(textOf(host.turns[1].request), 'Late steer');
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[1], 'And that');
  await settle();
});

Deno.test('a steer with no running turn says the turn ended, and waits at the front of the queue', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Steer at rest');
  await chat.enqueue('steer');
  assertEquals(host.steers, []);
  assertEquals(chat.getState().failure?.error !== undefined, true);
  assertEquals(
    chat.getState().pendingMessages.map((m) => m.kind),
    ['queue'],
  );
  assertEquals(host.turns, []);
});

Deno.test('a message submitted while a reply streams is queued, and sent once the reply ends', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('One');
  void chat.submit();
  await settle();
  chat.setDraftText('Two');
  await chat.submit();
  assertEquals(
    chat.getState().pendingMessages.map((m) => m.kind),
    ['queue'],
  );
  assertEquals(host.turns.length, 1);
  reply(host.turns[0], 'First reply');
  await settle();
  assertEquals(textOf(host.turns[1].request), 'Two');
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[1], 'Second reply');
  await settle();
});

Deno.test('a stash stays put; queued at idle, it sends', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Keep for later');
  await chat.enqueue('stash');
  await settle();
  assertEquals(host.turns, []);
  const [stash] = chat.getState().pendingMessages;
  chat.queuePending(stash.id);
  await settle();
  assertEquals(textOf(host.turns[0].request), 'Keep for later');
  reply(host.turns[0], 'Sent');
  await settle();
  assertEquals(chat.getState().pendingMessages, []);
});

Deno.test('restoring a pending message stashes what the composer holds first', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Stashed one');
  await chat.enqueue('stash');
  const [stash] = chat.getState().pendingMessages;
  chat.setDraftText('Half typed');
  await chat.restorePending(stash.id);
  const state = chat.getState();
  assertEquals(state.draftText, 'Stashed one');
  assertEquals(
    state.pendingMessages.map((m) => [m.kind, m.draft.text]),
    [['stash', 'Half typed']],
  );
});

Deno.test('send now stops the streaming reply where it stands, keeps what it said, then sends', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Long question');
  void chat.submit();
  await settle();
  host.turns[0].line({ type: 'text', text: 'The long answer starts' });
  chat.setDraftText('Never mind, this');
  await chat.enqueue('queue');
  const [queued] = chat.getState().pendingMessages;
  const now = chat.sendNow(queued);
  await settle();
  assertEquals(host.stops, [{ turnId: host.turns[0].request.turnId as string }]);
  assertEquals(host.turns[0].signal?.aborted, false);
  assertEquals(host.turns.length, 2);
  assertEquals(textOf(host.turns[1].request), 'Never mind, this');
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[1], 'Sure');
  await now;
  const { blocks } = chat.getState();
  assertEquals(said(blocks), [
    ['user-text', 'Long question'],
    ['text', 'The long answer starts'],
    ['user-text', 'Never mind, this'],
    ['text', 'Sure'],
  ]);
  assertEquals(
    blocks.flatMap((b) => (b.kind === 'turn-done' ? [b.stop?.kind] : [])),
    ['cancelled', 'completed'],
  );
});

Deno.test('a stop keeps what the reply said, and a queued message stays queued', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Plan a trip');
  const sent = chat.submit();
  await settle();
  host.turns[0].line({ type: 'text', text: 'Day one' });
  chat.setDraftText('Then the coast');
  await chat.enqueue('queue');
  chat.stop();
  await sent;
  await settle();
  assertEquals(host.turns.length, 1);
  assertEquals(
    chat.getState().pendingMessages.map((m) => [m.kind, m.draft.text]),
    [['queue', 'Then the coast']],
  );
  assertEquals(said(chat.getState().blocks), [
    ['user-text', 'Plan a trip'],
    ['text', 'Day one'],
  ]);
});

Deno.test('each turn carries the slots and context as they are when it is sent', async () => {
  const host = heldHost();
  const iface = {
    ...textInterface(),
    inputs: { ...textInterface().inputs, slots: { tone: ['warm', 'dry'] } },
  };
  const chat = createChatController({ transport: host.transport, iface, context: { page: 'a' } });
  assertEquals(chat.getState().slots?.values, { tone: 'warm' });
  chat.pickSlot('tone', 'dry');
  chat.update({ transport: host.transport, iface, context: { page: 'b' } });
  const sent = chat.sendText('Hi');
  await settle();
  assertEquals(host.turns[0].request.input.slots, { tone: 'dry' });
  assertEquals(host.turns[0].request.input.context, { page: 'b' });
  reply(host.turns[0], 'Hello');
  const turn = await sent;
  assertEquals(turn?.blocks.map((b) => b.kind).includes('user-text'), true);
});

Deno.test('listeners hear a batch of changes once, after the code that made them', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  let heard = 0;
  chat.subscribe(() => heard++);
  chat.setDraftText('a');
  chat.setDraftText((prev) => `${prev}b`);
  assertEquals(heard, 0);
  await settle();
  assertEquals(heard, 1);
  assertEquals(chat.getState().draftText, 'ab');
  const before = chat.getState();
  await settle();
  assertEquals(chat.getState(), before);
});

/** The same profile, on a host that keeps the conversation. */
function hostedInterface(): ComposerProfileInterface {
  return { ...textInterface(), providerContinuation: { history: 'host' } };
}

Deno.test('a host that keeps the conversation is drawn from its ref once the reply ends', async () => {
  const host = heldHost();
  const refs: (string | undefined)[] = [];
  const asked: string[] = [];
  const transport: TheoremTransport = {
    ...host.transport,
    conversation: ({ conversation }) => {
      asked.push(conversation);
      return Promise.resolve({
        transcript: [{ id: 'u1', kind: 'user-text', text: 'Hello' }],
      });
    },
  };
  const chat = createChatController({
    transport,
    iface: hostedInterface(),
    onConversationChange: (ref) => refs.push(ref),
  });
  const sent = chat.sendText('Hello');
  await settle();
  host.turns[0].line({ type: 'conversation', ref: 'ref-1', posted: true });
  assertEquals(chat.getState().delivery, 'sent');
  const shownId = chat.getState().blocks[0]?.id;
  reply(host.turns[0], 'Hi');
  await sent;
  assertEquals(refs, ['ref-1']);
  assertEquals(asked, ['ref-1']);
  // invariant: The host's blocks take the ids already on screen, so nothing shown remounts.
  assertEquals(
    chat.getState().blocks.map((b) => [b.id, b.kind]),
    [[shownId, 'user-text']],
  );
});

Deno.test('a resumed conversation is drawn from the view the page already has', async () => {
  const host = heldHost();
  const chat = createChatController({
    transport: host.transport,
    iface: hostedInterface(),
    conversation: 'ref-9',
    conversationView: { transcript: [{ id: 'u9', kind: 'user-text', text: 'Earlier' }] },
  });
  assertEquals(chat.getState().chatStarted, true);
  assertEquals(
    chat.getState().blocks.map((b) => b.id),
    ['u9'],
  );
  const sent = chat.sendText('And now');
  await settle();
  assertEquals(host.turns[0].request.conversation, 'ref-9');
  host.turns[0].end();
  await sent;
});

Deno.test('a resumed conversation is read from the host once someone follows the chat', async () => {
  const host = heldHost();
  const asked: string[] = [];
  const transport: TheoremTransport = {
    ...host.transport,
    conversation: ({ conversation }) => {
      asked.push(conversation);
      return Promise.resolve({ transcript: [{ id: 'u5', kind: 'user-text', text: 'Before' }] });
    },
  };
  const chat = createChatController({ transport, iface: hostedInterface(), conversation: 'ref-5' });
  await settle();
  assertEquals(asked, []);
  chat.subscribe(() => {});
  chat.subscribe(() => {});
  await settle();
  assertEquals(asked, ['ref-5']);
  assertEquals(
    chat.getState().blocks.map((b) => b.id),
    ['u5'],
  );
});

Deno.test('a resumed conversation the host lost starts a new one, with no error', async () => {
  const refs: (string | undefined)[] = [];
  const transport: TheoremTransport = {
    ...heldHost().transport,
    conversation: () =>
      Promise.reject(
        new TheoremStreamError('request', 'gone', undefined, {
          key: 'session.conversation_unknown',
        }),
      ),
  };
  const chat = createChatController({
    transport,
    iface: hostedInterface(),
    conversation: 'ref-7',
    onConversationChange: (ref) => refs.push(ref),
  });
  chat.subscribe(() => {});
  await settle();
  assertEquals(refs, [undefined]);
  assertEquals(chat.getState().failure, null);
  assertEquals(chat.getState().blocks, []);
});

/** A call to `lookup` that waits on the page, or on the visitor's permission. */
function gated(callId: string, kind: 'page' | 'permission'): TurnEvent[] {
  return [
    {
      type: 'tool',
      tool: { name: 'lookup', callId, operationId: callId, arguments: {}, stepId: 'step-1' },
    },
    {
      type: 'tool',
      tool: {
        name: 'lookup',
        callId,
        operationId: callId,
        at: 0,
        phase: 'gate',
        gate:
          kind === 'page'
            ? { kind: 'page', tool: 'lookup' }
            : { kind: 'permission', tool: 'lookup', permission: 'always_confirm' },
      },
    },
    { type: 'done', stop: { kind: 'gate' }, tools: toolSnapshot('lookup') },
  ];
}

Deno.test('a message sent now while the reply waits on a gate walks away from it in its own request', async () => {
  const host = heldHost();
  const transport: TheoremTransport = {
    ...host.transport,
    // The host keeps the reply paused on the gate until the walk-away settles it.
    conversation: () =>
      Promise.resolve({
        transcript: [{ id: 'u2', kind: 'user-text', text: 'Look it up' }],
        ...(host.turns.length === 1
          ? { paused: { events: gated('call-1', 'permission'), blocks: [] } }
          : {}),
      }),
  };
  const chat = createChatController({ transport, iface: hostedInterface() });
  const asked = chat.sendText('Look it up');
  await settle();
  host.turns[0].line({ type: 'conversation', ref: 'ref-2', posted: true });
  for (const line of gated('call-1', 'permission')) host.turns[0].line(line);
  host.turns[0].end();
  await asked;
  assertEquals(chat.getState().phase, 'gated');
  chat.setDraftText('Never mind');
  const sent = chat.sendNow();
  await settle();
  assertEquals(host.turns[1].request.conversation, 'ref-2');
  assertEquals(host.turns[1].request.abandon, [{ callId: 'call-1', operationId: 'call-1' }]);
  assertEquals(textOf(host.turns[1].request), 'Never mind');
  reply(host.turns[1], 'Sure.');
  await sent;
  assertEquals(chat.getState().phase, 'idle');
});

Deno.test('a restored page gate is answered unanswered once someone follows the chat, and only once', async () => {
  const host = heldHost();
  const invokes: TheoremInvokeRequest[] = [];
  const transport: TheoremTransport = {
    ...host.transport,
    invoke: (request, onLine) => {
      invokes.push(request);
      onLine(
        failureEvent(
          { name: 'lookup', callId: request.gateId, operationId: request.operationId },
          { code: 'unanswered', kind: 'declined', message: 'The page did not answer.' },
        ),
      );
      onLine({ type: 'done', stop: { kind: 'completed' } });
      return Promise.resolve();
    },
    conversation: () =>
      Promise.resolve({ transcript: [{ id: 'u3', kind: 'user-text', text: 'Use the page' }] }),
  };
  const options = {
    transport,
    iface: hostedInterface(),
    conversation: 'ref-3',
    conversationView: {
      transcript: [{ id: 'u3', kind: 'user-text' as const, text: 'Use the page' }],
      paused: { events: gated('call-3', 'page'), blocks: [] },
    },
  };
  // A chat built and dropped, as React's strict mode does, asks nothing of the host.
  createChatController(options);
  const chat = createChatController(options);
  await settle();
  assertEquals(chat.getState().phase, 'gated');
  assertEquals(invokes, []);
  chat.subscribe(() => {});
  await settle();
  chat.subscribe(() => {});
  await settle();
  assertEquals(invokes.length, 1);
  assertEquals(invokes[0].gateId, 'call-3');
  assertEquals(invokes[0].operationId, 'call-3');
  assertEquals(invokes[0].page, { unanswered: true });
  assertEquals(chat.getState().phase, 'idle');
});
