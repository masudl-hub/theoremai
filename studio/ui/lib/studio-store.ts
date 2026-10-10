/**
 * The studio's workspace, kept in this tab's sessionStorage so it outlives a reload or a trip
 * to the docs and back. Every change bumps a revision, so th30 can tell its own edits from the
 * visitor's. Keys never come here: the vault stays in memory, and a tool's URLs and headers are kept
 * with their credentials masked.
 */
import { maskHeaders, maskUrl } from '../../../src/surface/mod.ts';
import {
	agentNodeId,
	createBlankDraft,
	libraryDraft,
	type SharedCarry,
	type SharedReach,
	type SharedSites,
	type SharedSnapshot,
	sharedSnapshot,
	STUDIO_WORKSPACE_VERSION,
	type StudioDraft,
	type StudioWorkspace,
	type ToolSpecDraft,
	withLibraryDraft,
	withSharedCarry,
} from '../../mod.ts';
import {
	isRecord,
	type RestoredStudio,
	type StoredWorkspace,
	session,
	WORKSPACE_KEY,
} from './studio-session.ts';

const WRITE_MS = 300;
/** Beside the workspace's key: the builder said not to be asked about shared values again. */
const QUIET_SUFFIX = '.shared-quiet';
const CHANGES_SIZE = 50;

export type DraftAuthor = 'th30' | 'visitor';

/** Which sections one change touched, and who made it. */
export interface DraftChange {
	revision: number;
	by: DraftAuthor;
	sections: string[];
}

const CREDENTIAL_TEXT = /auth|key|token|secret|passw|cookie|session|signature|credential/i;

/**
 * Headers as kept: unchanged (formatting and all) when nothing in them is a credential, masked when
 * something is. Text that isn't JSON yet is kept unless it looks like it carries one.
 */
function keptHeaders(raw: string): string {
	let parsedHeaders: unknown;
	try {
		parsedHeaders = JSON.parse(raw);
	} catch {
		return CREDENTIAL_TEXT.test(raw) ? '' : raw;
	}
	const masked = maskHeaders(raw);
	return typeof masked === 'string' && masked !== JSON.stringify(parsedHeaders) ? masked : raw;
}

/** A tool as kept: its URLs and headers with their credentials masked. */
export function keptTool(tool: ToolSpecDraft): ToolSpecDraft {
	return {
		...tool,
		...(tool.endpoint ? { endpoint: maskUrl(tool.endpoint) } : {}),
		...(tool.serverUrl ? { serverUrl: maskUrl(tool.serverUrl) } : {}),
		...(tool.headersJson ? { headersJson: keptHeaders(tool.headersJson) } : {}),
	};
}

/**
 * The workspace as kept: each tool's URLs and headers with their credentials masked, in the library
 * and in the starts a reset puts back.
 */
export function keptWorkspace(workspace: StudioWorkspace): StudioWorkspace {
	return {
		...workspace,
		toolSpecs: workspace.toolSpecs.map(keptTool),
		starts: {
			...workspace.starts,
			tools: Object.fromEntries(
				Object.entries(workspace.starts.tools).map(([key, tool]) => [key, keptTool(tool)]),
			),
		},
	};
}

/** True when two values are the same, or records holding the same values. */
function sameSection(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].every((key) => a[key] === b[key]);
}

/**
 * The top-level draft sections that differ. Drafts are immutable, so a section that changed is a new
 * object; the agent's lens rebuilds its tools section on every read, so that one is compared a level in.
 */
function changedSections(
	before: StudioDraft | undefined,
	after: StudioDraft | undefined,
): string[] {
	const was: Record<string, unknown> = { ...before };
	const now: Record<string, unknown> = { ...after };
	const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
	return [...keys].filter((key) => !sameSection(was[key], now[key]));
}

/** The agent whose draft an open node is under; a library tool keeps the one open before it. */
function agentOf(workspace: StudioWorkspace, id: string): string | undefined {
	return workspace.agents.find((agent) => {
		const root = agentNodeId(agent.key);
		return id === root || id.startsWith(`${root}/`);
	})?.key;
}

/** The store's mutable state, shared by the helpers below. */
interface StoreState {
	workspace: StudioWorkspace;
	/** Where the project's files write each value more than one setting reads. */
	sites: SharedSites | undefined;
	/** The last workspace that compiled: what a change to a shared value is read against. */
	good: SharedSnapshot | undefined;
	/** A change to a shared value, held until the builder says to make it. */
	pending: { carry: SharedCarry; reach: SharedReach; by: DraftAuthor } | undefined;
	/** The shared places the builder said to change, while the same node stays open. */
	agreed: Set<number>;
	revision: number;
	focus: string;
	changes: DraftChange[];
	listeners: Set<() => void>;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** The sessionStorage key the workspace is written under. */
	slot: string;
	/** For a project's workspace: the print of the files its starts stand on. */
	files: string | undefined;
	view: { agents: unknown; toolSpecs: unknown; focus: string; draft: StudioDraft } | undefined;
}

