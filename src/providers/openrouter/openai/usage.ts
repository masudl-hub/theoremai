import { asRecord, nonEmptyString } from '../../../kernel/engine/record.ts';
import { reportedTokens, usageCount } from '../../../kernel/engine/usage.ts';
import type { TurnCost, TurnResponse, TurnTokens } from '../../../kernel/types.ts';

function cost(usage: Record<string, unknown>): TurnCost | undefined {
  const usd = usageCount(usage.cost);
  if (usd === undefined) return undefined;
  const upstreamUsd = usageCount(asRecord(usage.cost_details)?.upstream_inference_cost);
  return { usd, ...(upstreamUsd === undefined ? {} : { upstreamUsd }) };
}

function detailCounts(
  details: Record<string, unknown> | undefined,
  keys: Record<string, string>,
): Record<string, number> | undefined {
  const counts = Object.entries(keys).flatMap(([key, modality]) => {
    const count = usageCount(details?.[key]);
    return count === undefined ? [] : [[modality, count] as const];
  });
  return counts.length > 0 ? Object.fromEntries(counts) : undefined;
}

/**
 * OpenRouter's per-modality detail counts, as reported (probed 23/09/2026):
 * prompt `audio_tokens` / `video_tokens` (no image count, even for an image
 * input) and completion `image_tokens` / `audio_tokens`.
 */
function modalityCounts(
  prompt: Record<string, unknown> | undefined,
  completion: Record<string, unknown> | undefined,
): TurnTokens['byModality'] {
  const input = detailCounts(prompt, { audio_tokens: 'audio', video_tokens: 'video' });
  const output = detailCounts(completion, { image_tokens: 'image', audio_tokens: 'audio' });
  if (!input && !output) return undefined;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
}

/**
 * Chat Completions reports `prompt_tokens` / `completion_tokens`, the Images API
 * `input_tokens` / `output_tokens`. Both already mean what OpenTelemetry means:
 * completion includes reasoning and prompt includes cached tokens.
 */
export function openAiUsageTokens(raw: unknown): TurnTokens | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const prompt = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);
  const completion = asRecord(usage.completion_tokens_details);
  return reportedTokens({
    input: usageCount(usage.prompt_tokens) ?? usageCount(usage.input_tokens),
    output: usageCount(usage.completion_tokens) ?? usageCount(usage.output_tokens),
    thinking: usageCount(completion?.reasoning_tokens),
    cached: usageCount(prompt?.cached_tokens),
    cacheWrite: usageCount(prompt?.cache_write_tokens),
    cost: cost(usage),
    byModality: modalityCounts(prompt, completion),
  });
}

export function openAiResponse(raw: Record<string, unknown>): TurnResponse | undefined {
  const id = nonEmptyString(raw.id);
  const model = nonEmptyString(raw.model);
  if (!id && !model) return undefined;
  return { ...(id ? { id } : {}), ...(model ? { model } : {}) };
}
