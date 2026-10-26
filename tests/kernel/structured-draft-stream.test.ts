import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { TEST_OPENAI_KEY } from '../../src/guardrails/corpus/secrets.ts';
import type { DetectSpec } from '../../src/guardrails/detectors.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelRequest, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import { TAKE_OUT_LEAKS } from '../fixtures/leaks.ts';
import { geminiModels } from '../fixtures/models.ts';
import { structuredDraftText } from '../fixtures/reply.ts';

function registerStructuredProfile(
  id: string,
  mode?: 'sse' | 'buffered',
  detect?: DetectSpec,
): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id,
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: 'chatTurn', ...(mode ? { streaming: { mode } } : {}) },
      guardrails: { quota: { perDay: 100 }, ...(detect ? { detect } : {}) },
    }),
  );
  return id;
}

/** Writes `pieces(canary)` as the reply's JSON, then the structured reply they add up to. */
function jsonProvider(pieces: (canary: string) => string[]): TurnModel {
  return {
    async *complete(req: ModelRequest) {
      await Promise.resolve();
      const canary = /Your canary token is (\S+?)\./.exec(req.system ?? '')?.[1] ?? '';
      const parts = pieces(canary);
      for (const text of parts) yield { type: 'text', text };
      yield { type: 'structured', structured: JSON.parse(parts.join('')) };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
}

async function collect(profile: string, provider: TurnModel): Promise<TurnEvent[]> {
  return await Array.fromAsync(runTurn({ profile, input: { text: 'Say hi' } }, provider));
}

Deno.test('under sse a structured reply previews as drafts, and the reply still arrives whole', async () => {
  const profile = registerStructuredProfile('structured_draft_sse');
  const events = await collect(
    profile,
    jsonProvider(() => ['{"message":', '"Hello', ' there"}']),
  );
  assertEquals(
    events.some((e) => e.type === 'text'),
    false,
  );
  assertEquals(structuredDraftText(events), '{"message":"Hello there"}');
  const types = events.map((e) => e.type);
  assertEquals(types.lastIndexOf('structured_draft') < types.indexOf('structured'), true);
  assertEquals(
    events.flatMap((e) => (e.type === 'structured' ? [e.structured] : [])),
    [{ message: 'Hello there' }],
  );
});

Deno.test('a canary written into a structured reply never shows in its drafts', async () => {
  const profile = registerStructuredProfile('structured_draft_canary', undefined, TAKE_OUT_LEAKS);
  let canary = '';
  const events = await collect(
    profile,
    jsonProvider((token) => {
      canary = token;
      const half = Math.floor(token.length / 2);
      return ['{"message":"', token.slice(0, half), token.slice(half), ' and more"}'];
    }),
  );
  assertEquals(canary.length > 0, true);
  const shown = structuredDraftText(events);
  assertEquals(shown.includes(canary.slice(0, Math.floor(canary.length / 2))), false);
  assertEquals(shown.includes('and more'), false);
  assertEquals(JSON.stringify(events).includes(canary), false);
});

Deno.test('buffered sends no drafts: the structured reply is the reply whole', async () => {
  const profile = registerStructuredProfile('structured_draft_buffered', 'buffered');
  const events = await collect(
    profile,
    jsonProvider(() => ['{"message":', '"Hi"}']),
  );
  assertEquals(
    events.some((e) => e.type === 'structured_draft' || e.type === 'text'),
    false,
  );
  assertEquals(
    events.flatMap((e) => (e.type === 'structured' ? [e.structured] : [])),
    [{ message: 'Hi' }],
  );
});

Deno.test('a rule set only for structured replies stops the drafts before the key shows', async () => {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 'test', system: 'test' },
      id: 'structured_draft_rule',
      ...geminiModels('gemini35FlashLite'),
      maxSteps: 1,
      tools: { allow: [] },
      inputs: { text: true },
      outputs: { structured: 'chatTurn' },
      guardrails: {
        quota: { perDay: 100 },
        detect: { credentials: { at: { reply: 'ignore', reply_structured: 'block' } } },
      },
    }),
  );
  const half = Math.floor(TEST_OPENAI_KEY.length / 2);
  const events = await collect(
    'structured_draft_rule',
    jsonProvider(() => [
      '{"message":"key ',
      TEST_OPENAI_KEY.slice(0, half),
      TEST_OPENAI_KEY.slice(half),
      ' then more"}',
    ]),
  );
  const shown = structuredDraftText(events);
  assertEquals(shown.startsWith('{"message":"key'), true);
  assertEquals(shown.includes(TEST_OPENAI_KEY.slice(0, half)), false);
  assertEquals(JSON.stringify(events).includes(TEST_OPENAI_KEY.slice(0, half)), false);
  assertEquals(
    events.some((e) => e.type === 'guardrail' && e.guardrail.boundary === 'reply_structured'),
    true,
  );
});
