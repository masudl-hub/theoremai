import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertStringIncludes } from '@std/assert';
import { bearer, createKernelScope, defineProvider, openAi, z } from '../../mod.ts';
import { labelText } from '../../src/guardrails/labels.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import { keptReply } from '../../src/kernel/turn-events.ts';
import type {
  ContinueStopKind,
  ModelEvent,
  ModelRequest,
  TurnEvent,
  TurnEventOf,
  TurnModel,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const CUT = 'Repot in spring, when the roots';

function textProfile(id: string, autoContinue: ContinueStopKind[] = ['length']): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 3,
      tools: { allow: ['fetch_sensor'] },
      inputs: { text: true },
      outputs: {},
      turnBehaviour: { resumption: { autoContinue } },
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

const cutText: ModelEvent[] = [
  { type: 'text', text: CUT },
  { type: 'done', stop: { kind: 'length' } },
];

const replied: ModelEvent[] = [
  { type: 'text', text: 'Repot in spring.' },
  { type: 'done', stop: { kind: 'completed' } },
];

const of = <K extends TurnEvent['type']>(events: readonly TurnEvent[], type: K) =>
  events.filter((e): e is TurnEventOf<K> => e.type === type);

async function collect(profile: string, model: TurnModel): Promise<TurnEvent[]> {
  return await Array.fromAsync(runTurn({ profile, input: { text: 'Repotting?' } }, model));
}

/** The repair the call read: the last message of its history. */
const repairOf = (request: ModelRequest | undefined) => String(request?.history?.at(-1)?.content);

const replyText = (events: TurnEvent[]) =>
  of(keptReply(events), 'text')
    .map((e) => e.text)
    .join('');

Deno.test('a text reply cut off at the output limit is sent back with what it wrote, and the retry replies', async () => {
  const { model, requests } = scripted([cutText, replied]);
  const events = await collect(textProfile('cut_text'), model);
  assertEquals(requests.length, 2);
  const repair = repairOf(requests[1]);
  assertStringIncludes(repair, CUT);
  assertStringIncludes(repair, labelText('repair.reply_cut_off'));
  assertStringIncludes(repair, labelText('repair.cut_off_guidance'));
  assertEquals(
    of(events, 'attempt').map((e) => e.reason),
    ['validation'],
  );
  assertEquals(replyText(events), 'Repot in spring.');
  assertEquals(of(events, 'error'), []);
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'completed');
});

Deno.test('a text reply cut off again keeps its text and stops at length', async () => {
  const { model, requests } = scripted([cutText]);
  const events = await collect(textProfile('cut_text_twice'), model);
  assertEquals(requests.length, 2);
  assertEquals(replyText(events), CUT);
  assertEquals(of(events, 'error'), []);
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'length');
});

Deno.test('a tool call cut off on a text turn is sent back with its arguments', async () => {
  const raw = '{"sensor":"so';
  const { model, requests } = scripted([
    [
      { type: 'tool_draft', callId: 'cut_1', name: 'fetch_sensor', text: raw },
      { type: 'error', errorKind: 'bad_response' },
      { type: 'done', stop: { kind: 'length' } },
    ],
    replied,
  ]);
  const events = await collect(textProfile('cut_text_call'), model);
  assertEquals(requests.length, 2);
  const repair = repairOf(requests[1]);
  assertStringIncludes(repair, raw);
  assertStringIncludes(repair, labelText('repair.call_cut_off', { tool: 'fetch_sensor' }));
  assertStringIncludes(repair, labelText('repair.call_cut_off_guidance', { tool: 'fetch_sensor' }));
  assertEquals(replyText(events), 'Repot in spring.');
  assertEquals(of(events, 'error'), []);
});

Deno.test('a call that wrote nothing before the output limit is told so, and the retry replies', async () => {
  const { model, requests } = scripted([
    [
      { type: 'thought', text: 'Thinking about pots.' },
      { type: 'done', stop: { kind: 'length' } },
    ],
    replied,
  ]);
  const events = await collect(textProfile('cut_text_empty'), model);
  assertEquals(requests.length, 2);
  const repair = repairOf(requests[1]);
  assertStringIncludes(repair, labelText('repair.nothing_written'));
  assertStringIncludes(repair, labelText('repair.nothing_written_guidance'));
  assertEquals(replyText(events), 'Repot in spring.');
  assertEquals(of(events, 'error'), []);
});

