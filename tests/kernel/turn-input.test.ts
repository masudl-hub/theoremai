/**
 * A text turn's opening input has one owner: turn history. Tool steps, stage
 * injects and repair retries land after it on every provider, with or without
 * a stage handler. A retry adds only the repair and keeps the turn it retries.
 */
import '../fixtures/test-host.ts';
import { z } from 'zod';
import { EGRESS_RULES, standardEgressEnforce } from '../../src/guardrails/egress.ts';
import type { GuardrailContext, OutboundPayload, Verdict } from '../../src/guardrails/types.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import { runTurn } from '../../src/kernel/engine/runner.ts';
import { defineProfile, registerProfile } from '../../src/kernel/registry/profiles.ts';
import { registerTool } from '../../src/kernel/tools/mod.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
} from '../../src/kernel/types.ts';
import { CHAT_MEDIA_LIMITS, geminiModels } from '../fixtures/models.ts';

const PNG = { mimeType: 'image/png', data: btoa('px') };
const CANARY = /[0-9a-f]{32}/;

async function requestsFor(
  req: TurnRequest,
  reply: (call: number, request: ProviderCompleteRequest) => TurnEvent[],
) {
  const seen: ProviderCompleteRequest[] = [];
  const events: TurnEvent[] = [];
  const provider: ModelProvider = {
    complete: async function* (request) {
      seen.push({ ...request, history: [...(request.history ?? [])] });
      for (const event of reply(seen.length, request)) yield event;
    },
  };
  for await (const event of runTurn(req, provider)) events.push(event);
  return { seen, events };
}

function roles(history: TurnHistoryMessage[] | undefined): string[] {
  return (history ?? []).map((m) => m.role);
}

const toolThenText = (call: number): TurnEvent[] =>
  call === 1
    ? [{ type: 'tool', tool: { name: 'stub_tool', arguments: { value: 1 }, id: 'c1' } }]
    : [{ type: 'text', text: 'done' }];

/** Blocks the first attempt's draft so the turn retries once; the standard checks still run. */
const blockFirstReply = {
  quota: { perDay: 50 },
  egress: {
    onBlock: 'reject_to_agent' as const,
    maxRetries: 1,
    enforce: (payload: OutboundPayload, context: GuardrailContext): Verdict =>
      payload.text.includes('draft')
        ? {
            action: 'block',
            hits: [{ rule: 'draft', severity: 'high' }],
            rejection: 'Say it without the draft.',
          }
        : standardEgressEnforce(payload, context),
  },
};

registerProfile(
  defineProfile({
    type: 'text',
    id: 'input.openai.tools',
    identity: { handle: 'bot' },
    ...geminiModels('sonar'),
    maxSteps: 3,
    tools: { allow: ['stub_tool'] },
    inputs: { text: true },
  }),
);

registerProfile(
  defineProfile({
    type: 'text',
    id: 'input.retry',
    identity: { handle: 'bot', system: 'Answer plainly.' },
    ...geminiModels('gemini35FlashLite'),
    maxSteps: 2,
    tools: { allow: [] },
    inputs: { text: true, attachments: { accept: ['image/png'] }, ...CHAT_MEDIA_LIMITS },
    guardrails: { ...blockFirstReply, canary: true },
  }),
);

Deno.test('turn input: the question stays ahead of tool results on an OpenAI-compatible step', async () => {
  const { seen } = await requestsFor(
    { profile: 'input.openai.tools', input: { text: 'run the tool' } },
    toolThenText,
  );
  assertEquals(seen.length, 2);
  for (const request of seen) assertEquals(request.input, []);
  assertEquals(roles(seen[0]?.history), ['user']);
  assertEquals(roles(seen[1]?.history), ['user', 'assistant', 'tool']);
  assertStringIncludes(String(seen[1]?.history?.[0]?.content), 'run the tool');
});

Deno.test('turn input: host history comes first, then the question', async () => {
  const { seen } = await requestsFor(
    {
      profile: 'input.openai.tools',
      input: {
        text: 'and now?',
        history: [
          { role: 'user', content: 'earlier' },
          { role: 'assistant', content: 'earlier reply' },
        ],
      },
    },
    () => [{ type: 'text', text: 'ok' }],
  );
  assertEquals(roles(seen[0]?.history), ['user', 'assistant', 'user']);
  assertStringIncludes(String(seen[0]?.history?.[2]?.content), 'and now?');
});

for (const withStage of [false, true]) {
  const label = withStage ? 'with' : 'without';
  Deno.test(`turn input: a retry ${label} a stage handler keeps the question and sends media once`, async () => {
    const { seen, events } = await requestsFor(
      {
        profile: 'input.retry',
        input: { text: 'describe this', attachments: [PNG] },
        ...(withStage ? { onStage: () => undefined } : {}),
      },
      (call) => [{ type: 'text', text: call === 1 ? 'a draft' : 'a leaf' }],
    );
    assertEquals(seen.length, 2);
    const retry = seen[1];
    assertEquals(retry?.input, []);
    assertEquals(roles(retry?.history), ['user', 'user']);
    // The question and its image, once.
    const opening = retry?.history?.[0];
    assertEquals(
      opening?.parts?.map((p) => p.type),
      ['text', 'image'],
    );
    assertStringIncludes(JSON.stringify(opening?.parts), 'describe this');
    // Then the repair, text only.
    assertStringIncludes(String(retry?.history?.[1]?.content), 'Say it without the draft.');
    assertEquals(
      events.filter((e) => e.type === 'text').map((e) => e.text),
      ['a leaf'],
    );
  });
}

