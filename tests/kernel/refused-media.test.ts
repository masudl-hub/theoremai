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

Deno.test('a visitor never reads the types the provider refused', () => {
  const error: TurnEvent = {
    type: 'error',
    errorKind: 'unsupported',
    error: 'That file could not be opened.',
    errorInternal: "Unsupported mime_type 'text/plain' in document content.",
    refusedMedia: ['text/plain'],
  };
  assertEquals(forClient(error), {
    type: 'error',
    errorKind: 'unsupported',
    error: 'That file could not be opened.',
  });
  const builder = forClient(error, { reader: 'builder' });
  assertEquals(builder.type === 'error' ? builder.refusedMedia : undefined, ['text/plain']);
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

const PLAIN = { mimeType: 'text/plain', data: btoa('plain words') };
const NOTES = { mimeType: 'text/markdown', data: btoa('# notes') };
const SHEET = { mimeType: 'text/csv', data: btoa('a,b\n1,2') };

function refusing(type: string): ModelEvent[] {
  return [
    {
      type: 'error',
      errorKind: 'unsupported',
      errorInternal: `Unsupported mime_type '${type}' in document content.`,
      refusedMedia: [type],
    },
  ];
}

function documentProfile(id: string) {
  return defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id,
    models: { gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite },
    maxSteps: 4,
    tools: { allow: [] },
    turnBehaviour: { resumption: { autoContinue: ['provider_error' as const] } },
    inputs: {
      text: true,
      attachments: { accept: ['text/plain', 'text/markdown', 'text/csv'] },
      maxFiles: 4,
      maxBytes: 1_000,
      maxTurnBytes: 4_000,
    },
    guardrails: { quota: { perDay: 100 } },
  });
}

Deno.test('a type the provider names comes out alone; the other files stay', async () => {
  registerProfile(documentProfile('refused_named'));
  const { events, requests } = await runScript(
    'refused_named',
    { text: 'read these', attachments: [PLAIN, SHEET] },
    [refusing('text/plain'), ANSWER],
  );
  assertEquals(requests.length, 2);
  assertEquals(mediaOf(requests[1]?.history), ['text/csv']);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused?.dropped : undefined, [
    { mimeType: 'text/plain', from: 'input' },
  ]);
});

Deno.test('a named type comes out of the replayed messages too, in any case', async () => {
  registerProfile(documentProfile('refused_named_history'));
  const history: TurnHistoryMessage[] = [
    { role: 'user', parts: [{ type: 'document', mimeType: 'Text/Plain', data: PLAIN.data }] },
  ];
  const { events, requests } = await runScript(
    'refused_named_history',
    { text: 'and this', attachments: [PLAIN, SHEET], history },
    [refusing('text/plain'), ANSWER],
  );
  assertEquals(mediaOf(requests[1]?.history), ['text/csv']);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused?.dropped : undefined, [
    { mimeType: 'Text/Plain', from: 'history' },
    { mimeType: 'text/plain', from: 'input' },
  ]);
});

Deno.test('each type the provider names is one more send, and done names them all', async () => {
  registerProfile(documentProfile('refused_two_types'));
  const { events, requests } = await runScript(
    'refused_two_types',
    { text: 'read these', attachments: [PLAIN, NOTES, SHEET] },
    [refusing('text/plain'), refusing('text/markdown'), ANSWER],
  );
  assertEquals(requests.length, 3);
  assertEquals(mediaOf(requests[1]?.history), ['text/markdown', 'text/csv']);
  assertEquals(mediaOf(requests[2]?.history), ['text/csv']);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused : undefined, {
    dropped: [
      { mimeType: 'text/plain', from: 'input' },
      { mimeType: 'text/markdown', from: 'input' },
    ],
    said: [
      "Unsupported mime_type 'text/plain' in document content.",
      "Unsupported mime_type 'text/markdown' in document content.",
    ].join('\n'),
  });
});

Deno.test('a named type no message holds is not sent again', async () => {
  registerProfile(documentProfile('refused_named_absent'));
  const { events, requests } = await runScript(
    'refused_named_absent',
    { text: 'read this', attachments: [SHEET] },
    [refusing('text/plain'), ANSWER],
  );
  assertEquals(requests.length, 1);
  assertEquals(finalStop(events)?.kind, 'provider_error');
});

Deno.test('the same type named twice is not sent a third time', async () => {
  registerProfile(documentProfile('refused_named_again'));
  const { events, requests } = await runScript(
    'refused_named_again',
    { text: 'read these', attachments: [PLAIN, SHEET] },
    [refusing('text/plain'), refusing('text/plain'), ANSWER],
  );
  assertEquals(requests.length, 2);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(errorsOf(events).length, 1);
});

Deno.test('a failure after a named drop keeps that file out, and done still names it', async () => {
  registerProfile(documentProfile('refused_named_then_down'));
  const DOWN: ModelEvent[] = [
    { type: 'error', errorKind: 'unsupported', errorInternal: 'HTTP 400: something else' },
  ];
  const { events, requests } = await runScript(
    'refused_named_then_down',
    { text: 'read these', attachments: [PLAIN, SHEET] },
    [refusing('text/plain'), DOWN],
  );
  assertEquals(requests.length, 2);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused?.dropped : undefined, [
    { mimeType: 'text/plain', from: 'input' },
  ]);
});

