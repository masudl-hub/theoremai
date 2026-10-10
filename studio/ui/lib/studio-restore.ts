/**
 * Reading the studio's workspace back from this tab's sessionStorage. A kept workspace that no
 * longer fits the current shape is set aside, and a draft kept by the one-agent studio opens as
 * a workspace holding it.
 */
import {
	agentDraft,
	createBlankDraft,
	editedSince,
	STUDIO_WORKSPACE_VERSION,
	type StudioDraft,
	type StudioWorkspace,
	workspaceFromDraft,
} from '../../mod.ts';
import {
	CHAT_PREFIX,
	isRecord,
	type RestoredStudio,
	type StoredWorkspace,
	session,
	WORKSPACE_KEY,
} from './studio-session.ts';
import { keptTool, keptWorkspace } from './studio-store.ts';

const V1_DRAFT_KEY = 'theorem.studio.v1';
const V1_CHAT_KEY = 'theorem.studio.v1.chat';

/**
 * True when `value` has every section `shape` has, all the way down, and lists, text and
 * switches where it has them. A draft kept before the draft changed shape fails it, so it is
 * set aside rather than compiled.
 */
function hasShapeOf(value: unknown, shape: unknown): boolean {
	if (Array.isArray(shape)) return Array.isArray(value);
	if (typeof shape === 'string' || typeof shape === 'boolean') return typeof value === typeof shape;
	if (!isRecord(shape)) return true;
	if (!isRecord(value)) return false;
	return Object.entries(shape).every(([key, part]) => hasShapeOf(value[key], part));
}

function isWorkspace(value: unknown): value is StudioWorkspace {
	if (!isRecord(value) || value.v !== STUDIO_WORKSPACE_VERSION) return false;
	const { agents, toolSpecs, selected, chatWith } = value;
	if (!Array.isArray(agents) || agents.length === 0 || !Array.isArray(toolSpecs)) return false;
	if (typeof selected !== 'string' || typeof chatWith !== 'string') return false;
	if (!isRecord(value.starts) || !isRecord(value.starts.agents) || !isRecord(value.starts.tools))
		return false;
	const blank = createBlankDraft();
	const workspace = value as unknown as StudioWorkspace;
	return agents.every(
		(agent: unknown) =>
			isRecord(agent) &&
			typeof agent.key === 'string' &&
			isRecord(agent.tools) &&
			Array.isArray(agent.tools.allow) &&
			hasShapeOf(agentDraft(workspace, agent.key), blank),
	);
}

function isStoredWorkspace(value: unknown): value is StoredWorkspace {
	return (
		isRecord(value) &&
		value.v === STUDIO_WORKSPACE_VERSION &&
		isWorkspace(value.workspace) &&
		typeof value.revision === 'number'
	);
}

/** A one-agent draft kept before workspaces, as the studio kept it. */
function isV1Draft(
	value: unknown,
): value is { v: 1; draft: StudioDraft; revision: number; selectedId: string } {
	return (
		isRecord(value) &&
		value.v === 1 &&
		hasShapeOf(value.draft, createBlankDraft()) &&
		typeof value.revision === 'number' &&
		typeof value.selectedId === 'string'
	);
}

