import { labelText } from '../../../guardrails/labels.ts';
import type { MediaRefused, RefusedMedia } from '../../turn-events.ts';
import type { InteractionPart, Profile, TurnHistoryMessage } from '../../types.ts';
import type { StepExecutionState } from './state.ts';

/** The files a retry took out, and how to put them back if the retry fails too. */
export interface RefusedMediaTry {
  dropped: RefusedMedia[];
  said: string;
  originals: Map<number, TurnHistoryMessage>;
  /** The types the provider named, each one dropped once; empty when it named none, and only then are `originals` kept. */
  named: Set<string>;
}

function isMedia(part: InteractionPart): boolean {
  return part.type !== 'text';
}

function holdsMedia(message: TurnHistoryMessage): boolean {
  return message.parts?.some(isMedia) === true;
}

/** why: a provider may name a refused type with parameters the message's file does not carry, or without them, so a type matches on its name alone. */
function typeKey(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** invariant: a named `image/*` is every image, as a MIME wildcard is. */
function isNamed(part: InteractionPart, named: ReadonlySet<string>): boolean {
  if (!isMedia(part) || !('mimeType' in part)) return false;
  const type = typeKey(part.mimeType);
  return named.has(type) || named.has(`${type.split('/')[0] ?? ''}/*`);
}

function noteKey(mimeType: string, fromTool: boolean) {
  if (fromTool) return 'turn.media_refused_tool' as const;
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

/**
 * Whether the next call has a file to go without. Named types are new to this turn's tries and
 * held by a message; with none named, any file will do, once a turn.
 */
export function canDropMedia(
  state: StepExecutionState,
  named: readonly string[] | undefined,
  tried: RefusedMediaTry | undefined,
): boolean {
  if (!named?.length) return !tried && state.currentHistory.some(holdsMedia);
  if (tried && tried.named.size === 0) return false;
  const fresh = new Set(named.map(typeKey).filter((type) => !tried?.named.has(type)));
  return state.currentHistory.some((message) =>
    message.parts?.some((part) => isNamed(part, fresh)),
  );
}

/**
 * Puts a note where each file was, so the model knows what it could not read: the files of each
 * type the provider named, wherever the conversation holds them, or else every file at
 * `refusedAt`.
 */
export function dropMedia(
  state: StepExecutionState,
  said: string,
  labels: Profile['labels'],
  named: readonly string[] | undefined,
  tried: RefusedMediaTry | undefined,
): RefusedMediaTry {
  const next: RefusedMediaTry = tried ?? {
    dropped: [],
    said: '',
    originals: new Map(),
    named: new Set(),
  };
  next.said = next.said ? `${next.said}\n${said}` : said;
  const types = new Set((named ?? []).map(typeKey));
  for (const type of types) next.named.add(type);
  const drops = (part: InteractionPart) => (types.size > 0 ? isNamed(part, types) : isMedia(part));
  const at = types.size > 0 ? state.currentHistory.map((_, index) => index) : refusedAt(state);
  for (const index of at) {
    const message = state.currentHistory[index];
    if (!message?.parts?.some(drops)) continue;
    const from = index < state.turnStart ? 'history' : message.role === 'tool' ? 'tool' : 'input';
    if (types.size === 0) next.originals.set(index, message);
    state.currentHistory[index] = {
      ...message,
      parts: message.parts.map((part) => {
        if (!drops(part) || part.type === 'text') return part;
        next.dropped.push({ mimeType: part.mimeType, from });
        return {
          type: 'text',
          text: labelText(noteKey(part.mimeType, message.role === 'tool'), {}, labels),
        };
      }),
    };
  }
  return next;
}

/** The retry failed as well, and the files it went without come back. */
export function restoreMedia(state: StepExecutionState, tried: RefusedMediaTry): void {
  for (const [at, message] of tried.originals) state.currentHistory[at] = message;
}

/** What the host reads on `done`. */
export function refusedReport(tried: RefusedMediaTry): MediaRefused {
  return { dropped: tried.dropped, said: tried.said };
}
