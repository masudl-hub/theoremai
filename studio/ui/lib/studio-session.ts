/**
 * Where the studio keeps itself: this tab's sessionStorage, under the keys and in the record
 * shape the workspace store, its restore and the kept conversations share.
 */
import type { STUDIO_WORKSPACE_VERSION, StudioWorkspace } from '../../mod.ts';

export const WORKSPACE_KEY = 'theorem.studio.v2';
/** One conversation per agent, under this and the agent's key. */
export const CHAT_PREFIX = 'theorem.studio.v2.chat:';

/** A kept workspace, read back with its revision. */
export interface RestoredStudio {
	workspace: StudioWorkspace;
	revision: number;
	/** A workspace this tab does not keep: a project's, read fresh from the project each load. */
	transient?: boolean;
}

/** What sessionStorage holds. */
export interface StoredWorkspace extends RestoredStudio {
	v: typeof STUDIO_WORKSPACE_VERSION;
}

/** This tab's sessionStorage, or null where there is none or it is blocked. */
export function session(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
