import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertStringIncludes } from '@std/assert';
import { labelText } from '../../src/guardrails/labels.ts';
import { ANSWER_TOOL } from '../../src/kernel/answer-tool.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type {
  ModelEvent,
  ModelRequest,
  ProfileValidationSpec,
  TurnEvent,
  TurnEventOf,
  TurnModel,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const CUT = '{"message":"Long';

function cutOffProfile(id: string, validation?: ProfileValidationSpec): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      outputs: { structured: 'chatTurn', ...(validation ? { validation } : {}) },
      guardrails: { quota: { perDay: 100 } },
    }),
  );
  return id;
}

/** Answers each call with the next script, and keeps every request it got. */
function scripted(scripts: ModelEvent[][]): { model: TurnModel; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      async *complete(req) {
        await Promise.resolve();
        requests.push(structuredClone({ ...req, signal: undefined }));
        yield* scripts[Math.min(requests.length - 1, scripts.length - 1)] ?? [];
      },
    },
  };
}

/**
 * A call whose arguments the output limit cut off, as a model's protocol hands it to the runner:
 * its drafts, a bare `bad_response` for the arguments that do not parse, and the `length` stop.
 */
function cutOff(name: string, raw: string): ModelEvent[] {
  const callId = `${name}_cut`;
  const half = Math.floor(raw.length / 2);
  return [
    { type: 'tool_draft', callId, name, text: raw.slice(0, half) },
    { type: 'tool_draft', callId, name, text: raw.slice(half) },
    { type: 'error', errorKind: 'bad_response' },
    { type: 'done', stop: { kind: 'length' } },
  ];
}

const answered = (args: Record<string, unknown>): ModelEvent[] => [
  { type: 'tool_draft', callId: 'answer_1', name: ANSWER_TOOL, text: JSON.stringify(args) },
  { type: 'tool', tool: { name: ANSWER_TOOL, callId: 'answer_1', arguments: args } },
  { type: 'done', stop: { kind: 'tool' } },
];

const of = <K extends TurnEvent['type']>(events: readonly TurnEvent[], type: K) =>
  events.filter((e): e is TurnEventOf<K> => e.type === type);

async function collect(profile: string, model: TurnModel): Promise<TurnEvent[]> {
  return await Array.fromAsync(runTurn({ profile, input: { text: 'Check soil' } }, model));
}

/** The repair the call read: the last message of its history. */
const repairOf = (request: ModelRequest | undefined) => String(request?.history?.at(-1)?.content);

function assertRepaired(events: TurnEvent[], requests: ModelRequest[]): void {
  assertEquals(requests.length, 2);
  assertEquals(
    of(events, 'structured').map((e) => e.structured),
    [{ message: 'Short' }],
  );
  assertEquals(
    of(events, 'attempt').map((e) => e.reason),
    ['validation'],
  );
  const repair = repairOf(requests[1]);
  assertStringIncludes(repair, CUT);
  assertStringIncludes(repair, labelText('structured.cut_off'));
  assertStringIncludes(repair, labelText('repair.cut_off_guidance'));
  // invariant: The repair adds to what the cut-off call read; it drops nothing.
  const first = requests[0]?.history ?? [];
  assertEquals(requests[1]?.history?.slice(0, first.length), first);
  assertEquals(requests[1]?.system, requests[0]?.system);
  assertEquals(
    requests[1]?.wireTools?.map((tool) => tool.name),
    requests[0]?.wireTools?.map((tool) => tool.name),
  );
  assertEquals(of(events, 'error'), []);
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'completed');
}

Deno.test('an answer cut off at the output limit is sent back with what it wrote, and the retry answers', async () => {
  const { model, requests } = scripted([cutOff(ANSWER_TOOL, CUT), answered({ message: 'Short' })]);
  const events = await collect(cutOffProfile('cut_answer', { maxRetries: 1 }), model);
  assertRepaired(events, requests);
});

Deno.test('a cut-off answer is repaired once on a profile without validation', async () => {
  const { model, requests } = scripted([cutOff(ANSWER_TOOL, CUT), answered({ message: 'Short' })]);
  const events = await collect(cutOffProfile('cut_answer_default'), model);
  assertRepaired(events, requests);
});

Deno.test('an answer cut off again fails as a bad response, with no structured output', async () => {
  const { model, requests } = scripted([cutOff(ANSWER_TOOL, CUT)]);
  const events = await collect(cutOffProfile('cut_answer_twice'), model);
  assertEquals(requests.length, 2);
  assertEquals(of(events, 'structured'), []);
  assertEquals(
    of(events, 'error').map((e) => e.errorKind),
    ['bad_response'],
  );
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'provider_error');
});

Deno.test('validation.maxRetries raises how many times a cut-off answer is repaired', async () => {
  const { model, requests } = scripted([cutOff(ANSWER_TOOL, CUT)]);
  const events = await collect(cutOffProfile('cut_answer_budget', { maxRetries: 2 }), model);
  assertEquals(requests.length, 3);
  assertEquals(
    of(events, 'attempt').map((e) => e.reason),
    ['validation', 'validation'],
  );
  assertEquals(
    of(events, 'error').map((e) => e.errorKind),
    ['bad_response'],
  );
});

Deno.test('a reply cut off inside another tool call does not start the cut-off repair', async () => {
  const { model, requests } = scripted([cutOff('fetch_sensor', '{"sensor":"so')]);
  const events = await collect(cutOffProfile('cut_other_tool'), model);
  assertEquals(requests.length, 1);
  assertEquals(of(events, 'attempt'), []);
  assertEquals(
    of(events, 'error').map((e) => e.errorKind),
    ['bad_response'],
  );
});
