import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertRejects } from '@std/assert';
import { z } from 'zod';
import { ANSWER_TOOL } from '../../src/kernel/answer-tool.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
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

function registerAnswerProfile(
  id: string,
  options: { tools?: string[]; validation?: ProfileValidationSpec } = {},
): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: options.tools ?? ['fetch_sensor'] },
      inputs: { text: true },
      outputs: {
        structured: 'chatTurn',
        ...(options.validation ? { validation: options.validation } : {}),
      },
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
        requests.push(req);
        yield* scripts[Math.min(requests.length - 1, scripts.length - 1)] ?? [];
      },
    },
  };
}

function call(name: string, args: Record<string, unknown>, callId = `${name}_1`): ModelEvent {
  return { type: 'tool', tool: { name, callId, arguments: args } };
}

const answered = (args: Record<string, unknown>): ModelEvent[] => [
  { type: 'tool_draft', callId: 'answer_1', name: ANSWER_TOOL, text: JSON.stringify(args) },
  call(ANSWER_TOOL, args, 'answer_1'),
  { type: 'done', stop: { kind: 'tool' } },
];

const of = <K extends TurnEvent['type']>(events: readonly TurnEvent[], type: K) =>
  events.filter((e): e is TurnEventOf<K> => e.type === type);

async function collect(profile: string, model: TurnModel): Promise<TurnEvent[]> {
  return await Array.fromAsync(runTurn({ profile, input: { text: 'Check soil' } }, model));
}

Deno.test('a structured turn with tools offers the answer tool in place of a response format', async () => {
  const { model, requests } = scripted([answered({ message: 'Dry' })]);
  await collect(registerAnswerProfile('answer_offered'), model);
  const [request] = requests;
  assertEquals(request?.structured, null);
  const tool = request?.wireTools?.find((t) => t.name === ANSWER_TOOL);
  assertEquals(tool?.parameters, {
    type: 'object',
    properties: { message: { type: 'string' }, body: { type: 'string' } },
    required: ['message'],
  });
});

Deno.test('text streams as progress, and the answer tool drafts and gives the structured output', async () => {
  const { model } = scripted([
    [
      { type: 'text', text: 'Reading the sensor.' },
      call('fetch_sensor', { sensor: 'soil' }),
      { type: 'done', stop: { kind: 'tool' } },
    ],
    [{ type: 'text', text: 'It is dry.' }, ...answered({ message: 'Dry' })],
  ]);
  const events = await collect(registerAnswerProfile('answer_progress'), model);
  assertEquals(
    of(events, 'text')
      .map((e) => e.text)
      .join(''),
    'Reading the sensor.\n\nIt is dry.',
  );
  assertEquals(
    of(events, 'structured_draft')
      .map((e) => e.text)
      .join(''),
    '{"message":"Dry"}',
  );
  assertEquals(
    of(events, 'structured').map((e) => e.structured),
    [{ message: 'Dry' }],
  );
  assertEquals([...new Set(of(events, 'tool').map((e) => e.tool.name))], ['fetch_sensor']);
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'completed');
  assertEquals(
    events.some((e) => e.type === 'tool_draft'),
    false,
  );
});

Deno.test('an answer ends the turn: the calls beside it do not run', async () => {
  const { model, requests } = scripted([
    [
      call('fetch_sensor', { sensor: 'soil' }),
      call(ANSWER_TOOL, { message: 'Wet' }, 'answer_1'),
      { type: 'done', stop: { kind: 'tool' } },
    ],
  ]);
  const events = await collect(registerAnswerProfile('answer_ends'), model);
  assertEquals(requests.length, 1);
  assertEquals(of(events, 'tool'), []);
  assertEquals(
    of(events, 'structured').map((e) => e.structured),
    [{ message: 'Wet' }],
  );
});

Deno.test('the step that must answer keeps the answer tool when its own tools are gone', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'answer_last_step',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      outputs: { structured: 'chatTurn' },
      turnBehaviour: { atStepLimit: 'answer' },
      guardrails: { quota: { perDay: 100 } },
    }),
  );
  const { model, requests } = scripted([
    [call('fetch_sensor', { sensor: 'soil' }), { type: 'done', stop: { kind: 'tool' } }],
    answered({ message: 'Dry' }),
  ]);
  const events = await collect('answer_last_step', model);
  assertEquals(
    requests[1]?.wireTools?.map((t) => t.name),
    [ANSWER_TOOL],
  );
  assertEquals(requests[1]?.structured, null);
  assertEquals(
    of(events, 'structured').map((e) => e.structured),
    [{ message: 'Dry' }],
  );
});

Deno.test('a reply that never calls the answer tool fails as a bad response', async () => {
  const { model } = scripted([
    [
      { type: 'text', text: 'It is dry.' },
      { type: 'done', stop: { kind: 'completed' } },
    ],
  ]);
  const events = await collect(registerAnswerProfile('answer_missing'), model);
  assertEquals(
    of(events, 'error').map((e) => e.errorKind),
    ['bad_response'],
  );
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'provider_error');
});

Deno.test('with a validation retry left, a missed answer is repaired', async () => {
  const { model, requests } = scripted([
    [
      { type: 'text', text: 'It is dry.' },
      { type: 'done', stop: { kind: 'completed' } },
    ],
    answered({ message: 'Dry' }),
  ]);
  const events = await collect(
    registerAnswerProfile('answer_repaired', { validation: { maxRetries: 1 } }),
    model,
  );
  assertEquals(
    of(events, 'attempt').map((e) => e.reason),
    ['validation'],
  );
  assertEquals(JSON.stringify(requests[1]?.history).includes(ANSWER_TOOL), true);
  assertEquals(
    of(events, 'structured').map((e) => e.structured),
    [{ message: 'Dry' }],
  );
  assertEquals(of(events, 'error'), []);
});

Deno.test('a structured turn without tools keeps its response format', async () => {
  const { model, requests } = scripted([
    [
      { type: 'text', text: '{"message":"Hi"}' },
      { type: 'structured', structured: { message: 'Hi' } },
      { type: 'done', stop: { kind: 'completed' } },
    ],
  ]);
  const events = await collect(registerAnswerProfile('answer_native', { tools: [] }), model);
  assertEquals(requests[0]?.structured?.id, 'chatTurn');
  assertEquals(requests[0]?.wireTools?.some((t) => t.name === ANSWER_TOOL) ?? false, false);
  assertEquals(
    of(events, 'structured_draft')
      .map((e) => e.text)
      .join(''),
    '{"message":"Hi"}',
  );
});

Deno.test('a structured profile cannot offer a tool of its own named as the answer tool', async () => {
  registerTool({
    type: 'function',
    name: ANSWER_TOOL,
    description: 'A host tool',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({}),
    output: z.object({}),
    handler: () => ({}),
  });
  const { model } = scripted([answered({ message: 'Dry' })]);
  await assertRejects(
    () => collect(registerAnswerProfile('answer_clash', { tools: [ANSWER_TOOL] }), model),
    Error,
    `answers through '${ANSWER_TOOL}'`,
  );
});
