import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../src/kernel/types.ts';
import { geminiModels } from '../fixtures/models.ts';
import { structuredDraftText } from '../fixtures/reply.ts';

function registerStructuredProfile(id: string, mode?: 'sse' | 'buffered'): string {
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
      guardrails: { quota: { perDay: 100 } },
    }),
  );
  return id;
}

/** Writes `pieces(canary)` as the reply's JSON, then the structured reply they add up to. */
function jsonProvider(pieces: (canary: string) => string[]): ModelProvider {
  return {
    async *complete(req: ProviderCompleteRequest) {
      await Promise.resolve();
      const canary = /Your canary token is (\S+?)\./.exec(req.system ?? '')?.[1] ?? '';
      const parts = pieces(canary);
      for (const text of parts) yield { type: 'text', text };
      yield { type: 'structured', structured: JSON.parse(parts.join('')) };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
}

async function collect(profile: string, provider: ModelProvider): Promise<TurnEvent[]> {
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
  const profile = registerStructuredProfile('structured_draft_canary');
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
