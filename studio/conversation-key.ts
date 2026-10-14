import { toBase64Url } from '@theoremjs/agents/kernel';

/** The least a sealing key holds: 256 bits. */
const CONVERSATION_KEY_BYTES = 32;

/**
 * A fresh key to seal a studio's chat conversations. Whoever holds it opens
 * their refs: the studio's server for one run, or one tab for its page runs.
 */
export function newConversationKey(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(CONVERSATION_KEY_BYTES)));
}
