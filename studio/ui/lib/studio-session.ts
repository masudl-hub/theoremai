/**
 * Where the studio keeps itself: this tab's sessionStorage, under the keys and in the record
 * shape the workspace store, its restore and the kept conversations share.
 */
import type { STUDIO_WORKSPACE_VERSION, StudioWorkspace } from '../../mod.ts';

export const WORKSPACE_KEY = 'theorem.studio.v2';
/** A project's workspace is kept under its own name, apart from the website's and other projects'. */
export const projectKey = (name: string) => `${WORKSPACE_KEY}.project:${name}`;
/** One conversation per agent, under this and the agent's key. */
export const CHAT_PREFIX = 'theorem.studio.v2.chat:';

/** A kept workspace, read back with its revision. */
export interface RestoredStudio {
	workspace: StudioWorkspace;
	revision: number;
	/**
	 * A project's workspace: the key it is kept under, and the print of the files its starts stand
	 * on. A reload brings the edits back while the files still print the same.
	 */
	project?: { key: string; files: string };
}

/** What sessionStorage holds. */
export interface StoredWorkspace {
	v: typeof STUDIO_WORKSPACE_VERSION;
	workspace: StudioWorkspace;
	revision: number;
	/** For a project's workspace: the print of the files its starts stand on. */
	files?: string;
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
