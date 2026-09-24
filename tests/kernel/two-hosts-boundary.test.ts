/**
 * P2 — no unownable words.
 *
 * Two hosts with contradictory overrides (quota message, continue instruction,
 * lexicon) must each see only their own copy; with overrides set, kernel
 * default strings must not appear in either turn's emitted text.
 */
import '../fixtures/test-host.ts';
import {
  CONTINUE_INSTRUCTION,
  defineProfile,
  lexiconDefault,
  type ModelProvider,
  overrideLexicon,
  publicError,
  quotaExhausted,
  registerProfile,
  resetLexicon,
  runTurn,
  type TurnEvent,
} from '../../mod.ts';
import { assertEquals, assertStringIncludes } from '../../src/kernel/engine/assert.ts';
import { geminiModels } from '../fixtures/models.ts';

const HOST_A_CONTINUE = 'HOST_A_CONTINUE_FINISH_NOW';
const HOST_B_CONTINUE = 'HOST_B_CONTINUE_FINISH_NOW';
const HOST_A_PUBLIC = 'HOST_A_PUBLIC_GENERIC_COPY';
const HOST_B_PUBLIC = 'HOST_B_PUBLIC_GENERIC_COPY';
const HOST_A_QUOTA = 'HOST_A_QUOTA_LIMIT_COPY';
const HOST_B_QUOTA = 'HOST_B_QUOTA_LIMIT_COPY';

function mockProvider(text: string): ModelProvider {
  return {
    async *complete(): AsyncIterable<TurnEvent> {
      yield { type: 'text', text };
      yield { type: 'tokens', tokens: { input: 1, output: 1, total: 2 } };
      yield { type: 'done', stop: { kind: 'completed' } };
    },
  };
}

async function runContinue(profileId: string, provider: ModelProvider): Promise<void> {
  for await (const _event of runTurn(
    {
      profile: profileId,
      input: { history: [{ role: 'assistant', content: 'partial' }] },
      continueFrom: { stop: { kind: 'length' } },
    },
    provider,
  )) {
    // drain
  }
}

Deno.test('two hosts: contradictory overrides never leak across turns', async () => {
  resetLexicon();

  const profileA = defineProfile({
    type: 'text',
    id: 'boundary.host.a',
    identity: { handle: 'a', system: 'SYSTEM_A' },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 3, message: HOST_A_QUOTA }, canary: false },
    turnBehaviour: {
      resumption: { continueInstruction: HOST_A_CONTINUE },
    },
    ...geminiModels('gemini35FlashLite'),
  });
  const profileB = defineProfile({
    type: 'text',
    id: 'boundary.host.b',
    identity: { handle: 'b', system: 'SYSTEM_B' },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 7, message: HOST_B_QUOTA }, canary: false },
    turnBehaviour: {
      resumption: { continueInstruction: HOST_B_CONTINUE },
    },
    ...geminiModels('gemini35FlashLite'),
  });
  registerProfile(profileA);
  registerProfile(profileB);

  overrideLexicon({ 'public.generic': HOST_A_PUBLIC });

  let inputA = '';
  let inputB = '';
  const recordingA: ModelProvider = {
    async *complete(req) {
      inputA = JSON.stringify([req.input, req.history]);
      yield* mockProvider('ok-a').complete(req);
    },
  };
  const recordingB: ModelProvider = {
    async *complete(req) {
      inputB = JSON.stringify([req.input, req.history]);
      yield* mockProvider('ok-b').complete(req);
    },
  };

  await runContinue(profileA.id, recordingA);
  overrideLexicon({ 'public.generic': HOST_B_PUBLIC });
  await runContinue(profileB.id, recordingB);

  assertStringIncludes(inputA, HOST_A_CONTINUE);
  assertStringIncludes(inputB, HOST_B_CONTINUE);
  assertEquals(inputA.includes(HOST_B_CONTINUE), false);
  assertEquals(inputB.includes(HOST_A_CONTINUE), false);
  assertEquals(inputA.includes(CONTINUE_INSTRUCTION), false);
  assertEquals(inputB.includes(CONTINUE_INSTRUCTION), false);
  assertEquals(inputA.includes(lexiconDefault('continue.instruction')), false);

  assertEquals(quotaExhausted(profileA), {
    code: 'quota_exhausted',
    perDay: 3,
    message: HOST_A_QUOTA,
  });
  assertEquals(quotaExhausted(profileB), {
    code: 'quota_exhausted',
    perDay: 7,
    message: HOST_B_QUOTA,
  });

  assertEquals(
    publicError(new Error('totally unknown failure xyz')),
    lexiconDefault('public.unavailable'),
  );
  // Unknown Error → public.unavailable (not public.generic). Override that key.
  overrideLexicon({ 'public.unavailable': HOST_B_PUBLIC });
  assertEquals(publicError(new Error('totally unknown failure xyz')), HOST_B_PUBLIC);

  resetLexicon();
});
