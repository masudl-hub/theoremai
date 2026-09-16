export type LiveCaptionTurn = {
	id: string;
	role: 'user' | 'agent';
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

/** Clear streaming partials when a live turn completes or is interrupted. */
export function clearLiveCaptionInterim(state: LiveCaptionState): LiveCaptionState {
	if (!state.interimUser && !state.interimAgent) return state;
	return { ...state, interimUser: '', interimAgent: '' };
}

export function latestLiveCaptionTurnId(state: LiveCaptionState): string | null {
	return state.turns.at(-1)?.id ?? null;
}
