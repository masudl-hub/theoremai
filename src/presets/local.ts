/**
 * Local model convenience preset.
 *
 * @module
 */

import type { ModelBinding } from '../kernel/types.ts';

/**
 * Whether an Ollama model thinks, read from the server's `POST /api/show` reply for it:
 * `capabilities` lists `thinking` (Ollama 0.34.0, 04/10/2026). The host fetches the reply.
 */
function ollamaModelThinks(show: unknown): boolean {
  if (!show || typeof show !== 'object') return false;
  const { capabilities } = show as { capabilities?: unknown };
  return Array.isArray(capabilities) && capabilities.includes('thinking');
}

/** A local binding field its model would refuse, and what is wrong with it. */
interface LocalBindingViolation {
  field: 'efforts';
  message: string;
}

/**
 * The first setting a local server would refuse on this binding, or `undefined`. A thinking
 * level goes to the server as `reasoning_effort`; Ollama answers HTTP 400 "does not support
 * thinking" for a model that does not think (04/10/2026).
 */
function localBindingViolation(
  binding: Pick<ModelBinding, 'apiId' | 'efforts'>,
  model: { thinks: boolean },
): LocalBindingViolation | undefined {
  if (!model.thinks && Object.keys(binding.efforts ?? {}).length > 0) {
    return {
      field: 'efforts',
      message: `${binding.apiId.trim()} does not think; leave efforts unset.`,
    };
  }
  return undefined;
}

export type { LocalBindingViolation };
export { localBindingViolation, ollamaModelThinks };
