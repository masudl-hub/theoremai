import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ProfileTurnResumptionSpec } from '../../src/kernel/stop.ts';
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
    resumeProfile('resume_after_tools', { autoContinue: ['provider_error'], maxContinues: 1 }),
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
    resumeProfile('resume_spent', { autoContinue: ['provider_error'], maxContinues: 1 }),
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
    resumeProfile('resume_two', { autoContinue: ['provider_error'], maxContinues: 2 }),
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
  registerProfile(resumeProfile('resume_listed', { autoContinue: ['stream_incomplete'] }));
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

Deno.test('a call that failed part-way through its reply is left for the host to continue', async () => {
  registerProfile(
    resumeProfile('resume_partial', { autoContinue: ['provider_error'], maxContinues: 1 }),
  );
  const { events, requests } = await runScript('resume_partial', [
    [{ type: 'text', text: 'Soil reads' }, ...BUSY],
    ANSWER,
  ]);
  assertEquals(requests.length, 1);
  assertEquals(finalStop(events)?.kind, 'provider_error');
  assertEquals(replyOf(events), 'Soil reads');
  assertEquals(errorsOf(events).length, 1);
});
