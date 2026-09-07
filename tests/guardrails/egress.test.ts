import '../fixtures/test-host.ts';
import { mintCanary, USER_CLOSE, USER_OPEN } from '../../src/guardrails/canary.ts';
import { TEST_OPENAI_KEY, TEST_SSN } from '../../src/guardrails/corpus/secrets.ts';
import { INJ_IGNORE } from '../../src/guardrails/corpus/strings.ts';
import { standardEgressEnforce } from '../../src/guardrails/egress.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import { getProfile } from '../../src/kernel/registry/profiles.ts';
import type { EgressContext } from '../../src/kernel/types.ts';

function egressCtx(text: string, canary?: string): EgressContext {
  return { text, canary, profile: getProfile('chat') };
}

Deno.test('standardEgressEnforce allows benign assistant text', () => {
  const result = standardEgressEnforce(egressCtx('Hello! How can I help?', mintCanary()));
  assertEquals(result.blocked, false);
  assertEquals(result.text, 'Hello! How can I help?');
});

Deno.test('standardEgressEnforce blocks literal canary leak', () => {
  const canary = mintCanary();
  const result = standardEgressEnforce(egressCtx(`The token is ${canary}`, canary));
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('canary'), true);
  assertEquals(result.text, '');
});

Deno.test('standardEgressEnforce blocks sensitive echo', () => {
  const result = standardEgressEnforce(egressCtx(`Your key is ${TEST_OPENAI_KEY}`, mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('sensitive'), true);
});

Deno.test('standardEgressEnforce blocks system boundary markers', () => {
  const result = standardEgressEnforce(
    egressCtx('Untrusted user content is inside the fence', mintCanary()),
  );
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('system_boundary'), true);
});

Deno.test('standardEgressEnforce blocks injection echo in assistant text', () => {
  const result = standardEgressEnforce(egressCtx(INJ_IGNORE, mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('injection_echo'), true);
});

Deno.test('standardEgressEnforce blocks user_data fence markers', () => {
  const result = standardEgressEnforce(egressCtx(`leaked ${USER_OPEN}`, mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('system_boundary'), true);
});

Deno.test('standardEgressEnforce reports multiple hit kinds', () => {
  const canary = mintCanary();
  const result = standardEgressEnforce(egressCtx(`${INJ_IGNORE} ${TEST_SSN} ${canary}`, canary));
  assertEquals(result.blocked, true);
  assertEquals((result.hits?.length ?? 0) >= 2, true);
});

Deno.test('standardEgressEnforce passes empty text without blocking', () => {
  const result = standardEgressEnforce(egressCtx('', mintCanary()));
  assertEquals(result.blocked, false);
  assertEquals(result.text, '');
});

Deno.test('standardEgressEnforce rejectionMessage names all blocked categories', () => {
  const canary = mintCanary();
  const result = standardEgressEnforce(egressCtx(`${canary} ${INJ_IGNORE}`, canary));
  assertEquals(result.blocked, true);
  assertEquals(result.rejectionMessage?.includes('canary'), true);
  assertEquals(result.rejectionMessage?.includes('injection_echo'), true);
});

Deno.test('standardEgressEnforce blocks "This turn\\u2019s canary is" boundary marker in text', () => {
  const result = standardEgressEnforce(egressCtx("This turn's canary is abc", mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.hits?.includes('system_boundary'), true);
});

Deno.test('standardEgressEnforce without canary: no canary hit even if text has theo-prefix', () => {
  const result = standardEgressEnforce(egressCtx('theo-deadbeef', undefined));
  assertEquals(result.hits?.includes('canary') ?? false, false);
});

Deno.test('standardEgressEnforce blocks closing user_data fence tag', () => {
  const result = standardEgressEnforce(egressCtx(`leaked ${USER_CLOSE}`, mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.text, '');
  assertEquals(result.hits?.includes('system_boundary'), true);
});

Deno.test('standardEgressEnforce sensitive echo sets text to empty string', () => {
  const result = standardEgressEnforce(egressCtx(`Your ssn is ${TEST_SSN}`, mintCanary()));
  assertEquals(result.blocked, true);
  assertEquals(result.text, '');
});
