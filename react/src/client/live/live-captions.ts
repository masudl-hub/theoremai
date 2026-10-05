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

/** Fold a thought into the captions: it extends an open thought line, else starts one. */
export function applyLiveThought(state: LiveCaptionState, text: string): LiveCaptionState {
	if (!text) return state;
	const turns = [...state.turns];
	const last = turns.at(-1);
	if (last?.role === 'thought') {
		turns[turns.length - 1] = { ...last, text: `${last.text}${text}` };
	} else {
		turns.push({ id: nextTurnId(state), role: 'thought', text });
	}
	return { ...state, turns };
}

/** One caption message: what the user said, or the agent's thought and the speech after it. */
export type LiveCaptionLine =
	| { id: string; role: 'user'; text: string }
	| { id: string; role: 'agent'; thought?: string; text?: string };

function captionLine({ id, role, text }: LiveCaptionTurn): LiveCaptionLine {
	if (role === 'user') return { id, role, text };
	return role === 'thought' ? { id, role: 'agent', thought: text } : { id, role, text };
}

/** Group caption turns into messages: a thought and the speech that follows it share one. */
export function liveCaptionLines(turns: readonly LiveCaptionTurn[]): LiveCaptionLine[] {
	const lines: LiveCaptionLine[] = [];
	for (const turn of turns) {
		const last = lines.at(-1);
		if (turn.role === 'agent' && last?.role === 'agent' && last.text === undefined) {
			lines[lines.length - 1] = { ...last, text: turn.text };
		} else {
			lines.push(captionLine(turn));
		}
	}
	return lines;
}

/** Clear streaming partials when a live turn completes or is interrupted. */
export function clearLiveCaptionInterim(state: LiveCaptionState): LiveCaptionState {
	if (!state.interimUser && !state.interimAgent) return state;
	return { ...state, interimUser: '', interimAgent: '' };
}

export function latestLiveCaptionTurnId(state: LiveCaptionState): string | null {
	return state.turns.at(-1)?.id ?? null;
}
