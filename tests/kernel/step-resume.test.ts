import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { withPublicLabels } from '../../src/guardrails/error.ts';
import { labelText } from '../../src/guardrails/labels.ts';
import { foldTurnEvents } from '../../src/interface/blocks.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ProfileTurnResumptionSpec } from '../../src/kernel/stop.ts';
import { keptReply } from '../../src/kernel/turn-events.ts';
import type { ModelEvent, ModelRequest, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { finalStop } from '../fixtures/events.ts';
import { HOST_BINDINGS } from '../fixtures/models.ts';

function resumeProfile(id: string, resumption?: ProfileTurnResumptionSpec) {
  return defineProfile({
    type: 'text',
    identity: { handle: 'test', system: 'test' },
    id,
    models: { gemini35FlashLite: HOST_BINDINGS.gemini35FlashLite },
    maxSteps: 4,
    tools: { allow: ['fetch_sensor'] },
    ...(resumption ? { turnBehaviour: { resumption } } : {}),
    inputs: { text: true },
    guardrails: { quota: { perDay: 100 } },
  });
}

const SENSOR_CALL: ModelEvent[] = [
  {
    type: 'tool',
    tool: { name: 'fetch_sensor', arguments: { sensor: 'soil' }, callId: 'call_1' },
  },
  { type: 'done', stop: { kind: 'tool' } },
];

const BUSY: ModelEvent[] = [
  { type: 'error', errorKind: 'unavailable', errorInternal: 'Gemini HTTP 503: busy' },
];

const CUT_SHORT: ModelEvent[] = [{ type: 'done', stop: { kind: 'stream_incomplete' } }];

const ANSWER: ModelEvent[] = [
  { type: 'text', text: 'Soil reads 22%.' },
  { type: 'done', stop: { kind: 'completed' } },
];

/** Runs the turn against a model that answers each call with the next scripted reply. */
async function runScript(
  profile: string,
  script: ModelEvent[][],
): Promise<{ events: TurnEvent[]; requests: ModelRequest[] }> {
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
  for await (const event of runTurn({ profile, input: { text: 'Check soil' } }, provider)) {
    events.push(event);
  }
  return { events, requests };
}

function replyOf(events: TurnEvent[]): string {
  return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

function errorsOf(events: TurnEvent[]): TurnEvent[] {
  return events.filter((event) => event.type === 'error');
}

function toolMessages(request: ModelRequest | undefined): number {
  return (request?.history ?? []).filter((message) => message.role === 'tool').length;
}

Deno.test('a model call that fails after tool work is sent again, with that work kept', async () => {
  registerProfile(
    resumeProfile('resume_after_tools', {
      autoContinue: ['provider_error'],
      maxContinues: 1,
      partialReply: 'retract',
    }),
  );
  const { events, requests } = await runScript('resume_after_tools', [SENSOR_CALL, BUSY, ANSWER]);
  assertEquals(requests.length, 3);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(replyOf(events), 'Soil reads 22%.');
  assertEquals(errorsOf(events), []);
  assertEquals(toolMessages(requests[1]), 1);
  assertEquals(requests[2]?.history, requests[1]?.history);
});

Deno.test('a model call still failing after maxContinues ends the turn with its failure, once', async () => {
  registerProfile(
    resumeProfile('resume_spent', {
      autoContinue: ['provider_error'],
      maxContinues: 1,
      partialReply: 'retract',
    }),
  );
  const { events, requests } = await runScript('resume_spent', [SENSOR_CALL, BUSY]);
  assertEquals(requests.length, 3);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(
    events.flatMap((event) => (event.type === 'error' ? [event.errorInternal] : [])),
    ['Gemini HTTP 503: busy'],
  );
});

Deno.test('maxContinues counts the re-sends of the whole turn, not of each step', async () => {
  registerProfile(
    resumeProfile('resume_two', {
      autoContinue: ['provider_error'],
      maxContinues: 2,
      partialReply: 'retract',
    }),
  );
  const { events, requests } = await runScript('resume_two', [BUSY, SENSOR_CALL, BUSY, BUSY]);
  assertEquals(requests.length, 4);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(errorsOf(events).length, 1);
});

Deno.test('a provider failure is not sent again unless the profile lists it', async () => {
  registerProfile(resumeProfile('resume_unlisted'));
  const { events, requests } = await runScript('resume_unlisted', [SENSOR_CALL, BUSY]);
  assertEquals(requests.length, 2);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(errorsOf(events).length, 1);
});

Deno.test('a stream that ends with nothing is sent again once when the profile lists it and sets no count', async () => {
  registerProfile(
    resumeProfile('resume_listed', {
      autoContinue: ['stream_incomplete'],
      partialReply: 'retract',
    }),
  );
  const recovered = await runScript('resume_listed', [CUT_SHORT, ANSWER]);
  assertEquals(recovered.requests.length, 2);
  assertEquals(finalStop(recovered.events)?.kind, 'completed');

  const stuck = await runScript('resume_listed', [CUT_SHORT]);
  assertEquals(stuck.requests.length, 2);
  assertEquals(finalStop(stuck.events)?.kind, 'stream_incomplete');
});

Deno.test('a profile that sets no autoContinue sends nothing again, whatever the default list says', async () => {
  registerProfile(resumeProfile('resume_default'));
  const { events, requests } = await runScript('resume_default', [CUT_SHORT, ANSWER]);
  assertEquals(requests.length, 1);
  assertEquals(finalStop(events)?.kind, 'stream_incomplete');
});

Deno.test('a profile that lists no stop to continue is never sent again', async () => {
  registerProfile(resumeProfile('resume_none', { autoContinue: [] }));
  const { events, requests } = await runScript('resume_none', [CUT_SHORT, ANSWER]);
  assertEquals(requests.length, 1);
  assertEquals(finalStop(events)?.kind, 'stream_incomplete');
});

const CITED: ModelEvent = {
  type: 'citation',
  sources: [{ title: 'Soil guide', uri: 'https://example.com/soil', type: 'web' }],
};

const PICTURE: ModelEvent = { type: 'media', media: { mimeType: 'image/png', data: 'AA==' } };

const GOES_ON: ModelEvent[] = [
  { type: 'text', text: ' 22%.' },
  { type: 'done', stop: { kind: 'completed' } },
];

function resendsOf(events: TurnEvent[]) {
  return events.flatMap((event) => (event.type === 'resend' ? [event.reply] : []));
}

function keptText(events: TurnEvent[]): string {
  return replyOf(keptReply(events));
}

Deno.test('retract: a call that failed part-way is sent again as it was, and its words are withdrawn', async () => {
  registerProfile(
    resumeProfile('resume_retract', {
      autoContinue: ['provider_error'],
      maxContinues: 1,
      partialReply: 'retract',
    }),
  );
  const { events, requests } = await runScript('resume_retract', [
    [{ type: 'text', text: 'Soil reads' }, ...BUSY],
    ANSWER,
  ]);
  assertEquals(requests.length, 2);
  assertEquals(requests[1]?.history, requests[0]?.history);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  assertEquals(resendsOf(events), ['retracted']);
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test("retract: the failed call's words are withdrawn, and the sources they cited with them", async () => {
  registerProfile(
    resumeProfile('resume_retract_cited', {
      autoContinue: ['stream_incomplete'],
      partialReply: 'retract',
    }),
  );
  const { events } = await runScript('resume_retract_cited', [
    [{ type: 'text', text: 'Soil reads' }, CITED, ...CUT_SHORT],
    ANSWER,
  ]);
  assertEquals(resendsOf(events), ['retracted']);
  assertEquals(
    keptReply(events).filter((event) => event.type === 'citation'),
    [],
  );
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test('retract: the page and the saved history show the reply once, without the withdrawn words', async () => {
  registerProfile(
    resumeProfile('resume_retract_read', {
      autoContinue: ['provider_error'],
      partialReply: 'retract',
    }),
  );
  const { events } = await runScript('resume_retract_read', [
    [{ type: 'text', text: 'Soil was' }, ...BUSY],
    ANSWER,
  ]);
  const shown = JSON.stringify(foldTurnEvents(events));
  assertEquals(shown.includes('Soil was'), false);
  assertEquals(shown.split('Soil reads 22%.').length - 1, 1);
  assertEquals(
    appendAssistantEventsToHistory([], events).filter((message) => message.role === 'assistant'),
    [{ role: 'assistant', content: 'Soil reads 22%.' }],
  );
});

Deno.test('a failed call that showed nothing is sent again with nothing withdrawn', async () => {
  registerProfile(
    resumeProfile('resume_retract_empty', {
      autoContinue: ['provider_error'],
      partialReply: 'retract',
    }),
  );
  const { events } = await runScript('resume_retract_empty', [BUSY, ANSWER]);
  assertEquals(resendsOf(events), ['unshown']);
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test("continue: the failed call's words stay, and the model reads them with a note and goes on", async () => {
  registerProfile(
    resumeProfile('resume_continue', {
      autoContinue: ['provider_error'],
      maxContinues: 1,
      partialReply: 'continue',
    }),
  );
  const { events, requests } = await runScript('resume_continue', [
    [{ type: 'text', text: 'Soil reads' }, ...BUSY],
    GOES_ON,
  ]);
  assertEquals(requests.length, 2);
  const before = requests[0]?.history ?? [];
  assertEquals(requests[1]?.history, [
    ...before,
    { role: 'assistant', content: 'Soil reads' },
    { role: 'user', content: labelText('resume.partial_reply') },
  ]);
  assertEquals(finalStop(events)?.kind, 'completed');
  assertEquals(errorsOf(events), []);
  assertEquals(resendsOf(events), ['continued']);
  assertEquals(replyOf(events), 'Soil reads 22%.');
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test('continue: the transcript keeps the notice, and the words stay one block', async () => {
  registerProfile(
    resumeProfile('resume_continue_notice', {
      autoContinue: ['provider_error'],
      partialReply: 'continue',
    }),
  );
  const { events } = await runScript('resume_continue_notice', [
    [{ type: 'text', text: 'Soil reads' }, ...BUSY],
    GOES_ON,
  ]);
  const shown = foldTurnEvents(events.map((event) => withPublicLabels(event)));
  assertEquals(
    shown.flatMap((block): string[] => {
      if (block.kind === 'resumed') return [`resumed: ${block.message}`];
      if (block.kind === 'text') return [`text: ${block.text}`];
      return [];
    }),
    [`resumed: ${labelText('resume.reply_continued')}`, 'text: Soil reads 22%.'],
  );
});

Deno.test('a resend that kept no words shows no notice', () => {
  for (const reply of ['retracted', 'unshown'] as const) {
    const event = withPublicLabels({ type: 'resend', stop: { kind: 'provider_error' }, reply });
    assertEquals('notice' in event, false);
  }
});

Deno.test('continue: a failed call that showed more than words is withdrawn whole and sent again as it was', async () => {
  registerProfile(
    resumeProfile('resume_continue_media', {
      autoContinue: ['provider_error'],
      partialReply: 'continue',
    }),
  );
  const { events, requests } = await runScript('resume_continue_media', [
    [{ type: 'text', text: 'Soil reads' }, PICTURE, ...BUSY],
    ANSWER,
  ]);
  assertEquals(requests[1]?.history, requests[0]?.history);
  assertEquals(resendsOf(events), ['retracted']);
  assertEquals(
    keptReply(events).filter((event) => event.type === 'media'),
    [],
  );
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test('continue: the sources the kept words cite stay with them', async () => {
  registerProfile(
    resumeProfile('resume_continue_cited', {
      autoContinue: ['provider_error'],
      partialReply: 'continue',
    }),
  );
  const { events } = await runScript('resume_continue_cited', [
    [{ type: 'text', text: 'Soil reads' }, CITED, ...BUSY],
    GOES_ON,
  ]);
  assertEquals(resendsOf(events), ['continued']);
  assertEquals(keptReply(events).filter((event) => event.type === 'citation').length, 1);
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test('continue: a failed call that wrote nothing is sent again as it was', async () => {
  registerProfile(
    resumeProfile('resume_continue_empty', {
      autoContinue: ['provider_error'],
      partialReply: 'continue',
    }),
  );
  const { events, requests } = await runScript('resume_continue_empty', [BUSY, ANSWER]);
  assertEquals(requests[1]?.history, requests[0]?.history);
  assertEquals(resendsOf(events), ['unshown']);
  assertEquals(keptText(events), 'Soil reads 22%.');
});

const CHECKING: ModelEvent[] = [{ type: 'text', text: 'Checking.' }, ...SENSOR_CALL];

for (const partialReply of ['retract', 'continue'] as const) {
  Deno.test(`${partialReply}: a later step's failed call leaves the earlier steps' words as they are`, async () => {
    const id = `resume_later_${partialReply}`;
    registerProfile(resumeProfile(id, { autoContinue: ['provider_error'], partialReply }));
    const { events, requests } = await runScript(id, [
      CHECKING,
      [{ type: 'text', text: 'Soil reads' }, ...BUSY],
      partialReply === 'retract' ? ANSWER : GOES_ON,
    ]);
    assertEquals(requests.length, 3);
    assertEquals(finalStop(events)?.kind, 'completed');
    assertEquals(keptText(events), 'Checking.\n\nSoil reads 22%.');
    const afterTool = requests[1]?.history ?? [];
    assertEquals(toolMessages(requests[1]), 1);
    assertEquals(
      requests[2]?.history,
      partialReply === 'retract'
        ? afterTool
        : [
            ...afterTool,
            { role: 'assistant', content: 'Soil reads' },
            { role: 'user', content: labelText('resume.partial_reply') },
          ],
    );
    assertEquals(resendsOf(events), [partialReply === 'retract' ? 'retracted' : 'continued']);
    assertEquals(JSON.stringify(foldTurnEvents(events)).split('Checking.').length - 1, 1);
  });
}

Deno.test('retract: each of two failed calls takes back only its own words', async () => {
  registerProfile(
    resumeProfile('resume_twice_retract', {
      autoContinue: ['provider_error'],
      maxContinues: 2,
      partialReply: 'retract',
    }),
  );
  const { events, requests } = await runScript('resume_twice_retract', [
    [{ type: 'text', text: 'Soil was' }, ...BUSY],
    [{ type: 'text', text: 'Soil is' }, ...BUSY],
    ANSWER,
  ]);
  assertEquals(requests.length, 3);
  assertEquals(requests[2]?.history, requests[0]?.history);
  assertEquals(resendsOf(events), ['retracted', 'retracted']);
  assertEquals(keptText(events), 'Soil reads 22%.');
});

Deno.test('continue: a second failed call that showed a file takes back only itself, and the first words stay', async () => {
  registerProfile(
    resumeProfile('resume_twice_continue', {
      autoContinue: ['provider_error'],
      maxContinues: 2,
      partialReply: 'continue',
    }),
  );
  const { events, requests } = await runScript('resume_twice_continue', [
    [{ type: 'text', text: 'Soil reads' }, ...BUSY],
    [{ type: 'text', text: ' about' }, PICTURE, ...BUSY],
    GOES_ON,
  ]);
  assertEquals(requests.length, 3);
  const withFirst = [
    ...(requests[0]?.history ?? []),
    { role: 'assistant', content: 'Soil reads' },
    { role: 'user', content: labelText('resume.partial_reply') },
  ];
  assertEquals(requests[1]?.history, withFirst);
  assertEquals(requests[2]?.history, withFirst);
  assertEquals(resendsOf(events), ['continued', 'retracted']);
  assertEquals(
    keptReply(events).filter((event) => event.type === 'media'),
    [],
  );
  assertEquals(keptText(events), 'Soil reads 22%.');
});
