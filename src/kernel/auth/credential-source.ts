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
   * Forget the slot's credential, as when the person disconnects the service: once it
   * resolves, `get(slot)` answers `undefined` and the next call that needs it gates.
   * Revoke an OAuth sign-in first with `revokeOAuthToken`; this only forgets.
   */
  delete(slot: string): Promise<void>;
  /**
   * The secret of a confidential OAuth client, read when the kernel refreshes a token
   * issued to `clientId`. Omit it for public clients. The secret is the host's, not
   * the person's, so it never lives on a stored credential.
   */
  clientSecret?(clientId: string): Promise<string | undefined>;
}

/**
 * A slot's credential as a sealed source tells it: whether it can go, never the secret.
 *
 * - `absent`: the person has not signed in.
 * - `ready`: it can go. `id` names it stably (a digest, for keying MCP sessions); `refreshed`
 *   says an OAuth token was refreshed and stored to get here; `resource` is where it may go.
 * - `unusable`: an OAuth token that names no resource (`no_resource`), is past its time with no
 *   refresh token (`expired`), or whose refresh failed (`refresh_failed`, with the token server's
 *   own words in `detail`, untrusted, for the host only).
 */
export type SealedCredential =
  | { state: 'absent' }
  | {
      state: 'ready';
      id: string;
      refreshed: boolean;
      resource: string;
      issuer?: string;
    }
  | {
      state: 'unusable';
      reason: 'no_resource' | 'expired' | 'refresh_failed';
      detail?: string;
      issuer?: string;
      resource?: string;
    };

/** One request a sealed source sends: plain data, so it can cross to where the credential is. */
export interface SealedRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Where a call's tool credentials are, when the run must never hold them: the run asks for a slot
 * to be readied and has each request sent with it, and the plaintext stays on the other side.
 * Build that side with `sealedCredentialHost`; this is what the run is passed.
 */
export interface SealedCredentialSource {
  readonly sealed: true;
  /** The slot's credential readied (an expired OAuth token refreshed and stored), told without its secret. */
  prepare(slot: string): Promise<SealedCredential>;
  /**
   * Sends one request with the slot's credential, never following a redirect, and answers with the
   * credential replaced wherever the service echoed it. The run sends only its call's own origin
   * through here, after its own checks.
   */
  send(slot: string, url: string, request: SealedRequest): Promise<Response>;
}

/** Where a run's tool credentials come from: a source it reads, or a sealed one it only sends through. */
export type CredentialSource = ToolCredentialSource | SealedCredentialSource;

/** Whether the run only sends through `source`, never reading a credential from it. */
export function isSealedSource(source: CredentialSource): source is SealedCredentialSource {
  return 'sealed' in source && source.sealed === true;
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
    delete: (slot) => {
      slots.delete(slot);
      return Promise.resolve();
    },
  };
}
