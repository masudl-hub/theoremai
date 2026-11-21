import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { z } from 'zod';
import type { DetectSpec, HostFind } from '../../src/guardrails/detectors.ts';
import { registerProfile, registerTool } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { StageContext, StageResult } from '../../src/kernel/stages.ts';
import { applyStageResult } from '../../src/kernel/stages.ts';
import type {
  ModelRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnInput,
  TurnModel,
} from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';

const SAVE = 'context_test_save';
const NOTE = 'context_test_note';
const ONE_AT_A_TIME = 'context_test_caller';
const SIDE_BY_SIDE = 'context_test_parallel';
const NO_SERVER = 'context_test_client_only';
const BLOCKS = 'context_test_blocks';
const PROVIDER_HELD = 'context_test_provider_held';
const PICTURES = 'context_test_pictures';

const OPENING = '<turn_context from="server">\nplants: 24\n</turn_context>';
const REPLACED = '<turn_context from="server">\nplants: 25\n</turn_context>';

for (const name of [SAVE, NOTE]) {
  registerTool({
    type: 'function',
    name,
    description: 'Saves a plant.',
    category: 'test',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({ val: z.number() }),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'saved' }),
  });
}

/** A `find` that matches all of a text naming `word`. */
function findWord(word: string): HostFind {
  return (text) => (text.includes(word) ? [{ start: 0, end: text.length }] : []);
}

function define(
  id: string,
  options: {
    parallel?: boolean;
    from?: Array<'client' | 'server'>;
    detect?: DetectSpec;
    providerHeld?: true;
    pictures?: true;
  } = {},
): void {
  registerProfile(
    defineProfile({
      type: 'text',
      id,
      identity: { handle: id },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 4,
      tools: { allow: [SAVE, NOTE], parallel: options.parallel ?? false },
      inputs: {
        text: true,
        context: { from: options.from ?? ['client', 'server'], maxChars: 40 },
        ...(options.pictures
          ? {
              attachments: { accept: ['image/png'] },
              maxFiles: 1,
              maxBytes: 1_000_000,
              maxTurnBytes: 1_000_000,
            }
          : {}),
      },
      outputs: {},
      guardrails: {
        quota: { perDay: 500 },
        ...(options.detect ? { detect: options.detect } : {}),
      },
      ...(options.providerHeld ? { providerContinuation: { history: 'provider' as const } } : {}),
    }),
  );
}

define(ONE_AT_A_TIME);
define(SIDE_BY_SIDE, { parallel: true });
define(NO_SERVER, { from: ['client'] });
define(BLOCKS, {
  detect: { 'test.own': { label: 'Test', at: { context: 'block' }, find: findWord('forbidden') } },
});
define(PROVIDER_HELD, { providerHeld: true });
define(PICTURES, { pictures: true });

/** A model that calls `calls` in its first step and answers in its second, keeping each request. */
function saver(calls: readonly string[]): { model: TurnModel; sent: ModelRequest[] } {
  const sent: ModelRequest[] = [];
  return {
    sent,
    model: {
      async *complete(req) {
        await Promise.resolve();
        sent.push(req);
        if (sent.length === 1) {
          for (const [index, name] of calls.entries()) {
            yield { type: 'tool', tool: { name, arguments: { val: 1 }, callId: `c${index}` } };
          }
          return;
        }
        yield { type: 'text', text: 'Saved.' };
      },
    },
  };
}

/** Runs one turn whose `post_tool` returns `answer(ctx)`; returns its events and each request. */
async function contextTurn(
  profile: string,
  calls: readonly string[],
  answer: (ctx: StageContext) => StageResult | undefined,
  input: TurnInput = { text: 'Add Monty', context: { server: 'plants: 24' } },
) {
  const { model, sent } = saver(calls);
  const events: TurnEvent[] = await Array.fromAsync(
    runTurn(
      {
        profile,
        input,
        onStage: (ctx) => (ctx.stage === 'post_tool' ? answer(ctx) : undefined),
      },
      model,
    ),
  );
  return { events, sent };
}

/** The text of the turn's opening message as the request at `step` (0-based) sent it. */
function openingText(sent: readonly ModelRequest[], step: number): string {
  const message: TurnHistoryMessage | undefined = sent[step]?.history?.find(
    (each) => each.role === 'user',
  );
  assert(message);
  if (message.parts === undefined) return message.content ?? '';
  const first = message.parts[0];
  return first?.type === 'text' ? first.text : '';
}

