import { assert, assertEquals } from '@std/assert';
import type { ComposerProfileInterface } from '../../src/interface/mod.ts';
import { interfaceFromProfile } from '../../src/interface/mod.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { registerGooglePreset } from '../../src/presets/google.ts';
import { createChatController } from '../../web/src/client/chat.ts';
import type {
  ChatLineSink,
  TheoremSteerRequest,
  TheoremTransport,
  TheoremTurnRequest,
} from '../../web/src/client/transport.ts';
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
    invoke: () => Promise.reject(new Error('unused')),
    describe: () => Promise.reject(new Error('unused')),
    conversation: () => Promise.reject(new Error('unused')),
    rewind: () => Promise.reject(new Error('unused')),
  };
  return { transport, turns, steers };
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

Deno.test("a steer goes to the running turn by its id, and leaves once the turn's stage lands it", async () => {
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
  host.turns[0].line({ type: 'stage', stage: 'post_tool', injected: [{ id: steer.id }] });
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[0], 'Noted');
  await sent;
  await settle();
  assertEquals(host.turns.length, 1);
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

Deno.test('send now stops the streaming reply, then sends, and leaves the queue', async () => {
  const host = heldHost();
  const chat = createChatController({ transport: host.transport, iface: textInterface() });
  chat.setDraftText('Long question');
  void chat.submit();
  await settle();
  chat.setDraftText('Never mind, this');
  await chat.enqueue('queue');
  const [queued] = chat.getState().pendingMessages;
  const now = chat.sendNow(queued);
  await settle();
  assertEquals(host.turns[0].signal?.aborted, true);
  assertEquals(host.turns.length, 2);
  assertEquals(textOf(host.turns[1].request), 'Never mind, this');
  assertEquals(chat.getState().pendingMessages, []);
  reply(host.turns[1], 'Sure');
  await now;
  assert(chat.getState().blocks.some((b) => b.kind === 'turn-done'));
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
  const refs: string[] = [];
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
  reply(host.turns[0], 'Hi');
  await sent;
  assertEquals(refs, ['ref-1']);
  assertEquals(asked, ['ref-1']);
  assertEquals(
    chat.getState().blocks.map((b) => b.id),
    ['u1'],
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