Deno.test('turn input: a retry keeps the canary-bound system prompt and the tool set', async () => {
  registerTool({
    type: 'function',
    name: 'turn_input_t1_tool',
    description: 'T1 tool the policy selects',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T1',
    permission: 'auto',
    input: z.object({}),
    output: z.object({ finding: z.string() }),
    handler: () => ({ finding: 'ok' }),
  });
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'input.retry.t1',
      identity: { handle: 'bot', system: 'Answer plainly.' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 2,
      tools: { allow: ['turn_input_t1_tool'], t1Policy: () => ['turn_input_t1_tool'] },
      inputs: { text: true },
      guardrails: { ...blockFirstReply, canary: true },
    }),
  );
  // The retry leaks the canary bound into the system prompt; it must still be caught.
  let canary = '';
  const { seen, events } = await requestsFor(
    { profile: 'input.retry.t1', input: { text: 'hello' } },
    (call, request) => {
      canary = CANARY.exec(request.system)?.[0] ?? '';
      return [{ type: 'text', text: call === 1 ? 'a draft' : `the note says ${canary}` }];
    },
  );
  assertEquals(seen.length, 2);
  assertEquals(seen[1]?.system, seen[0]?.system);
  assertEquals(
    seen[1]?.wireTools?.map((t) => t.name),
    ['turn_input_t1_tool'],
  );
  assertEquals(seen[1]?.wireTools, seen[0]?.wireTools);
  assertEquals(
    events.some((e) => e.guardrail?.hits?.some((hit) => hit.rule === EGRESS_RULES.canary)),
    true,
  );
  assertEquals(
    events.some((e) => e.type === 'text' && e.text?.includes(canary)),
    false,
  );
});

Deno.test('turn input: a before_end inject on a retry lands after the repair', async () => {
  let injected = false;
  const { seen } = await requestsFor(
    {
      profile: 'input.retry',
      input: { text: 'describe this' },
      onStage: ({ stage, history }) => {
        const repaired = history.some((m) => String(m.content).includes('without the draft'));
        if (stage === 'before_end' && repaired && !injected) {
          injected = true;
          return { inject: [{ role: 'user', content: 'also name the plant' }] };
        }
        return undefined;
      },
    },
    (call) => [{ type: 'text', text: call === 1 ? 'a draft' : 'a leaf' }],
  );
  assertEquals(seen.length, 3);
  const contents = (seen[2]?.continuation ?? seen[2]?.history ?? []).map((m) => String(m.content));
  assertStringIncludes(contents.at(-1) ?? '', 'also name the plant');
  assertEquals(
    seen[2]?.history?.findIndex((m) => String(m.content).includes('without the draft')) ?? -1,
    1,
  );
});

Deno.test('turn input: a repair reaches a profile that takes no text from the user', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'input.retry.media_only',
      identity: { handle: 'bot' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: false, attachments: { accept: ['image/png'] }, ...CHAT_MEDIA_LIMITS },
      guardrails: blockFirstReply,
    }),
  );
  const { seen } = await requestsFor(
    { profile: 'input.retry.media_only', input: { attachments: [PNG] } },
    (call) => [{ type: 'text', text: call === 1 ? 'a draft' : 'a leaf' }],
  );
  assertEquals(seen.length, 2);
  assertEquals(roles(seen[1]?.history), ['user', 'user']);
  assertStringIncludes(String(seen[1]?.history?.[1]?.content), 'Say it without the draft.');
});

Deno.test('turn input: an image turn with a stage handler keeps its prompt as input', async () => {
  registerProfile({
    id: 'input.image',
    type: 'image',
    identity: { handle: 'img' },
    ...geminiModels('gemini31FlashLiteImage'),
    image: { aspectRatio: '1:1', size: '1K', mimeType: 'image/jpeg', includeText: false },
    tools: { allow: [] },
    inputs: { text: true },
    outputs: { structured: null },
    guardrails: { quota: { perDay: 10 } },
  });
  const { seen } = await requestsFor(
    { profile: 'input.image', input: { text: 'a sleepy fox' }, onStage: () => undefined },
    () => [],
  );
  assertEquals(seen[0]?.history, []);
  assertStringIncludes(JSON.stringify(seen[0]?.input), 'a sleepy fox');
});

Deno.test('turn input: post_turn after an abort sees the history the model saw', async () => {
  const controller = new AbortController();
  let postTurnHistory: readonly TurnHistoryMessage[] = [];
  let call = 0;
  const provider: ModelProvider = {
    complete: async function* () {
      call++;
      if (call === 2) {
        // The host cancels while the second step is in flight.
        controller.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      yield { type: 'tool', tool: { name: 'stub_tool', arguments: { value: 1 }, id: 'c1' } };
      yield { type: 'done' };
    },
  };
  const events: TurnEvent[] = [];
  for await (const event of runTurn(
    {
      profile: 'input.openai.tools',
      input: { text: 'run the tool' },
      signal: controller.signal,
      onStage: ({ stage, history }) => {
        if (stage === 'post_turn') postTurnHistory = history;
        return undefined;
      },
    },
    provider,
  )) {
    events.push(event);
  }
  assertEquals(
    events.some((e) => e.type === 'done' && e.stop?.kind === 'cancelled'),
    true,
  );
  assertEquals(roles([...postTurnHistory]), ['user', 'assistant', 'tool']);
});