/** Writes the workspace, masked, to sessionStorage. */
function writeWorkspace(state: StoreState): void {
	state.timer = undefined;
	const record: StoredWorkspace = {
		v: STUDIO_WORKSPACE_VERSION,
		workspace: keptWorkspace(state.workspace),
		revision: state.revision,
		...(state.files === undefined ? {} : { files: state.files }),
	};
	try {
		session()?.setItem(state.slot, JSON.stringify(record));
	} catch {
		// Quota or a blocked store: the page keeps working on what is in memory.
	}
}

/** Queues a write, unless one is already queued. */
function scheduleWrite(state: StoreState): void {
	state.timer ??= setTimeout(() => {
		writeWorkspace(state);
	}, WRITE_MS);
}

function notifyListeners(state: StoreState): void {
	for (const listener of state.listeners) listener();
}

/** The focused agent: the last one opened, or the first once that one is gone. */
function focusOf(state: StoreState): string {
	return state.workspace.agents.some((agent) => agent.key === state.focus)
		? state.focus
		: (state.workspace.agents[0]?.key ?? '');
}

/** The focused agent's draft; the same object until the workspace or the focus changes. */
function draftOf(state: StoreState): StudioDraft {
	const { workspace } = state;
	let { view } = state;
	const key = focusOf(state);
	if (
		view?.agents !== workspace.agents ||
		view.toolSpecs !== workspace.toolSpecs ||
		view.focus !== key
	) {
		view = {
			agents: workspace.agents,
			toolSpecs: workspace.toolSpecs,
			focus: key,
			draft: libraryDraft(workspace, key) ?? createBlankDraft(),
		};
		state.view = view;
	}
	return view.draft;
}

/** `made`, with a change to a value the files write once made on every agent that shares it. */
function sharedCarry(state: StoreState, made: StudioWorkspace): SharedCarry {
	if (!state.sites) return { workspace: made };
	state.good ??= sharedSnapshot(state.workspace);
	if (!state.good) return { workspace: made, snapshot: sharedSnapshot(made) };
	return withSharedCarry(state.good, made, state.sites);
}

/** Whether the builder said not to be asked again, for this tab. */
function isQuiet(state: StoreState): boolean {
	try {
		return session()?.getItem(`${state.slot}${QUIET_SUFFIX}`) === '1';
	} catch {
		return false;
	}
}

/**
 * Moves to `next`, as the visitor's or th30's change, with the move in the open node. The
 * visitor's change to a shared value is held until they say to make it: `confirmShared`.
 */
function updateWorkspace(
	state: StoreState,
	next: StudioWorkspace | ((current: StudioWorkspace) => StudioWorkspace),
	by: DraftAuthor,
): StudioWorkspace {
	const made = typeof next === 'function' ? next(state.workspace) : next;
	if (made === state.workspace) return state.workspace;
	const carry = sharedCarry(state, made);
	const { reach } = carry;
	const asks = reach && by === 'visitor' && !isQuiet(state) &&
		reach.sites.some((site) => !state.agreed.has(site));
	if (reach && asks) {
		state.pending = { carry, reach, by };
		notifyListeners(state);
		return state.workspace;
	}
	return commitWorkspace(state, carry, by);
}

function commitWorkspace(state: StoreState, carry: SharedCarry, by: DraftAuthor): StudioWorkspace {
	state.pending = undefined;
	if (carry.snapshot) state.good = carry.snapshot;
	const before = draftOf(state);
	const agentsBefore = state.workspace.agents.map((agent) => agent.key).join();
	state.workspace = carry.workspace;
	state.focus = agentOf(state.workspace, state.workspace.selected) ?? state.focus;
	const sections = changedSections(before, draftOf(state));
	if (state.workspace.agents.map((agent) => agent.key).join() !== agentsBefore) {
		sections.push('agents');
	}
	state.revision += 1;
	state.changes = [...state.changes, { revision: state.revision, by, sections }].slice(
		-CHANGES_SIZE,
	);
	scheduleWrite(state);
	notifyListeners(state);
	return state.workspace;
}

/** Changes the workspace without an edit: no revision, no change record. */
function moveWorkspace(state: StoreState, workspace: StudioWorkspace): void {
	state.workspace = workspace;
	scheduleWrite(state);
	notifyListeners(state);
}

