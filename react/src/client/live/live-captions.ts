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

/** How much of a broken-off line the next one must repeat to count as starting it again. */
const RESTART_MATCH = 24;

function sharedStart(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

/** The later line opens with the same words as the earlier one, or with all of it when it is short. */
function restarts(earlier: string, later: string): boolean {
  const start = earlier.trim();
  return sharedStart(start, later.trim()) >= Math.min(start.length, RESTART_MATCH);
}

/**
 * Drops speech the agent broke off and began again in the same reply, which a
 * tool call mid-sentence makes it do: the line that starts over replaces it.
 */
function withoutRestarts(lines: readonly LiveCaptionTurn[]): LiveCaptionTurn[] {
  return lines.filter((line, index) => {
    if (line.role !== 'agent') return true;
    const after = lines.slice(index + 1);
    const nextUser = after.findIndex((later) => later.role === 'user');
    const reply = nextUser === -1 ? after : after.slice(0, nextUser);
    return !reply.some((later) => later.role === 'agent' && restarts(line.text, later.text));
  });
}

export type LiveCaptionTranscript = {
  blocks: TranscriptBlock[];
  /** The first block of each call after the first: where one call's captions end and the next begin. */
  callStarts: string[];
};

/** Captions as the chat's transcript blocks: past calls, this call, then the lines still being heard. */
export function liveCaptionTranscript(
  pastCalls: readonly (readonly LiveCaptionTurn[])[],
  { turns, interimUser, interimAgent }: LiveCaptionState,
): LiveCaptionTranscript {
  const current = [...turns];
  if (interimUser) current.push({ id: 'interim-user', role: 'user', text: interimUser });
  if (interimAgent) current.push({ id: 'interim-agent', role: 'agent', text: interimAgent });
  const calls = [
    ...pastCalls.map((call, index) =>
      call.map((turn) => ({ ...turn, id: `${String(index)}:${turn.id}` })),
    ),
    current,
  ]
    .map(withoutRestarts)
    .filter((call) => call.length > 0);
  return {
    blocks: calls.flat().map(({ id, role, text }) => ({ id, kind: BLOCK_KIND[role], text })),
    callStarts: calls.slice(1).map((call) => call[0].id),
  };
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