function strictProfile(id: string, inputs: Record<string, unknown>) {
  return defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id,
    models: { gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite },
    maxSteps: 4,
    tools: { allow: [] },
    inputs: { maxFiles: 3, maxBytes: 6, maxTurnBytes: 12, ...inputs },
    labels: {
      'turn.media_refused_image': '[Unopened photo.]',
      'turn.media_refused_video': '[Unopened video.]',
      'turn.media_refused_file': '[Unopened file.]',
    },
    guardrails: { quota: { perDay: 100 } },
  });
}

/** A message of only text comes to the model as its `content`. */
function notesOf(request: ModelRequest | undefined): string[] {
  const message = request?.history?.at(-1);
  const texts = message?.parts
    ? message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
    : typeof message?.content === 'string'
      ? message.content.split('\n\n')
      : [];
  return texts.filter((text) => text.startsWith('[Unopened'));
}

Deno.test('a file the profile does not take is left out before the call, and the turn goes on', async () => {
  registerProfile(
    strictProfile('left_out', { text: true, attachments: { accept: ['image/png'] } }),
  );
  const svg = { mimeType: 'image/svg+xml', data: 'AAAA' };
  const big = { mimeType: 'image/png', data: 'AAAAAAAAAAAA' };
  const ref = { mimeType: 'application/pdf', uri: 'files/1' };
  const { events, requests } = await runScript(
    'left_out',
    { text: 'look', attachments: [PHOTO, svg, big, ref], voice: [PHOTO] },
    [ANSWER],
  );
  assertEquals(requests.length, 1);
  assertEquals(mediaOf(requests[0]?.history), ['image/png']);
  assertEquals(notesOf(requests[0]), [
    '[Unopened photo.]',
    '[Unopened photo.]',
    '[Unopened file.]',
    '[Unopened photo.]',
  ]);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused : undefined, {
    dropped: [
      { mimeType: 'image/svg+xml', from: 'input' },
      { mimeType: 'image/png', from: 'input' },
      { mimeType: 'application/pdf', from: 'input' },
      { mimeType: 'image/png', from: 'input' },
    ],
    said: [
      'image/svg+xml: mime_not_allowed',
      'image/png: file_too_large',
      'application/pdf: mime_not_allowed',
      'image/png: voice_not_accepted',
    ].join('\n'),
  });
});

Deno.test('a turn whose only file is left out still runs, with or without text', async () => {
  registerProfile(
    strictProfile('left_alone', { text: true, attachments: { accept: ['image/png'] } }),
  );
  registerProfile(
    strictProfile('left_mute', { text: false, attachments: { accept: ['image/png'] } }),
  );
  for (const [profile, input] of [
    ['left_alone', { attachments: [{ mimeType: 'video/mp4', data: 'AAAA' }] }],
    ['left_alone', { voice: [{ mimeType: 'audio/wav', data: 'AAAA' }] }],
    ['left_alone', { attachments: [{ mimeType: 'not a type', data: 'AAAA' }] }],
    ['left_mute', { attachments: [{ mimeType: 'image/gif', uri: 'files/2' }] }],
  ] as Array<[string, TurnInput]>) {
    const { events, requests } = await runScript(profile, input, [ANSWER]);
    assertEquals(requests.length, 1);
    assertEquals(mediaOf(requests[0]?.history), []);
    assertEquals(notesOf(requests[0]).length, 1);
    assertEquals(finalStop(events)?.kind, 'completed');
  }
});

Deno.test('what names no one file still refuses the turn, counted over the files kept', async () => {
  registerProfile(
    strictProfile('left_count', { text: true, attachments: { accept: ['image/png'] } }),
  );
  const gif = { mimeType: 'image/gif', data: 'AAAA' };
  const kept = await runScript('left_count', { attachments: [PHOTO, PHOTO, PHOTO, gif] }, [ANSWER]);
  assertEquals(mediaOf(kept.requests[0]?.history), ['image/png', 'image/png', 'image/png']);
  assertEquals(finalStop(kept.events)?.kind, 'completed');
  let thrown = '';
  try {
    await runScript('left_count', { attachments: [PHOTO, PHOTO, PHOTO, PHOTO] }, [ANSWER]);
  } catch (err) {
    thrown = (err as Error).message;
  }
  assertEquals(thrown, 'attachments refused: too_many_files');
});

Deno.test('a file left out and a file the provider refused are both reported, in that order', async () => {
  registerProfile(mediaProfile('left_and_refused', true));
  const { events } = await runScript(
    'left_and_refused',
    { text: 'what', attachments: [VIDEO, { mimeType: 'image/gif', data: 'AAAA' }] },
    [REFUSED, ANSWER],
  );
  assertEquals(finalStop(events)?.kind, 'completed');
  const done = doneOf(events);
  assertEquals(done?.type === 'done' ? done.mediaRefused : undefined, {
    dropped: [
      { mimeType: 'image/gif', from: 'input' },
      { mimeType: 'video/mp4', from: 'input' },
    ],
    said: 'image/gif: mime_not_allowed\nHTTP 400: no video here',
  });
});
