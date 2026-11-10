import { createTestKernelScope } from '../fixtures/provider-scope.ts';
import { runScopedTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals } from '@std/assert';
import { z } from 'zod';
import {
  createMemoryToolExecution,
  type ToolBackgroundHandle,
  type ToolBackgroundService,
} from '../../mod.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import { appendAssistantEventsToHistory } from '../../src/interface/history.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { KernelScope } from '../../src/kernel/scope.ts';
import { toolOperationOutcomeSchema } from '../../src/kernel/tools/operation.ts';
import type { FunctionToolDef } from '../../src/kernel/tools/types.ts';
import { type ToolOutputPart, turnEventSchema } from '../../src/kernel/turn-events.ts';
import type { ModelRequest, TurnEvent, TurnModel, TurnRequest } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const PROFILE = 'media_sender';
const TOOL = 'make_card';
const REF = 'gs://private-bucket/cards/card-7.pdf';
const SENT = 'U0VOVA==';
const READ = 'UkVBRA==';

/** What the tool returns: a picture it sends, a picture only the model reads, and a reference. */
const PARTS: ToolOutputPart[] = [
  { type: 'text', text: 'Card made.' },
  { type: 'image', mimeType: 'image/png', data: SENT, sent: true },
  { type: 'image', mimeType: 'image/png', data: READ },
  { type: 'document', mimeType: 'application/pdf', uri: REF },
];

function cardTool(over: Partial<FunctionToolDef> = {}): FunctionToolDef {
  return {
    type: 'function',
    name: TOOL,
    description: 'Makes a card.',
    category: 'test',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.strictObject({}),
    output: z.object({ finding: z.string(), parts: z.array(z.unknown()) }),
    handler: () => ({ finding: 'made', parts: PARTS }),
    ...over,
  } as FunctionToolDef;
}

function scopeWith(over: Partial<FunctionToolDef> = {}, blockSecrets = false): KernelScope {
  const scope = createTestKernelScope();
  scope.tools.register(cardTool(over));
  scope.profiles.register(
    defineProfile({
      type: 'text',
      id: PROFILE,
      identity: { handle: PROFILE, system: 'You help.' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 4,
      tools: { allow: [TOOL] },
      inputs: { text: true },
      ...(blockSecrets
        ? {
            guardrails: {
              detect: { credentials: { at: { tool_output_function: 'block' as const } } },
            },
          }
        : {}),
    }),
  );
  return scope;
}

/** A model that calls the tool in its first step, then answers; every request it is sent is kept. */
function caller(seen: ModelRequest[], calls = true): TurnModel {
  let step = 0;
  return {
    async *complete(req) {
      await Promise.resolve();
      seen.push(structuredClone(req));
      step += 1;
      if (step === 1 && calls) {
        yield { type: 'tool', tool: { name: TOOL, callId: 'call_1', arguments: {} } };
        return;
      }
      yield { type: 'text', text: 'Here it is.' };
    },
  };
}

function turn(scope: KernelScope, model: TurnModel, request: Partial<TurnRequest> = {}) {
  return Array.fromAsync(
    runScopedTurn(
      scope,
      { profile: PROFILE, input: { text: 'Make a card' }, ...request } as TurnRequest,
      model,
    ),
  );
}

function complete(events: TurnEvent[]) {
  const [event] = toolEventsOf(events, 'complete');
  assert(event, 'no complete event');
  return event;
}

Deno.test('the model reads the bytes a tool returns, never its references or the sent mark', async () => {
  const seen: ModelRequest[] = [];
  const events = await turn(scopeWith(), caller(seen));
  const wire = JSON.stringify(seen);
  assertEquals(wire.includes(REF), false);
  assertEquals(wire.includes('"sent"'), false);
  assert(wire.includes(SENT) && wire.includes(READ), 'the model reads both pictures');
  assertEquals(complete(events).parts, PARTS);
  assertEquals(complete(events).readBack?.includes(REF), false);
});

Deno.test('the complete event keeps sent and references through its schema', async () => {
  const events = await turn(scopeWith(), caller([]));
  const event = events.find((e) => e.type === 'tool' && e.tool.phase === 'complete');
  assert(event);
  const parsed = turnEventSchema.parse(JSON.parse(JSON.stringify(event)));
  assert(parsed.type === 'tool' && parsed.tool.phase === 'complete');
  assertEquals(parsed.tool.parts, PARTS);
});

Deno.test('the next turn, rebuilt from the history, sends no reference to the model', async () => {
  const scope = scopeWith();
  const events = await turn(scope, caller([]));
  const history = appendAssistantEventsToHistory(
    [{ role: 'user', content: 'Make a card' }],
    events,
  );
  const seen: ModelRequest[] = [];
  await turn(scope, caller(seen, false), { input: { text: 'Thanks', history } });
  assertEquals(JSON.stringify(seen).includes(REF), false);
});

Deno.test('a hidden tool shows what it sent and the model reads none of it', async () => {
  const seen: ModelRequest[] = [];
  const events = await turn(scopeWith({ exposeToModel: false }), caller(seen));
  const wire = JSON.stringify(seen);
  assertEquals(wire.includes(REF), false);
  assertEquals(wire.includes(SENT), false);
  assertEquals(wire.includes(READ), false);
  assertEquals(complete(events).parts, [PARTS[1], PARTS[3]]);
});

Deno.test('a call the guard blocks shows no media', async () => {
  const events = await turn(
    scopeWith({ handler: () => ({ finding: TEST_OPENAI_KEY, parts: PARTS }) }, true),
    caller([]),
  );
  assertEquals(toolEventsOf(events, 'complete').length, 0);
  assertEquals(toolEventsOf(events, 'error').length, 1);
});

Deno.test('a detached call settles later with its sent media in the stored outcome', async () => {
  const scope = scopeWith({ background: 'always' });
  const execution = createMemoryToolExecution();
  const handles: ToolBackgroundHandle[] = [];
  const sink: TurnEvent[] = [];
  const service: ToolBackgroundService = {
    detached: (handle) => handles.push(handle),
    event: (event) => {
      sink.push(event);
    },
  };
  const seen: ModelRequest[] = [];
  await turn(scope, caller(seen), { execution, background: service });
  const handle = handles[0];
  assert(handle, 'not detached');
  await handle.done;
  const known = await execution.lookup({ ...handle, profileId: PROFILE, invocationHash: '' });
  assert(known?.kind === 'settled');
  const stored = toolOperationOutcomeSchema.parse(JSON.parse(JSON.stringify(known.outcome)));
  assertEquals(stored.replay.modelResult?.media, PARTS);
  assertEquals(JSON.stringify(stored.replay.modelResult?.parts).includes(REF), false);
  assertEquals(complete(sink).parts, PARTS);
  assertEquals(JSON.stringify(seen).includes(REF), false);
});
