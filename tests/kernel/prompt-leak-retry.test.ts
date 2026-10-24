import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assertStringIncludes } from '@std/assert';
import { labelDefault } from '../../src/guardrails/labels.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelRequest, TurnEvent } from '../../src/kernel/types.ts';
import { eventsOf } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';

const PRIVATE =
  'Before you answer, weigh the pot in your hand and compare it to a dry one of the same size.';
const ECHO = 'weigh the pot in your hand and compare it to a dry one of the same size';

Deno.test('a reply stopped for repeating the private instruction is retried with the passage quoted, and a clean rewrite goes out', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      id: 'prompt_leak_retry',
      identity: { handle: 'prompt_leak_retry' },
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: {},
      guardrails: { quota: { perDay: 10 }, blockedReply: { onBlock: 'retry', maxRetries: 1 } },
    }),
  );
  const repairs: string[] = [];
  async function* complete(req: ModelRequest): AsyncGenerator<TurnEvent> {
    await Promise.resolve();
    const repair = req.history?.at(-1)?.content;
    if (req.history && req.history.length > 1 && typeof repair === 'string') repairs.push(repair);
    yield {
      type: 'text',
      text: repairs.length === 0 ? `Easy: ${ECHO}.` : 'Lift it; a light pot is dry.',
    };
  }
  const events = await Array.fromAsync(
    runTurn(
      {
        profile: 'prompt_leak_retry',
        system: ['Be brief. ', { private: PRIVATE }],
        input: { text: 'water?' },
      },
      { complete },
    ),
  );
  assertEquals(repairs.length, 1);
  assertStringIncludes(repairs[0] ?? '', labelDefault('detect.hint.prompt_leak'));
  assertStringIncludes(repairs[0] ?? '', `Found: "${ECHO}`);
  assertEquals(
    eventsOf(events, 'text')
      .map((e) => e.text)
      .join(''),
    'Lift it; a light pot is dry.',
  );
});
