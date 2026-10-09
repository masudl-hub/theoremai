import type { InputStatus } from '@astryxdesign/core/Field';
import type { StudioConnectionMode, StudioIssue } from '../mod.ts';
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

/** Execution policy selected by the studio; credentials stay outside editor state. */
export const ConnectionMode = createContext<StudioConnectionMode>('demo');

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
 * The workspace around the agent the editor shows: the agents it can name, and which of the
 * library's tools it allows. `null` when the editor shows a single draft.
 */
export const WorkspaceContext = createContext<{
	agents: readonly WorkspaceAgent[];
	self: string;
	allowed: readonly string[];
	setAllowed: (toolKey: string, allowed: boolean) => void;
} | null>(null);