function replacedEvents(events: readonly TurnEvent[]) {
  return events.filter((e) => e.type === 'stage' && e.contextReplaced === true);
}

/** The id the turn gave the model's call to `name`. */
function callIdOf(events: readonly TurnEvent[], name: string): string | undefined {
  for (const e of events) {
    if (e.type === 'tool' && e.tool.phase === undefined && e.tool.name === name)
      return e.tool.callId;
  }
  return undefined;
}

function warningCodes(events: readonly TurnEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === 'stage' ? (e.stageWarnings ?? []).map((w) => w.code) : [],
  );
}

Deno.test('context: the next model step reads the new host context in place of the old', async () => {
  const { events, sent } = await contextTurn(ONE_AT_A_TIME, [SAVE], () => ({
    context: { server: 'plants: 25' },
  }));
  assertEquals(sent.length, 2);
  assertEquals(openingText(sent, 0), `${OPENING}\n\n<user_data>\nAdd Monty\n</user_data>`);
  assertEquals(openingText(sent, 1), `${REPLACED}\n\n<user_data>\nAdd Monty\n</user_data>`);
  const replaced = replacedEvents(events);
  assertEquals(replaced.length, 1);
  assert(replaced[0]?.type === 'stage');
  assertEquals(
    [replaced[0].stage, replaced[0].callId, replaced[0].toolName],
    ['post_tool', callIdOf(events, SAVE), SAVE],
  );
  assertEquals(warningCodes(events), []);
});

Deno.test("context: the page's context stays where it stands", async () => {
  const { sent } = await contextTurn(
    ONE_AT_A_TIME,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    { text: 'Add Monty', context: { server: 'plants: 24', client: 'page: home' } },
  );
  assertEquals(
    openingText(sent, 1),
    [
      REPLACED,
      '<turn_context from="client">\npage: home\n</turn_context>',
      '<user_data>\nAdd Monty\n</user_data>',
    ].join('\n\n'),
  );
});

Deno.test('context: with no host context at the start, the new one goes first', async () => {
  const { sent } = await contextTurn(
    ONE_AT_A_TIME,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    { text: 'Add Monty' },
  );
  assertEquals(openingText(sent, 1), `${REPLACED}\n\n<user_data>\nAdd Monty\n</user_data>`);
});

for (const [label, profile] of [
  ['one at a time', ONE_AT_A_TIME],
  ['side by side', SIDE_BY_SIDE],
] as const) {
  Deno.test(`context: once a step, the last call's lands (${label})`, async () => {
    const { events, sent } = await contextTurn(profile, [SAVE, NOTE], (ctx) => ({
      context: { server: `plants: ${ctx.tool === SAVE ? 25 : 26}` },
    }));
    assertEquals(
      openingText(sent, 1).startsWith('<turn_context from="server">\nplants: 26\n'),
      true,
    );
    const replaced = replacedEvents(events);
    assertEquals(replaced.length, 1);
    assert(replaced[0]?.type === 'stage');
    assertEquals(replaced[0].callId, callIdOf(events, NOTE));
  });
}

Deno.test('context: text with $ patterns is kept as written', async () => {
  const { sent } = await contextTurn(ONE_AT_A_TIME, [SAVE], () => ({
    context: { server: "price: $& $1 $'" },
  }));
  assertEquals(
    openingText(sent, 1).startsWith('<turn_context from="server">\nprice: $& $1 $\'\n'),
    true,
  );
});

Deno.test('context: a package as JSON reads as the request reads it', async () => {
  const { sent } = await contextTurn(ONE_AT_A_TIME, [SAVE], () => ({
    context: { server: { plants: 25 } },
  }));
  assertEquals(
    openingText(sent, 1).startsWith('<turn_context from="server">\n{"plants":25}\n'),
    true,
  );
});

Deno.test('context: an opening message with a picture keeps it', async () => {
  const { sent } = await contextTurn(
    PICTURES,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    {
      text: 'Add Monty',
      context: { server: 'plants: 24' },
      attachments: [{ mimeType: 'image/png', data: 'aGk=' }],
    },
  );
  const opening = sent[1]?.history?.find((each) => each.role === 'user');
  assertEquals(opening?.parts?.length, 2);
  assertEquals(opening?.parts?.[1]?.type, 'image');
  assertEquals(openingText(sent, 1).startsWith(REPLACED), true);
});

