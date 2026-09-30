import type { ToolCredential } from './types.ts';

/**
 * Where a call's tool credentials come from. The kernel reads a slot only when a
 * tool that signs in runs, so a turn opens no credential it does not use.
 */
export interface ToolCredentialSource {
  /** The slot's credential, or `undefined` when the person has not signed in. */
  get(slot: string): Promise<ToolCredential | undefined>;
  /**
   * A new credential for the slot: a refreshed OAuth token, or a key typed at a
   * sign-in gate. The call goes on only once it resolves, so persist it here; a
   * rotated refresh token lost to a closed stream cannot be recovered.
   */
  set(slot: string, credential: ToolCredential): Promise<void>;
  /**
   * The secret of a confidential OAuth client, read when the kernel refreshes a token
   * issued to `clientId`. Omit it for public clients. The secret is the host's, not
   * the person's, so it never lives on a stored credential.
   */
  clientSecret?(clientId: string): Promise<string | undefined>;
}

/** A source held in memory, seeded from `initial` (copied, never written back). */
export function memoryCredentialSource(
  initial: Readonly<Record<string, ToolCredential>> = {},
): ToolCredentialSource {
  const slots = new Map(Object.entries(initial));
  return {
    get: (slot) => Promise.resolve(slots.get(slot)),
    set: (slot, credential) => {
      slots.set(slot, credential);
      return Promise.resolve();
    },
  };
}
