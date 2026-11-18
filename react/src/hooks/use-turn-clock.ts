import { useRef } from 'react';
import { replyKey, type TranscriptTurnGroup, type TurnSpan } from '../client/transcript-groups.ts';

/**
 * When each turn was first seen, and how long each sat paused on approvals.
 * invariant: One clock per chat: the transcript's status line and the composer's working pill
 * read the same one, so they show the same time.
 */
export type TurnClock = {
  /** When the turn with this key was first seen. */
  timeOf: (key: string) => number;
  /**
   * When the reply to `prompt` started, its approval waits skipped; `undefined` until it runs in
   * this session. A prompt split by a divider still finds its turn.
   */
  replyStart: (prompt: TranscriptTurnGroup) => number | undefined;
};

/** First-seen time per group key, so timestamps don't jump while streaming. */
function useFirstSeen(keys: readonly string[]): (key: string) => number {
  const times = useRef(new Map<string, number>());
  const now = Date.now();
  for (const key of keys) {
    if (!times.current.has(key)) times.current.set(key, now);
  }
  // why: A key first asked for later (a divider's group) keeps the time it was first asked for.
  return (key) => {
    const known = times.current.get(key);
    if (known !== undefined) return known;
    const at = Date.now();
    times.current.set(key, at);
    return at;
  };
}

/**
 * Each turn's span, keyed by the user group that started it. A turn stops at
 * a gate and streams again under the same prompt once it's answered; the wait
 * in between counts as paused, not worked.
 */
function useTurnSpans(
  streaming: boolean,
  lastUserKey: string | undefined,
): ReadonlyMap<string, TurnSpan> {
  const spans = useRef(new Map<string, TurnSpan>());
  // why: A transcript can mount already streaming, on the first send; that's the start.
  const wasStreaming = useRef(false);
  if (lastUserKey && streaming !== wasStreaming.current) {
    const now = Date.now();
    const span = spans.current.get(lastUserKey);
    if (streaming) {
      const pausedMs = span?.endedAt === undefined ? 0 : span.pausedMs + now - span.endedAt;
      spans.current.set(lastUserKey, { pausedMs });
    } else if (span) {
      spans.current.set(lastUserKey, { ...span, endedAt: now });
    }
  }
  wasStreaming.current = streaming;
  return spans.current;
}

/** The chat's turn clock over its grouped transcript. */
export function useTurnClock(
  groups: readonly TranscriptTurnGroup[],
  streaming: boolean,
): TurnClock {
  // why: Every block's id is seen now, so a transcript that groups with dividers finds its times.
  const timeOf = useFirstSeen(
    groups.flatMap((group, index) => [
      group.kind === 'user' ? group.key : replyKey(groups, index),
      ...group.blocks.flatMap((block) =>
        group.kind === 'user' ? [block.id, `${block.id}:reply`] : [block.id],
      ),
    ]),
  );
  const spans = useTurnSpans(streaming, groups.findLast((group) => group.kind === 'user')?.key);
  const turnKey = new Map<string, string>();
  for (const group of groups) {
    if (group.kind === 'user') for (const block of group.blocks) turnKey.set(block.id, group.key);
  }
  const replyStart = (prompt: TranscriptTurnGroup) => {
    const key = turnKey.get(prompt.blocks[0]?.id ?? '') ?? prompt.key;
    const span = spans.get(key);
    return span ? timeOf(key) + span.pausedMs : undefined;
  };
  return { timeOf, replyStart };
}

/** When the reply in progress started, its approval waits skipped; `undefined` when none runs. */
export function liveTurnStart(
  groups: readonly TranscriptTurnGroup[],
  clock: TurnClock,
  streaming: boolean,
): number | undefined {
  if (!streaming) return undefined;
  const prompt = groups.findLast((group) => group.kind === 'user');
  return prompt ? clock.replyStart(prompt) : undefined;
}