Deno.test('context: over maxChars is a warning and nothing changes', async () => {
  const { events, sent } = await contextTurn(ONE_AT_A_TIME, [SAVE], () => ({
    context: { server: 'x'.repeat(41) },
  }));
  assertEquals(openingText(sent, 1).startsWith(OPENING), true);
  assertEquals(replacedEvents(events).length, 0);
  assertEquals(warningCodes(events), ['context_invalid']);
});

Deno.test('context: a profile that takes none from the host warns', async () => {
  const { events } = await contextTurn(
    NO_SERVER,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    { text: 'Add Monty' },
  );
  assertEquals(replacedEvents(events).length, 0);
  assertEquals(warningCodes(events), ['context_invalid']);
});

Deno.test('context: a guardrail block at the context boundary refuses the turn', async () => {
  await assertRejects(
    () =>
      contextTurn(BLOCKS, [SAVE], () => ({ context: { server: 'forbidden plants' } }), {
        text: 'Add Monty',
        context: { server: 'plants: 24' },
      }),
    Error,
  );
});

Deno.test('context: a step that ends the turn does not land it', async () => {
  const { events, sent } = await contextTurn(ONE_AT_A_TIME, [SAVE], () => ({
    end: true,
    context: { server: 'plants: 25' },
  }));
  assertEquals(sent.length, 1);
  assertEquals(replacedEvents(events).length, 0);
  assertEquals(warningCodes(events), ['context_not_allowed']);
});

/** A reply that goes on after an earlier run's call settled: the host's history ends with its result. */
const RESUMED: TurnHistoryMessage[] = [
  { role: 'user', content: `${OPENING}\n\n<user_data>\nAdd Monty\n</user_data>` },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'p0', type: 'function', function: { name: SAVE, arguments: '{"val":1}' } }],
  },
  { role: 'tool', tool_call_id: 'p0', name: SAVE, content: '{"finding":"saved"}' },
];

Deno.test('context: a resumed reply that sends its context reads the new one', async () => {
  const { sent } = await contextTurn(
    ONE_AT_A_TIME,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    { history: RESUMED, context: { server: 'plants: 24' } },
  );
  const users = (sent[1]?.history ?? []).filter((each) => each.role === 'user');
  assertEquals(
    users.map((each) => each.content),
    [`${OPENING}\n\n<user_data>\nAdd Monty\n</user_data>`, REPLACED],
  );
});

Deno.test('context: a resumed reply that sends no context warns and changes nothing', async () => {
  const { events, sent } = await contextTurn(
    ONE_AT_A_TIME,
    [SAVE],
    () => ({ context: { server: 'plants: 25' } }),
    { history: RESUMED },
  );
  assertEquals(replacedEvents(events), []);
  assertEquals(warningCodes(events), ['context_not_allowed']);
  assertEquals(openingText(sent, 1), `${OPENING}\n\n<user_data>\nAdd Monty\n</user_data>`);
});

Deno.test('context: a conversation the provider holds warns and stays as it is', async () => {
  const { events, sent } = await contextTurn(PROVIDER_HELD, [SAVE], () => ({
    context: { server: 'plants: 25' },
  }));
  assertEquals(openingText(sent, 1).startsWith(OPENING), true);
  assertEquals(replacedEvents(events).length, 0);
  assertEquals(warningCodes(events), ['context_not_allowed']);
});

Deno.test('applyStageResult: context only at post_tool, only from the host, only in a text step', () => {
  const ok = applyStageResult({
    stage: 'post_tool',
    injectAllowed: true,
    textToolStep: true,
    result: { context: { server: 'plants: 25' } },
  });
  assertEquals(ok.context, { server: 'plants: 25' });
  assertEquals(ok.warnings, []);

  const elsewhere = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: true,
    textToolStep: true,
    result: { context: { server: 'plants: 25' } },
  });
  assertEquals(elsewhere.context, undefined);
  assertEquals(elsewhere.warnings[0]?.code, 'affordance_not_allowed');

  for (const context of ['plants: 25', { client: 'x' }, { server: 'x', client: 'y' }, {}]) {
    const bad = applyStageResult({
      stage: 'post_tool',
      injectAllowed: true,
      textToolStep: true,
      result: { context },
    });
    assertEquals(bad.context, undefined);
    assertEquals(bad.warnings[0]?.code, 'context_invalid');
  }

  const noTurn = applyStageResult({
    stage: 'post_tool',
    injectAllowed: false,
    result: { context: { server: 'plants: 25' } },
  });
  assertEquals(noTurn.context, undefined);
  assertEquals(noTurn.warnings[0]?.code, 'context_not_allowed');
});
