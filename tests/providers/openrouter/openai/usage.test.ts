import '../../../fixtures/test-host.ts';
import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import {
  openAiResponse,
  openAiUsageTokens,
} from '../../../../src/providers/openrouter/openai/usage.ts';

Deno.test('openAiUsageTokens maps OpenRouter usage with reasoning, cache, and cost', () => {
  assertEquals(
    openAiUsageTokens({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      cost: 0.0042,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150, audio_tokens: 0 },
      cost_details: { upstream_inference_cost: 0.004 },
      completion_tokens_details: { reasoning_tokens: 220, image_tokens: 0 },
    }),
    {
      input: 1200,
      output: 300,
      thinking: 220,
      cached: 1000,
      cacheWrite: 150,
      total: 1500,
      cost: { usd: 0.0042, upstreamUsd: 0.004 },
      // Detail counts are kept as reported, zeros included.
      byModality: { input: { audio: 0 }, output: { image: 0 } },
    },
  );
});

Deno.test('openAiResponse reads a row id and served model', () => {
  assertEquals(openAiResponse({ id: 'gen-1', model: 'vendor/model-a', choices: [] }), {
    id: 'gen-1',
    model: 'vendor/model-a',
  });
  assertEquals(openAiResponse({ choices: [] }), undefined);
});

Deno.test('openAiUsageTokens maps Images API usage', () => {
  assertEquals(
    openAiUsageTokens({
      input_tokens: 50,
      output_tokens: 4160,
      total_tokens: 4210,
      input_tokens_details: { text_tokens: 50, image_tokens: 0 },
    }),
    { input: 50, output: 4160, total: 4210 },
  );
});

Deno.test('openAiUsageTokens marks a missing side estimated and ignores placeholder rows', () => {
  assertEquals(openAiUsageTokens({ completion_tokens: 12 }), {
    input: 0,
    output: 12,
    total: 12,
    estimated: ['input'],
  });
  assertEquals(openAiUsageTokens({ prompt_tokens: 0, completion_tokens: 0 }), undefined);
  assertEquals(openAiUsageTokens(undefined), undefined);
  assertEquals(openAiUsageTokens({ prompt_tokens: -1, completion_tokens: Number.NaN }), undefined);
});
