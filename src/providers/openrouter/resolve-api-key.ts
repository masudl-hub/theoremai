/**
 * Resolve an API key from an OpenAI-gateway config using an optional vault slot.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import type { KeySlot } from '../../kernel/types.ts';
import type { OpenAiGatewayConfig } from '../types.ts';

/** Pick the credential for this turn from vault[keySlot] or flat apiKey. */
export function resolveOpenAiGatewayApiKey(
  config: OpenAiGatewayConfig,
  keySlot: KeySlot | undefined,
): string {
  if (keySlot !== undefined) {
    if (!config.vault) {
      throw new TheoremError('config', 'openAiGateway.vault is required when keySlot is set');
    }
    const fromVault = config.vault[keySlot]?.trim();
    if (!fromVault) {
      throw new TheoremError('auth', `openAiGateway.vault has no key in slot '${keySlot}'`);
    }
    return fromVault;
  }
  const flat = config.apiKey?.trim();
  if (!flat) {
    throw new TheoremError('auth', 'openAiGateway.apiKey is required when keySlot is omitted');
  }
  return flat;
}
