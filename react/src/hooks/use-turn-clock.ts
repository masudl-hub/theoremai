import { useRef } from 'react';
import { replyKey, type TranscriptTurnGroup, type TurnSpan } from '../client/transcript-groups.ts';

/**
 * When each turn was first seen, and how long each sat paused on approvals.
 * invariant: One clock per chat: the transcript's status line and the composer's working pill
 * read the same one, so they show the same time.
 */
export type TurnClock = {
  timeOf: (key: string) => number;
  spans: ReadonlyMap<string, TurnSpan>;
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
  const timeOf = useFirstSeen(
    groups.map((group, index) => (group.kind === 'user' ? group.key : replyKey(groups, index))),
  );
  const spans = useTurnSpans(streaming, groups.findLast((group) => group.kind === 'user')?.key);
  return { timeOf, spans };
}

/** When the reply in progress started, its approval waits skipped; `undefined` when none runs. */
export function liveTurnStart(
  groups: readonly TranscriptTurnGroup[],
  clock: TurnClock,
  streaming: boolean,
): number | undefined {
  if (!streaming) return undefined;
  const prompt = groups.findLast((group) => group.kind === 'user');
  if (!prompt) return undefined;
  const span = clock.spans.get(prompt.key);
  return span ? clock.timeOf(prompt.key) + span.pausedMs : undefined;
}
