import type { JsonObject } from '../json.ts';
import type { KeySlot } from '../types.ts';

/** A key as the vault holds it: a string, or an object for a provider that signs in with several fields. */
export type KeyCredential = string | JsonObject;
export interface CredentialContext {
  providerId: string;
  /** The model the call is for. Absent for a key check, which calls no model. */
  apiId?: string;
  keySlot: KeySlot;
  signal?: AbortSignal;
}
/** Reads a key when a call needs it, e.g. from a secret manager. */
export type CredentialResolver = (
  context: CredentialContext,
) => KeyCredential | Promise<KeyCredential>;
/** The host's keys, by slot. The kernel reads a slot only for the call that names it. */
export type KeyVault = Readonly<Record<KeySlot, KeyCredential | CredentialResolver | undefined>>;