function parsed(store: Storage, key: string): unknown {
	const raw = store.getItem(key);
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

/**
 * A one-agent draft from before workspaces, as a workspace holding it; its conversation becomes
 * that agent's. Either way the old keys go.
 */
function migrateV1(store: Storage): RestoredStudio | 'discarded' | undefined {
	const kept = parsed(store, V1_DRAFT_KEY);
	if (kept === undefined) return undefined;
	const chat = store.getItem(V1_CHAT_KEY);
	store.removeItem(V1_DRAFT_KEY);
	store.removeItem(V1_CHAT_KEY);
	if (!isV1Draft(kept)) return 'discarded';
	const workspace = workspaceFromDraft(kept.draft, kept.selectedId);
	if (chat) store.setItem(`${CHAT_PREFIX}${workspace.chatWith}`, chat);
	return { workspace, revision: kept.revision };
}

function forgetAll(store: Storage) {
	store.removeItem(WORKSPACE_KEY);
	for (const key of Object.keys(store)) {
		if (key.startsWith(CHAT_PREFIX)) store.removeItem(key);
	}
}

/**
 * The workspace this tab last kept. `discarded` when one was there but could not be read back (an
 * older shape after a deploy, or a broken write); it is removed so the next load starts clean.
 */
export function restoreStudio():
	| { kind: 'restored'; value: RestoredStudio }
	| { kind: 'none' | 'discarded' } {
	const store = session();
	if (!store) return { kind: 'none' };
	const kept = parsed(store, WORKSPACE_KEY);
	if (kept === undefined) {
		const migrated = migrateV1(store);
		if (migrated === 'discarded') return { kind: 'discarded' };
		return migrated ? { kind: 'restored', value: migrated } : { kind: 'none' };
	}
	if (isStoredWorkspace(kept)) {
		const { workspace, revision } = kept;
		return { kind: 'restored', value: { workspace, revision } };
	}
	forgetAll(store);
	return { kind: 'discarded' };
}

const MASKED = ['endpoint', 'serverUrl', 'headersJson'] as const;

/**
 * A kept workspace with what keeping it masked put back from the files: a tool's URLs and headers,
 * in its start and wherever the builder had not changed them. One they did change stays masked.
 */
function withFilesCredentials(kept: StudioWorkspace, files: StudioWorkspace): StudioWorkspace {
	const held = new Map(files.toolSpecs.map((tool) => [tool.toolName, tool]));
	const starts = { ...kept.starts.tools };
	const tools = new Map(kept.toolSpecs.map((tool) => [tool.key, tool]));
	for (const [key, start] of Object.entries(kept.starts.tools)) {
		const file = held.get(start.toolName);
		if (!file) continue;
		const masked = keptTool(file);
		const now = tools.get(key);
		const back = { ...start };
		const next = now && { ...now };
		for (const field of MASKED) {
			if (file[field] === undefined || start[field] !== masked[field]) continue;
			back[field] = file[field];
			if (next && now[field] === start[field]) next[field] = file[field];
		}
		starts[key] = back;
		if (next) tools.set(key, next);
	}
	return {
		...kept,
		toolSpecs: kept.toolSpecs.map((tool) => tools.get(tool.key) ?? tool),
		starts: { ...kept.starts, tools: starts },
	};
}

/** Where a project's set-aside edits wait for the builder's answer. */
const asideKey = (key: string) => `${key}.aside`;

/**
 * Keeps edits the project's files changed under, masked as the tab keeps a workspace, until the
 * builder brings them back or lets them go. A reload offers them again.
 */
export function setAside(key: string, edits: StudioWorkspace): void {
	const record: StoredWorkspace = {
		v: STUDIO_WORKSPACE_VERSION,
		workspace: keptWorkspace(edits),
		revision: 0,
	};
	try {
		session()?.setItem(asideKey(key), JSON.stringify(record));
	} catch {
		// Quota or a blocked store: the offer on the page still holds the edits.
	}
}

/** Forgets a project's set-aside edits: the builder brought them back or let them go. */
export function dropAside(key: string): void {
	session()?.removeItem(asideKey(key));
}

/** The edits set aside for a project and not yet answered for, over the files as `opened`. */
export function editsAside(key: string, opened: StudioWorkspace): StudioWorkspace | undefined {
	const store = session();
	const kept = store ? parsed(store, asideKey(key)) : undefined;
	if (kept === undefined) return undefined;
	if (isStoredWorkspace(kept)) return withFilesCredentials(kept.workspace, opened);
	dropAside(key);
	return undefined;
}

/** Where the files a project's kept edits stand on wait, as the studio read them. */
const readingKey = (key: string) => `${key}.read`;

/**
 * Keeps the files as the studio read them, beside the edits that stand on that reading. It says
 * which profiles the builder removed, so a merge after a reload leaves them removed.
 */
export function keepReading(key: string, print: string, read: StudioWorkspace): void {
	const record: StoredWorkspace = {
		v: STUDIO_WORKSPACE_VERSION,
		workspace: keptWorkspace(read),
		revision: 0,
		files: print,
	};
	try {
		session()?.setItem(readingKey(key), JSON.stringify(record));
	} catch {
		// Quota or a blocked store: a profile removed here comes back after a reload.
	}
}

/** The files as the studio read them when they printed as `print`, if this tab kept that reading. */
export function keptReading(key: string, print: string | undefined): StudioWorkspace | undefined {
	const store = session();
	const kept = store ? parsed(store, readingKey(key)) : undefined;
	return isStoredWorkspace(kept) && kept.files === print ? kept.workspace : undefined;
}

/**
 * The edits this tab kept for a project. `restored` with the reading of the files they stand on:
 * when the files changed since, the studio merges the change into them as it does one the
 * builder's editor writes while the page is open. `moved` when the edits stand on no reading, so
 * nothing says what the files changed: the files open, and the edits are set aside and handed back
 * to be offered. Kept edits that cannot be read back are removed.
 */
export function restoreProject(
	key: string,
	opened: StudioWorkspace,
	files: string,
):
	| { kind: 'restored'; value: RestoredStudio }
	| { kind: 'moved'; workspace: StudioWorkspace }
	| { kind: 'none' | 'discarded' } {
	const store = session();
	if (!store) return { kind: 'none' };
	const kept = parsed(store, key);
	if (kept === undefined) return { kind: 'none' };
	if (!isStoredWorkspace(kept)) {
		store.removeItem(key);
		return { kind: 'discarded' };
	}
	const workspace = withFilesCredentials(kept.workspace, opened);
	if (kept.files === files) {
		return {
			kind: 'restored',
			value: { workspace, revision: kept.revision, project: { key, files } },
		};
	}
	// With nothing edited the files open as they are.
	const isEdited = kept.files === undefined || editedSince(kept.workspace, kept.files);
	if (isEdited && kept.files !== undefined) {
		return {
			kind: 'restored',
			value: { workspace, revision: kept.revision, project: { key, files: kept.files } },
		};
	}
	store.removeItem(key);
	if (!isEdited) return { kind: 'none' };
	setAside(key, kept.workspace);
	return { kind: 'moved', workspace };
}
