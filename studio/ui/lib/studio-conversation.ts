/**
 * Each agent's preview conversation, kept in this tab's sessionStorage beside the workspace so a
 * reload resumes it. Media goes first, then the whole conversation, when it outgrows its budget.
 */
import type { TheoremChat } from '../../../react/src/ui/index.ts';
import type { ComponentProps } from 'react';
import { CHAT_PREFIX, session } from './studio-session.ts';

/** A chat conversation as TheoremChat reports and resumes it: the transcript and the model's memory. */
export type ChatSnapshot = NonNullable<ComponentProps<typeof TheoremChat>['initialChat']>;

/** Past this, a stored conversation drops its media, then its oldest turns. */
const CHAT_BUDGET = 2_000_000;

/** True for a value that carries media bytes: a long base64 `data` field or a data: URL. */
function isMedia(value: unknown): boolean {
	if (typeof value === 'string') return value.startsWith('data:') && value.length > 1024;
	if (typeof value !== 'object' || value === null) return false;
	const data: unknown = (value as { data?: unknown }).data;
	return typeof data === 'string' && data.length > 1024;
}

/** A copy with each media payload swapped for a note. */
function withoutMedia(value: unknown): unknown {
	if (isMedia(value)) return { omitted: 'media', note: 'Not kept after reload' };
	if (Array.isArray(value)) return value.map(withoutMedia);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, withoutMedia(inner)]),
		);
	}
	return value;
}

/**
 * Keeps an agent's preview conversation (its transcript and what the model remembers): whole while
 * it fits, then without media in either. Too big even then, nothing is kept. Never throws.
 */
export function saveConversation(agentKey: string, snapshot: ChatSnapshot): void {
	const store = session();
	if (!store) return;
	const key = `${CHAT_PREFIX}${agentKey}`;
	const whole = JSON.stringify(snapshot);
	const lean = whole.length <= CHAT_BUDGET ? whole : JSON.stringify(withoutMedia(snapshot));
	try {
		if (lean.length <= CHAT_BUDGET) {
			store.setItem(key, lean);
			return;
		}
	} catch {
		// Over quota: keep nothing rather than half a conversation.
	}
	try {
		store.removeItem(key);
	} catch {
		// Nothing more to do.
	}
}

/** An agent's kept conversation, when there is one in the shape the chat resumes from. */
export function restoreConversation(agentKey: string): ChatSnapshot | undefined {
	try {
		const raw = session()?.getItem(`${CHAT_PREFIX}${agentKey}`);
		if (!raw) return undefined;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) return undefined;
		const { blocks, session: kept } = value as { blocks?: unknown; session?: unknown };
		if (!Array.isArray(blocks) || typeof kept !== 'object' || kept === null) return undefined;
		return value as ChatSnapshot;
	} catch {
		return undefined;
	}
}

/** Forgets one agent's conversation, or every agent's. */
export function clearConversation(agentKey?: string): void {
	try {
		const store = session();
		if (!store) return;
		for (const key of Object.keys(store)) {
			if (
				agentKey === undefined ? key.startsWith(CHAT_PREFIX) : key === `${CHAT_PREFIX}${agentKey}`
			) {
				store.removeItem(key);
			}
		}
	} catch {
		// Nothing to clear.
	}
}
