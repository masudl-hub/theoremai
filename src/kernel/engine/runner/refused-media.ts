import { labelText } from '../../../guardrails/labels.ts';
import type { MediaRefused, RefusedMedia } from '../../turn-events.ts';
import type { InteractionPart, Profile, TurnHistoryMessage } from '../../types.ts';
import type { StepExecutionState } from './state.ts';

/** The files a retry took out, and how to put them back if the retry fails too. */
export interface RefusedMediaTry {
  dropped: RefusedMedia[];
  said: string;
  originals: Map<number, TurnHistoryMessage>;
}

function isMedia(part: InteractionPart): boolean {
  return part.type !== 'text';
}

function holdsMedia(message: TurnHistoryMessage): boolean {
  return message.parts?.some(isMedia) === true;
}

function noteKey(mimeType: string) {
  if (mimeType.startsWith('image/')) return 'turn.media_refused_image' as const;
  if (mimeType.startsWith('video/')) return 'turn.media_refused_video' as const;
  return 'turn.media_refused_file' as const;
}

/** The messages a refused call could do without: this turn's files, or else the conversation's. */
function refusedAt(state: StepExecutionState): number[] {
  const held = state.currentHistory.flatMap((message, at) => (holdsMedia(message) ? [at] : []));
  const thisTurn = held.filter((at) => at >= state.turnStart);
  return thisTurn.length > 0 ? thisTurn : held;
}

/** Whether the next call has a file to go without. */
export function canDropMedia(state: StepExecutionState): boolean {
  return state.currentHistory.some(holdsMedia);
}

/** Puts a note where each file was, so the model knows what it could not read. */
export function dropMedia(
  state: StepExecutionState,
  said: string,
  labels: Profile['labels'],
): RefusedMediaTry {
  const tried: RefusedMediaTry = { dropped: [], said, originals: new Map() };
  for (const at of refusedAt(state)) {
    const message = state.currentHistory[at];
    if (!message?.parts) continue;
    const from = at < state.turnStart ? 'history' : message.role === 'tool' ? 'tool' : 'input';
    tried.originals.set(at, message);
    state.currentHistory[at] = {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === 'text') return part;
        tried.dropped.push({ mimeType: part.mimeType, from });
        return { type: 'text', text: labelText(noteKey(part.mimeType), {}, labels) };
      }),
    };
  }
  return tried;
}

/** The retry failed as well, so no file is proven at fault. */
export function restoreMedia(state: StepExecutionState, tried: RefusedMediaTry): void {
  for (const [at, message] of tried.originals) state.currentHistory[at] = message;
}

/** What the host reads on `done`. */
export function refusedReport(tried: RefusedMediaTry): MediaRefused {
  return { dropped: tried.dropped, said: tried.said };
}
