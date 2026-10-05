import type { TranscriptBlock } from '@theoremjs/agents/interface';

export type LiveCaptionTurn = {
	id: string;
	role: 'user' | 'agent' | 'thought';
	text: string;
};

export type LiveCaptionState = {
	turns: LiveCaptionTurn[];
	interimUser: string;
	interimAgent: string;
};

export type ApplyLiveTranscriptOptions = {
	/** Commit as a new turn even when the last turn shares the same role (explicit text send). */
	forceNew?: boolean;
};

export function emptyLiveCaptionState(): LiveCaptionState {
	return { turns: [], interimUser: '', interimAgent: '' };
}

function mergeInterimWithFinal(interim: string, final: string): string {
	if (!interim) return final;
	if (!final) return interim;
	if (final.startsWith(interim) || interim.startsWith(final)) {
		return final.length >= interim.length ? final : interim;
	}
	return appendTurnText(interim, final);
}

function appendTurnText(existing: string, chunk: string): string {
	if (!existing) return chunk;
	if (!chunk) return existing;
	const needsSpace =
		!existing.endsWith(' ') &&
		!chunk.startsWith(' ') &&
		!/^\s/.test(chunk) &&
		!/^[\s.,!?;:]/.test(chunk);
	return needsSpace ? `${existing} ${chunk}` : `${existing}${chunk}`;
}

function nextTurnId(state: LiveCaptionState): string {
	return `${String(Date.now())}-${String(state.turns.length)}`;
}

/**
 * Fold streaming ASR deltas into turn-by-turn caption lines.
 * Final chunks for the same role append to the open turn; role switches start a new turn.
 */
export function applyLiveTranscript(
	state: LiveCaptionState,
	text: string,
	isUser: boolean,
	interim?: boolean,
	options?: ApplyLiveTranscriptOptions,
): LiveCaptionState {
	if (!text) return state;

	if (interim) {
		return isUser ? { ...state, interimUser: text } : { ...state, interimAgent: text };
	}

	const role = isUser ? 'user' : 'agent';
	const turns = [...state.turns];
	const last = turns.at(-1);
	const interimText = isUser ? state.interimUser : state.interimAgent;

	if (!options?.forceNew && last?.role === role) {
		turns[turns.length - 1] = {
			...last,
			text: appendTurnText(last.text, text),
		};
	} else {
		const committed = options?.forceNew ? text : mergeInterimWithFinal(interimText, text);
		turns.push({
			id: nextTurnId(state),
			role,
			text: committed,
		});
	}

	return {
		turns,
		interimUser: isUser ? '' : state.interimUser,
		interimAgent: isUser ? state.interimAgent : '',
	};
}

/** Fold a thought into the captions: it extends an open thought line, else starts one unless it is blank. */
export function applyLiveThought(state: LiveCaptionState, text: string): LiveCaptionState {
	if (!text) return state;
	const turns = [...state.turns];
	const last = turns.at(-1);
	if (last?.role === 'thought') {
		turns[turns.length - 1] = { ...last, text: `${last.text}${text}` };
	} else if (text.trim()) {
		turns.push({ id: nextTurnId(state), role: 'thought', text });
	} else {
		return state;
	}
	return { ...state, turns };
}

const BLOCK_KIND = { user: 'user-text', agent: 'text', thought: 'thought' } as const;

/** Captions as the chat's transcript blocks: past calls, this call, then the lines still being heard. */
export function liveCaptionBlocks(
	pastCalls: readonly (readonly LiveCaptionTurn[])[],
	{ turns, interimUser, interimAgent }: LiveCaptionState,
): TranscriptBlock[] {
	const lines = [
		...pastCalls.flatMap((call, index) => call.map((turn) => ({ ...turn, id: `${String(index)}:${turn.id}` }))),
		...turns,
	];
	if (interimUser) lines.push({ id: 'interim-user', role: 'user', text: interimUser });
	if (interimAgent) lines.push({ id: 'interim-agent', role: 'agent', text: interimAgent });
	return lines.map(({ id, role, text }) => ({ id, kind: BLOCK_KIND[role], text }));
}

/** The agent is mid-reply: a line of its speech is still arriving, or it has thought and not yet spoken. */
export function liveCaptionStreaming({ turns, interimAgent }: LiveCaptionState): boolean {
	return interimAgent !== '' || turns.at(-1)?.role === 'thought';
}

/** Clear streaming partials when a live turn completes or is interrupted. */
export function clearLiveCaptionInterim(state: LiveCaptionState): LiveCaptionState {
	if (!state.interimUser && !state.interimAgent) return state;
	return { ...state, interimUser: '', interimAgent: '' };
}

export function latestLiveCaptionTurnId(state: LiveCaptionState): string | null {
	return state.turns.at(-1)?.id ?? null;
}