/** Changes the focused agent's draft; a no-op keeps the revision. Returns the draft now held. */
function updateFocusedDraft(
	state: StoreState,
	next: StudioDraft | ((current: StudioDraft) => StudioDraft),
	by: DraftAuthor,
): StudioDraft {
	const current = draftOf(state);
	const value = typeof next === 'function' ? next(current) : next;
	if (value !== current) {
		updateWorkspace(state, withLibraryDraft(state.workspace, focusOf(state), value), by);
	}
	return draftOf(state);
}

/** Opens a node: not an edit, so the revision stays. An agent's node focuses that agent. */
function selectNode(state: StoreState, id: string): void {
	if (id === state.workspace.selected) return;
	const workspace = { ...state.workspace, selected: id };
	state.focus = agentOf(workspace, id) ?? state.focus;
	state.agreed.clear();
	moveWorkspace(state, workspace);
}

export type StudioStore = ReturnType<typeof createStudioStore>;

/**
 * The workspace as an external store. `getWorkspace()` is current the moment `update` returns,
 * before React renders, so a th30 tool reads what it just did. th30 and the editor work on one
 * agent at a time, the focused one: `getDraft` and `updateDraft` read and write its draft, with
 * the whole tool library as its tools.
 */
export function createStudioStore(initial: RestoredStudio, sites?: SharedSites) {
	const state: StoreState = {
		workspace: initial.workspace,
		sites,
		good: undefined,
		pending: undefined,
		agreed: new Set(),
		revision: initial.revision,
		focus: agentOf(initial.workspace, initial.workspace.selected) ?? initial.workspace.chatWith,
		changes: [],
		listeners: new Set(),
		timer: undefined,
		slot: initial.project?.key ?? WORKSPACE_KEY,
		files: initial.project?.files,
		view: undefined,
	};
	const getFocus = () => focusOf(state);
	const getDraft = (): StudioDraft => draftOf(state);
	const update = (
		next: StudioWorkspace | ((current: StudioWorkspace) => StudioWorkspace),
		by: DraftAuthor = 'visitor',
	): StudioWorkspace => updateWorkspace(state, next, by);

	return {
		getWorkspace: () => state.workspace,
		getRevision: () => state.revision,
		getFocus,
		getDraft,
		update,
		/** Changes the focused agent's draft; a no-op keeps the revision. Returns the draft now held. */
		updateDraft: (
			next: StudioDraft | ((current: StudioDraft) => StudioDraft),
			by: DraftAuthor = 'visitor',
		): StudioDraft => updateFocusedDraft(state, next, by),
		/** Opens a node: not an edit, so the revision stays. An agent's node focuses that agent. */
		select: (id: string) => {
			selectNode(state, id);
		},
		/** Picks the agent the preview talks to; not an edit either. */
		chatWith: (key: string) => {
			if (key === state.workspace.chatWith) return;
			moveWorkspace(state, { ...state.workspace, chatWith: key });
		},
		/** Changes after `since`, oldest first; only the last 50 are kept. */
		changesSince: (since: number): DraftChange[] =>
			state.changes.filter((change) => change.revision > since),
		subscribe: (listener: () => void) => {
			state.listeners.add(listener);
			return () => {
				state.listeners.delete(listener);
			};
		},
		/**
		 * Says which reading of the project's files the starts stand on now: after a Save, an undo,
		 * or opening the files again.
		 */
		/** The reading of the project's files the starts stand on. */
		standsOn: () => state.files,
		/** Says where the files write each shared value now: after they are read again. */
		setSites: (next: SharedSites | undefined) => {
			state.sites = next;
			state.good = undefined;
		},
		/** What a held change to a shared value reaches. Undefined when none is held. */
		getPending: (): SharedReach | undefined => state.pending?.reach,
		/**
		 * Makes the held change, on every agent that shares the value. The same value is not asked
		 * about again while the same node stays open, and `quiet` stops the asking for this tab.
		 */
		confirmShared: (quiet = false) => {
			const { pending } = state;
			if (!pending) return;
			for (const site of pending.reach.sites) state.agreed.add(site);
			if (quiet) {
				try {
					session()?.setItem(`${state.slot}${QUIET_SUFFIX}`, '1');
				} catch {
					// Storage is full or off: the builder is asked again.
				}
			}
			commitWorkspace(state, pending.carry, pending.by);
		},
		/** Drops the held change: no agent has it. */
		cancelShared: () => {
			if (!state.pending) return;
			state.pending = undefined;
			notifyListeners(state);
		},
		standOn: (files: string) => {
			if (files === state.files) return;
			state.files = files;
			scheduleWrite(state);
		},
		/** Writes now if a write is pending; the route calls it on pagehide and unmount. */
		flush() {
			if (state.timer === undefined) return;
			clearTimeout(state.timer);
			writeWorkspace(state);
		},
	};
}
