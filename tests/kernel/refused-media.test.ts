import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { forClient } from '../../src/host/client-turn.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  ModelEvent,
  ModelRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnInput,
  TurnModel,
} from '../../src/kernel/types.ts';
import { finalStop } from '../fixtures/events.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

const VIDEO = { mimeType: 'video/mp4', data: 'AAAA' };
const PHOTO = { mimeType: 'image/png', data: 'AAAA' };

const REFUSED: ModelEvent[] = [
  { type: 'error', errorKind: 'unsupported', errorInternal: 'HTTP 400: no video here' },
];
const ANSWER: ModelEvent[] = [
  { type: 'text', text: 'Hello.' },
  { type: 'done', stop: { kind: 'completed' } },
];

function mediaProfile(id: string, resends: boolean) {
  return defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id,
    models: { gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite },
    maxSteps: 4,
    tools: { allow: [] },
    ...(resends
      ? { turnBehaviour: { resumption: { autoContinue: ['provider_error' as const] } } }
      : {}),
    inputs: {
      text: true,
      attachments: { accept: ['video/mp4', 'image/png'] },
      maxFiles: 2,
      maxBytes: 1_000,
      maxTurnBytes: 2_000,
    },
    labels: { 'turn.media_refused_video': '[Unopened video.]' },
    guardrails: { quota: { perDay: 100 } },
  });
}

async function runScript(profile: string, input: TurnInput, script: ModelEvent[][]) {
  const requests: ModelRequest[] = [];
  const provider: TurnModel = {
    async *complete(request) {
      await Promise.resolve();
      const reply = script[Math.min(requests.length, script.length - 1)] ?? [];
      requests.push(request);
      yield* reply;
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn({ profile, input }, provider)) events.push(event);
  return { events, requests };
}

function doneOf(events: TurnEvent[]) {
  return events.find((event) => event.type === 'done');
}

function mediaOf(messages: readonly TurnHistoryMessage[] | undefined): string[] {
  return (messages ?? []).flatMap((message) =>
    (message.parts ?? []).flatMap((part) => (part.type === 'text' ? [] : [part.mimeType])),
  );
}

function errorsOf(events: TurnEvent[]) {
  return events.filter((event) => event.type === 'error');
}

Deno.test('a refused file comes out of the call, a note takes its place, and done names it', async () => {
  registerProfile(mediaProfile('refused_input', true));
  const { events, requests } = await runScript(
    'refused_input',
    { text: 'what is this', attachments: [VIDEO] },
    [REFUSED, ANSWER],
  );
  assertEquals(requests.length, 2);
  assertEquals(mediaOf(requests[1]?.history), []);
  const parts = requests[1]?.history?.at(-1)?.parts ?? [];
  assertEquals(
    parts.some((part) => part.type === 'text' && part.text === '[Unopened video.]'),
    true,
  );
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused : undefined, {
    dropped: [{ mimeType: 'video/mp4', from: 'input' }],
    said: 'HTTP 400: no video here',
  });
});

Deno.test('a visitor never reads what the provider said', () => {
  const done: TurnEvent = {
    type: 'done',
    stop: { kind: 'completed' },
    mediaRefused: { dropped: [{ mimeType: 'video/mp4', from: 'input' }], said: 'HTTP 400' },
  };
  assertEquals(forClient(done), { type: 'done', stop: { kind: 'completed' } });
  assertEquals(forClient(done, { reader: 'builder' }), done);
});

Deno.test("this turn's file goes first, and the conversation's stay", async () => {
  registerProfile(mediaProfile('refused_keeps_history', true));
  const history: TurnHistoryMessage[] = [{ role: 'user', parts: [{ type: 'image', ...PHOTO }] }];
  const { requests } = await runScript(
    'refused_keeps_history',
    { text: 'and this', attachments: [VIDEO], history },
    [REFUSED, ANSWER],
  );
  assertEquals(mediaOf(requests[1]?.history), ['image/png']);
});

Deno.test('with no file this turn, the replayed files come out', async () => {
  registerProfile(mediaProfile('refused_history', true));
  const history: TurnHistoryMessage[] = [{ role: 'user', parts: [{ type: 'video', ...VIDEO }] }];
  const { events, requests } = await runScript('refused_history', { text: 'hi', history }, [
    REFUSED,
    ANSWER,
  ]);
  assertEquals(mediaOf(requests[1]?.history), []);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused?.dropped : undefined, [
    { mimeType: 'video/mp4', from: 'history' },
  ]);
});

Deno.test('a refusal that outlasts the files stays an ordinary failure, once', async () => {
  registerProfile(mediaProfile('refused_anyway', true));
  const { events, requests } = await runScript(
    'refused_anyway',
    { text: 'what is this', attachments: [VIDEO] },
    [REFUSED, REFUSED],
  );
  assertEquals(requests.length, 2);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(errorsOf(events).length, 1);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused : undefined, undefined);
});

Deno.test('a refused call with no file is not sent again', async () => {
  registerProfile(mediaProfile('refused_no_file', true));
  const { requests } = await runScript('refused_no_file', { text: 'hello' }, [REFUSED, ANSWER]);
  assertEquals(requests.length, 1);
});

Deno.test('a profile that sends nothing again leaves a refusal as it is', async () => {
  registerProfile(mediaProfile('refused_no_resend', false));
  const { events, requests } = await runScript(
    'refused_no_resend',
    { text: 'what is this', attachments: [VIDEO] },
    [REFUSED, ANSWER],
  );
  assertEquals(requests.length, 1);
  assertEquals(finalStop(events)?.kind, 'provider_error');
});
