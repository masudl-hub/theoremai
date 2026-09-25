/**
 * P2 — no unownable words.
 *
 * Two hosts with contradictory overrides (quota message, profile lexicon for
 * the continue instruction and error wording) must each see only their own copy; with overrides set, kernel
 * default strings must not appear in either turn's emitted text.
 */
import '../fixtures/test-host.ts';
import {
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
    guardrails: { quota: { perDay: 3 }, canary: false },
    lexicon: {
      'continue.instruction': HOST_A_CONTINUE,
      'error.internal': HOST_A_PUBLIC,
      'quota.exhausted': HOST_A_QUOTA,
    },
    ...geminiModels('gemini35FlashLite'),
  });
  const profileB = defineProfile({
    type: 'text',
    id: 'boundary.host.b',
    identity: { handle: 'b', system: 'SYSTEM_B' },
    tools: { allow: [] },
    inputs: { text: true },
    guardrails: { quota: { perDay: 7 }, canary: false },
    lexicon: {
      'continue.instruction': HOST_B_CONTINUE,
      'error.internal': HOST_B_PUBLIC,
      'quota.exhausted': HOST_B_QUOTA,
    },
    ...geminiModels('gemini35FlashLite'),
  });
  registerProfile(profileA);
  registerProfile(profileB);

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
  await runContinue(profileB.id, recordingB);

  assertStringIncludes(inputA, HOST_A_CONTINUE);
  assertStringIncludes(inputB, HOST_B_CONTINUE);
  assertEquals(inputA.includes(HOST_B_CONTINUE), false);
  assertEquals(inputB.includes(HOST_A_CONTINUE), false);
  assertEquals(inputA.includes(lexiconDefault('continue.instruction')), false);
  assertEquals(inputB.includes(lexiconDefault('continue.instruction')), false);
  assertEquals(inputA.includes(lexiconDefault('continue.instruction')), false);

  assertEquals(publicError(quotaExhausted(profileA), profileA.lexicon), HOST_A_QUOTA);
  assertEquals(publicError(quotaExhausted(profileB), profileB.lexicon), HOST_B_QUOTA);

  // An unknown Error is `internal`; each profile words it its own way.
  const unknown = new Error('totally unknown failure xyz');
  assertEquals(publicError(unknown), lexiconDefault('error.internal'));
  assertEquals(publicError(unknown, profileA.lexicon), HOST_A_PUBLIC);
  assertEquals(publicError(unknown, profileB.lexicon), HOST_B_PUBLIC);
  // A process-wide override never beats a profile's own wording.
  overrideLexicon({ 'error.internal': 'HOST_WIDE_COPY' });
  assertEquals(publicError(unknown), 'HOST_WIDE_COPY');
  assertEquals(publicError(unknown, profileA.lexicon), HOST_A_PUBLIC);

  resetLexicon();
});