Deno.test('a call that wrote nothing again fails as a bad response', async () => {
  const { model, requests } = scripted([[{ type: 'done', stop: { kind: 'length' } }]]);
  const events = await collect(textProfile('cut_text_empty_twice'), model);
  assertEquals(requests.length, 2);
  assertEquals(
    of(events, 'error').map((e) => e.errorKind),
    ['bad_response'],
  );
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'provider_error');
});

Deno.test('a reply cut off after a tool ran keeps the tool result and does not run the tool again', async () => {
  const { model, requests } = scripted([
    [
      {
        type: 'tool',
        tool: { name: 'fetch_sensor', callId: 'sensor_1', arguments: { sensor: 'soil' } },
      },
      { type: 'done', stop: { kind: 'tool' } },
    ],
    cutText,
    replied,
  ]);
  const events = await collect(textProfile('cut_text_after_tool'), model);
  assertEquals(requests.length, 3);
  assertEquals(of(events, 'tool').filter((e) => e.tool.phase === 'complete').length, 1);
  // invariant: The repair adds to what the cut-off call read; it drops nothing.
  const cutCall = requests[1]?.history ?? [];
  assertEquals(requests[2]?.history?.slice(0, cutCall.length), cutCall);
  assertStringIncludes(JSON.stringify(cutCall), 'Sensor raw value: 22%');
  assertStringIncludes(repairOf(requests[2]), CUT);
  assertEquals(replyText(events), 'Repot in spring.');
});

Deno.test('a Chat Completions call cut off inside a tool call sends back every character it wrote', async () => {
  const scope = createKernelScope();
  const provider = scope.providers.register(
    defineProvider({
      id: 'cut-compatible',
      name: 'Cut',
      description: 'Cuts a tool call at the output limit',
      key: z.string(),
      authorize: bearer(),
      serves: () => [{ protocol: openAi, baseUrl: 'https://cut.test/v1' }],
    }),
    { keySlot: 'main' },
  );
  scope.tools.register({
    type: 'function',
    name: 'write_note',
    description: 'Writes a note.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ body: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
  scope.profiles.register(
    defineProfile({
      id: 'cut.compatible',
      type: 'text',
      identity: { handle: 'Cut' },
      models: { main: provider.model(openAi, 'm') },
      inputs: { text: true },
      tools: { allow: ['write_note'] },
      maxSteps: 3,
      turnBehaviour: { resumption: { autoContinue: ['length'] } },
    }),
  );
  const row = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const sse = (rows: unknown[]) =>
    new Response(`${rows.map(row).join('')}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  const call = (args: string, finish?: string) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'wire-1', function: { name: 'write_note', arguments: args } },
          ],
        },
        ...(finish ? { finish_reason: finish } : {}),
      },
    ],
  });
  const sent: { messages: { content?: string }[] }[] = [];
  const send: typeof fetch = (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      sent.length === 1
        ? sse([{ id: 'r-1', ...call('{"bo') }, call('dy":"Rep', 'length')])
        : sse([{ id: 'r-2', choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }]),
    );
  };
  const events = await Array.fromAsync(
    scope.runTurn(
      { profile: 'cut.compatible', input: { text: 'Write a note on repotting.' } },
      { fetch: send, vault: { main: 'fixture-key' }, wait: () => Promise.resolve() },
    ),
  );
  assertEquals(sent.length, 2);
  const repair = String(sent[1]?.messages.at(-1)?.content);
  assertStringIncludes(repair, '{"body":"Rep');
  assertStringIncludes(repair, labelText('repair.call_cut_off', { tool: 'write_note' }));
  assertEquals(replyText(events), 'Done.');
  assertEquals(of(events, 'error'), []);
});

Deno.test('a text reply cut off is not repaired when autoContinue does not name length', async () => {
  const { model, requests } = scripted([cutText, replied]);
  const events = await collect(textProfile('cut_text_off', ['provider_error']), model);
  assertEquals(requests.length, 1);
  assertEquals(of(events, 'attempt'), []);
  assertEquals(replyText(events), CUT);
  assertEquals(of(events, 'done').at(-1)?.stop.kind, 'length');
});

Deno.test('a call that wrote nothing is not repaired on a profile with no autoContinue', async () => {
  const { model, requests } = scripted([[{ type: 'done', stop: { kind: 'length' } }], replied]);
  const events = await collect(textProfile('cut_empty_off', []), model);
  assertEquals(requests.length, 1);
  assertEquals(of(events, 'attempt'), []);
});
