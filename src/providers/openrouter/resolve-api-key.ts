import { TheoremError } from '../../guardrails/error.ts';
import type { KeySlot } from '../../kernel/types.ts';
import { requireKey } from '../shared/vault.ts';
import type { OpenAiGatewayTransport } from '../types.ts';

export function resolveOpenAiGatewayApiKey(
  config: OpenAiGatewayTransport,
  keySlot: KeySlot | undefined,
): string {
  if (keySlot === undefined) {
    throw new TheoremError('auth', 'an OpenRouter model must name a vault slot');
  }
  return requireKey(config.vault, keySlot);
}
