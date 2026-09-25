/**
 * Tool credentials for `createTheoremHandler`, held on the server by session.
 *
 * The browser never holds a credential: the host's OAuth callback route saves
 * a token here, a key the user types at a gate is saved here as it arrives,
 * and every turn reads its credentials from here. A refreshed OAuth token
 * replaces its slot here the moment the turn reports it.
 *
 * @module
 */

import type { ToolCredential } from '../../../src/kernel/mod.ts';
import { createMemorySessionMap, type MemorySessionStoreOptions } from './session-store.ts';

/** A session's credentials, keyed by the tools' auth slot. */
export type TheoremCredentials = Record<string, ToolCredential>;

/**
 * Where tool credentials live. The default is process memory: use a vault or
 * an encrypted row when requests can reach different instances, and so the
 * credentials outlive the process.
 */
export interface TheoremCredentialStore {
	load(sessionId: string): TheoremCredentials | undefined | Promise<TheoremCredentials | undefined>;
	save(sessionId: string, credentials: TheoremCredentials): void | Promise<void>;
}

export function createMemoryCredentialStore(options: MemorySessionStoreOptions = {}): TheoremCredentialStore {
	return createMemorySessionMap<TheoremCredentials>(options);
}
