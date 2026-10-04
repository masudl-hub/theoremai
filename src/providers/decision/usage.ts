import type { DecisionModelBinding, DecisionResult } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import { JEV_USD_PER_MILLION_INPUT_TOKENS } from '../../presets/typesafe.ts';

/** Provider-reported usage, with Jev's published tariff only for a direct Jev response. */
export function decisionUsage(
  usage: unknown,
  binding: Pick<DecisionModelBinding, 'provider' | 'apiId'>,
  responseModel: string,
): DecisionResult['usage'] {
  if (
    !isRecord(usage) ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens) ||
    (usage.input_tokens as number) < 0 ||
    (usage.output_tokens as number) < 0
  )
    return undefined;
  const inputTokens = usage.input_tokens as number;
  const reported =
    typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
      ? usage.cost
      : undefined;
  const directJev =
    binding.provider === 'typesafe' &&
    binding.apiId.startsWith('jev-') &&
    responseModel.startsWith('jev-');
  const costUsd =
    reported ??
    (directJev ? (inputTokens * JEV_USD_PER_MILLION_INPUT_TOKENS) / 1_000_000 : undefined);
  return {
    inputTokens,
    outputTokens: usage.output_tokens as number,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
