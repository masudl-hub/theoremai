import { assertEquals } from '@std/assert';
import { defaultKernelScope, type ProfileDefinition, TheoremError } from '../../mod.ts';
import {
  createMemoryConversationStore,
  createTheoremConversationCore,
} from '../../web/src/server/mod.ts';
import { registerFixtureProviders } from '../fixtures/provider-scope.ts';
import { fixtureHostOptions } from '../fixtures/registered-runner.ts';
import { TEST_OPERATION_RETENTION_MS } from '../fixtures/retention.ts';

registerFixtureProviders(defaultKernelScope);

const PROFILE: ProfileDefinition = {
  type: 'text',
  id: 'core-steer-limit',
  identity: { handle: 'helper', system: 'You help.' },
  models: { stub: { protocol: 'scripted', provider: 'scripted', apiId: 'stub-model' } },
  tools: { allow: [] },
  inputs: { text: true, maxTextChars: 10 },
  guardrails: { detect: 'ignore' },
};

Deno.test('the core refuses a steer over inputs.maxTextChars, with no handler in front', async () => {
  const core = createTheoremConversationCore({
    operationRetentionMs: TEST_OPERATION_RETENTION_MS,
    profile: PROFILE,
    provider: () => fixtureHostOptions({ complete: () => (async function* () {})() }),
    conversationStore: createMemoryConversationStore(),
  });
  const at = { sessionId: 's-1', signal: new AbortController().signal };
  const refused = await core
    .steer(at, { turnId: 't-1', id: 'long', input: { text: 'y'.repeat(11) } })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assertEquals(refused instanceof TheoremError, true);
  assertEquals(refused instanceof TheoremError && refused.copy, [
    { key: 'text.too_long', params: { maxTextChars: 10 } },
  ]);
  // why: No turn runs here, so a steer within the limit is passed on and finds nothing to join.
  assertEquals(
    await core.steer(at, { turnId: 't-1', id: 'ok', input: { text: 'y'.repeat(10) } }),
    false,
  );
});
