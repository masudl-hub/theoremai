import type { TurnEvent } from '@theoremjs/agents';
import { foldTurnEvents, type TranscriptBlock } from '@theoremjs/agents/interface';

/** What the agent did between its lines of speech: the events the chat folds into a reply's work. */
export type LiveWorkEvent = Extract<TurnEvent, { type: 'thought' | 'tool' | 'citation' }>;

/** A line of speech, or the work the agent did before its next one. */
export type LiveCaptionTurn =
  | { id: string; role: 'user' | 'agent'; text: string }
  | { id: string; role: 'work'; events: LiveWorkEvent[] };

export type LiveCaptionState = {
  turns: LiveCaptionTurn[];
  interimUser: string;
  interimAgent: string;
  /** The agent has worked and its reply has not ended. */
  working: boolean;
};

export type ApplyLiveTranscriptOptions = {
  /** Commit as a new turn even when the last turn shares the same role (explicit text send). */
  forceNew?: boolean;
};

export function emptyLiveCaptionState(): LiveCaptionState {
  return { turns: [], interimUser: '', interimAgent: '', working: false };
}

/** Keep this call's lines so the next call starts below a divider. A call with no lines adds nothing. */
export function stashLiveCaptionCall(
  past: LiveCaptionTurn[][],
  turns: readonly LiveCaptionTurn[],
): LiveCaptionTurn[][] {
  if (turns.length === 0) return past;
  return [...past, [...turns]];
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
    ...state,
    turns,
    interimUser: isUser ? '' : state.interimUser,
    interimAgent: isUser ? state.interimAgent : '',
  };
}

function isWorkEvent(event: TurnEvent): event is LiveWorkEvent {
  return event.type === 'thought' || event.type === 'tool' || event.type === 'citation';
}

/** The work that made the call `callId`: where the call's later events go. -1 when no work made it. */
function callWorkIndex(turns: readonly LiveCaptionTurn[], callId: string): number {
  return turns.findIndex(
    (turn) =>
      turn.role === 'work' &&
      turn.events.some((made) => made.type === 'tool' && made.tool.callId === callId),
  );
}

/** Which line takes `event`: `turns.length` starts a new one, -1 leaves the event out. */
function workIndex(turns: readonly LiveCaptionTurn[], event: LiveWorkEvent): number {
  if (event.type === 'tool' && event.tool.phase !== undefined) {
    // why: The call view's dialog asks a gate's question; the transcript's card would ask it twice.
    return event.tool.phase === 'gate' ? -1 : callWorkIndex(turns, event.tool.callId);
  }
  const open = turns.at(-1)?.role === 'work';
  // why: The thought guard releases a held blank tail after the speech; it is not work of its own.
  if (event.type === 'thought' && !(open ? event.text : event.text.trim())) return -1;
  return open ? turns.length - 1 : turns.length;
}

/**
 * Fold a live turn event into the captions. A thought, a tool call or a citation joins the open
 * work, else starts it; a tool call's later events go to the work that made the call. `done` ends
 * the reply.
 */
export function applyLiveTurnEvent(state: LiveCaptionState, event: TurnEvent): LiveCaptionState {
  if (event.type === 'done') return state.working ? { ...state, working: false } : state;
  if (!isWorkEvent(event)) return state;
  const at = workIndex(state.turns, event);
  if (at === -1) return state;
  const turns = [...state.turns];
  const work = turns[at];
  turns[at] =
    work?.role === 'work'
      ? { ...work, events: [...work.events, event] }
      : { id: nextTurnId(state), role: 'work', events: [event] };
  return { ...state, turns, working: true };
}

/** A line as the chat's blocks: speech is one, work is what the chat folds its events into. */
function turnBlocks(turn: LiveCaptionTurn): TranscriptBlock[] {
  if (turn.role === 'work') return foldTurnEvents(turn.events, { idPrefix: turn.id });
  return [{ id: turn.id, kind: turn.role === 'user' ? 'user-text' : 'text', text: turn.text }];
}

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
    .map((call) => withoutRestarts(call).flatMap(turnBlocks))
    .filter((call) => call.length > 0);
  return {
    blocks: calls.flat(),
    callStarts: calls.slice(1).map((call) => call[0].id),
  };
}

/** The agent is mid-reply: a line of its speech is still arriving, or it is working. */
export function liveCaptionStreaming({ working, interimAgent }: LiveCaptionState): boolean {
  return interimAgent !== '' || working;
}

/** Clear streaming partials when a live turn completes or is interrupted. */
export function clearLiveCaptionInterim(state: LiveCaptionState): LiveCaptionState {
  if (!state.interimUser && !state.interimAgent) return state;
  return { ...state, interimUser: '', interimAgent: '' };
}

export function latestLiveCaptionTurnId(state: LiveCaptionState): string | null {
  return state.turns.at(-1)?.id ?? null;
}
