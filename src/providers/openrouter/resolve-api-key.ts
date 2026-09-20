/**
 * Resolve an API key from an OpenAI-gateway config using an optional vault slot.
 *
 * @module
 */

import { TheoremError, UPSTREAM_FAILED } from '../../guardrails/error.ts';
import type { KeySlot } from '../../kernel/types.ts';
import type { OpenAiGatewayConfig } from '../types.ts';

/** Pick the credential for this turn from vault[keySlot] or flat apiKey. */
export function resolveOpenAiGatewayApiKey(
  config: OpenAiGatewayConfig,
  keySlot: KeySlot | undefined,
): string {
  if (keySlot !== undefined) {
    if (!config.vault) {
      throw new TheoremError('openAiGateway.vault is required when keySlot is set');
    }
    const fromVault = config.vault[keySlot]?.trim();
    if (!fromVault) {
      throw new TheoremError(UPSTREAM_FAILED);
    }
    return fromVault;
  }
  const flat = config.apiKey?.trim();
  if (!flat) {
    throw new TheoremError('openAiGateway.apiKey is required when keySlot is omitted');
  }
  return flat;
}
