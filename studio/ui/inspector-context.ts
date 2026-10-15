import type { InputStatus } from '@astryxdesign/core/Field';
import {
	type NodeOrigins,
	rowOrigin,
	ON_OWN_KEYS,
	type StudioAsks,
	type StudioIssue,
	type StudioProvider,
	type StudioRunsOn,
	type WriteAsk,
} from '../mod.ts';
import type { SettingOrigin } from '../server/save-wire.ts';
import { createContext, useContext } from 'react';

// Kept out of inspector.tsx: a hot reload re-runs that module and would orphan these contexts.

/** The compile issues for the node being edited; rows show the ones on their field. */
export const NodeIssues = createContext<readonly StudioIssue[]>([]);

/**
 * Looks up the error status for a draft field of the node being edited, and for a list field, the
 * entry at `index`. Several issues on one field show as one message.
 */
export function useFieldStatus(): (field?: string, index?: number) => InputStatus | undefined {
	const issues = useContext(NodeIssues);
	return (field, index) => {
		if (field === undefined) return undefined;
		const messages = issues
			.filter((issue) => issue.field === field && issue.index === index)
			.map((issue) => issue.message);
		return messages.length ? { type: 'error', message: messages.join(' ') } : undefined;
	};
}

/**
 * The open node's settings that the project's files set in code, and how to see one in the
 * builder's editor. `null` when no project is open, or the files do not hold the node.
 */
export const RowOrigins = createContext<{
	scope: NodeOrigins;
	open: (origin: SettingOrigin) => void;
} | null>(null);

/**
 * Asks the builder before a real run of a tool that writes, and answers whether to run it. Where
 * no page mounts the question, the run is refused.
 */
export const ConfirmWrite = createContext<(ask: WriteAsk) => Promise<boolean>>(() =>
	Promise.resolve(false),
);

/** The project's tools that write: the ones the studio makes ask, and the ones it cannot. */
export const ProjectAsks = createContext<StudioAsks>({ asked: [], inside: [] });

/** The origin a section around a row has already named, so the row does not name it again. */
export const SaidOrigin = createContext<SettingOrigin | undefined>(undefined);

/**
 * The origin of the row or section at a catalog path, when the files set it in code: the studio
 * shows its value and does not change it. `said` when the editor already says so over the row:
 * once for the whole node, or on the section the row is in.
 */
export function useRowOrigin(path: string | undefined):
	| { origin: SettingOrigin; said: boolean; open: () => void }
	| undefined {
	const held = useContext(RowOrigins);
	const above = useContext(SaidOrigin);
	const origin = held && path !== undefined ? rowOrigin(held.scope, path) : undefined;
	if (!held || !origin) return undefined;
	return {
		origin,
		said: origin === held.scope.section || origin === held.scope.partly || origin === above,
		open: () => {
			held.open(origin);
		},
	};
}

/**
 * Called as the builder starts to leave a page inside a node (a detector's page, back to the list);
 * the function it returns, called once the next page is up, lets the issues left behind show.
 */
export const LeavePage = createContext<() => () => void>(() => () => undefined);

/** Marks a row that has an issue, so the issue pill can scroll to it. */
export const ISSUE_ROW_ATTRIBUTE = 'data-issue';

/**
 * How many of a list row's picks show as badges before the rest are counted: two while the editor
 * is at its default width or wider, one once it is narrowed.
 */
export const ListBadges = createContext(1);

/** What the studio runs on: the page's lent keys, the builder's own, or their machine. */
export const RunsOn = createContext<StudioRunsOn>(ON_OWN_KEYS);

import type { StudioConnectionState } from './studio-connection.tsx';
export const LocalConnection = createContext<Pick<
	StudioConnectionState,
	| 'localModels'
	| 'local'
	| 'setLocal'
	| 'remoteTools'
	| 'setRemoteTools'
	| 'runtime'
	| 'slots'
	| 'vault'
> | null>(null);

/** One agent of the workspace, as another agent's pickers name it. */
export interface WorkspaceAgent {
	key: string;
	agentId: string;
	type: string;
}

/**
 * The workspace around the agent the editor shows: the agents it can name, which of the library's
 * tools it allows, and, on a project, a way to add or change a provider. `null` when the editor
 * shows a single draft.
 */
export const WorkspaceContext = createContext<{
	agents: readonly WorkspaceAgent[];
	self: string;
	allowed: readonly string[];
	setAllowed: (toolKey: string, allowed: boolean) => void;
	addProvider: ((provider: StudioProvider) => void) | undefined;
	/** Puts a changed provider in the workspace; left out where the providers are not the builder's. */
	updateProvider: ((provider: StudioProvider) => void) | undefined;
	/** Who else calls `apiId` on the provider `id` besides the open agent's model `bindingKey` (`modelSharers`). */
	sharing: (bindingKey: string, id: string, apiId: string) => { models: string[]; agents: string[] };
} | null>(null);
