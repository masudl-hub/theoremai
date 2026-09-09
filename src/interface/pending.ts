/**
 * Composer pending messages — stash / queue / steer (headless).
 *
 * Ownership: interface layer. Delivery:
 * - `steer` → host `TurnRequest.onSteer` at kernel barriers (same run)
 * - `queue` → new user turn after the agent run fully ends (not on tool pause)
 * - `stash` → never auto-sent; user must promote
 *
 * `send_now` (abort + send) is an immediate action, not a pending kind.
 *
 * @module
 */

import type { UserTurnDraft } from './types.ts';

/** Pending kinds — ordered for display: steers, then queues, then stashes. */
export const COMPOSER_PENDING_KINDS = ['steer', 'queue', 'stash'] as const;
export type ComposerPendingKind = (typeof COMPOSER_PENDING_KINDS)[number];

/** One user-authored item waiting to send, steer, or stay stashed. */
export interface ComposerPendingMessage {
  id: string;
  kind: ComposerPendingKind;
  draft: UserTurnDraft;
  createdAt: number;
  updatedAt: number;
}

export type CreateComposerPendingMessageArgs = {
  kind: ComposerPendingKind;
  draft: UserTurnDraft;
  id?: string;
  now?: number;
};

function createPendingId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True when the draft would submit as a user turn. */
function userDraftHasPayload(draft: UserTurnDraft): boolean {
  return Boolean(
    draft.text?.trim() ||
      (draft.attachments && draft.attachments.length > 0) ||
      (draft.voice && draft.voice.length > 0),
  );
}

/** Short preview for pending bars (text, else attachment hint). */
function composerPendingPreview(message: ComposerPendingMessage): string {
  const text = message.draft.text?.trim();
  if (text) return text;
  const files = (message.draft.attachments?.length ?? 0) + (message.draft.voice?.length ?? 0);
  if (files > 0) return files === 1 ? '(attachment)' : `(${files} attachments)`;
  return '';
}

/** Create a pending message; rejects empty drafts. */
function createComposerPendingMessage(
  args: CreateComposerPendingMessageArgs,
): ComposerPendingMessage {
  if (!userDraftHasPayload(args.draft)) {
    throw new Error('Composer pending message requires a non-empty draft');
  }
  const now = args.now ?? Date.now();
  return {
    id: args.id ?? createPendingId(),
    kind: args.kind,
    draft: cloneUserTurnDraft(args.draft),
    createdAt: now,
    updatedAt: now,
  };
}

function cloneUserTurnDraft(draft: UserTurnDraft): UserTurnDraft {
  return {
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.attachments ? { attachments: draft.attachments.map((a) => ({ ...a })) } : {}),
    ...(draft.voice ? { voice: draft.voice.map((a) => ({ ...a })) } : {}),
  };
}

/** Display / delivery order: steer → queue → stash (FIFO within kind). */
function orderComposerPendingMessages(
  messages: readonly ComposerPendingMessage[],
): ComposerPendingMessage[] {
  return [
    ...messages.filter((m) => m.kind === 'steer'),
    ...messages.filter((m) => m.kind === 'queue'),
    ...messages.filter((m) => m.kind === 'stash'),
  ];
}

/**
 * When a run ends, undelivered steers become queues at the front of the queue
 * list (before existing queues). Stashes unchanged.
 */
function convertSteersToFrontQueued(
  messages: readonly ComposerPendingMessage[],
  now = Date.now(),
): ComposerPendingMessage[] {
  const steers = messages
    .filter((m) => m.kind === 'steer')
    .map((m) => ({
      ...m,
      kind: 'queue' as const,
      updatedAt: now,
    }));
  const queues = messages.filter((m) => m.kind === 'queue');
  const stashes = messages.filter((m) => m.kind === 'stash');
  return [...steers, ...queues, ...stashes];
}

/** Remove by id; no-op if missing. */
function removeComposerPendingMessage(
  messages: readonly ComposerPendingMessage[],
  id: string,
): ComposerPendingMessage[] {
  return messages.filter((m) => m.id !== id);
}

/** Replace draft (and bump updatedAt) for an existing pending id. */
function updateComposerPendingDraft(
  messages: readonly ComposerPendingMessage[],
  id: string,
  draft: UserTurnDraft,
  now = Date.now(),
): ComposerPendingMessage[] {
  if (!userDraftHasPayload(draft)) {
    throw new Error('Composer pending message requires a non-empty draft');
  }
  return messages.map((m) =>
    m.id === id
      ? {
          ...m,
          draft: cloneUserTurnDraft(draft),
          updatedAt: now,
        }
      : m,
  );
}

/**
 * Reorder within the same kind only. Cross-kind moves are rejected (no silent
 * convert). Returns a new ordered list.
 */
function moveComposerPendingWithinKind(
  messages: readonly ComposerPendingMessage[],
  id: string,
  direction: 'up' | 'down',
): ComposerPendingMessage[] {
  const message = messages.find((m) => m.id === id);
  if (!message) return [...messages];

  const sameKind = messages.filter((m) => m.kind === message.kind);
  const currentIndex = sameKind.findIndex((m) => m.id === id);
  if (currentIndex < 0) return orderComposerPendingMessages(messages);

  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= sameKind.length) {
    return orderComposerPendingMessages(messages);
  }

  const reordered = [...sameKind];
  const [removed] = reordered.splice(currentIndex, 1);
  if (!removed) return orderComposerPendingMessages(messages);
  reordered.splice(nextIndex, 0, removed);

  const byKind: Record<ComposerPendingKind, ComposerPendingMessage[]> = {
    steer: message.kind === 'steer' ? reordered : messages.filter((m) => m.kind === 'steer'),
    queue: message.kind === 'queue' ? reordered : messages.filter((m) => m.kind === 'queue'),
    stash: message.kind === 'stash' ? reordered : messages.filter((m) => m.kind === 'stash'),
  };
  return [...byKind.steer, ...byKind.queue, ...byKind.stash];
}

/**
 * Take the next pending steer (FIFO). Returns `{ message, remaining }`.
 * One steer per safe boundary — host should call once per `onSteer`.
 */
function consumeNextComposerSteer(messages: readonly ComposerPendingMessage[]): {
  message: ComposerPendingMessage | null;
  remaining: ComposerPendingMessage[];
} {
  const message = messages.find((m) => m.kind === 'steer') ?? null;
  if (!message) return { message: null, remaining: [...messages] };
  return {
    message,
    remaining: messages.filter((m) => m.id !== message.id),
  };
}

/**
 * Take the next queued message (FIFO). Stashes and steers are left alone.
 * Call only after the agent run has fully ended (not on tool pause).
 */
function consumeNextComposerQueue(messages: readonly ComposerPendingMessage[]): {
  message: ComposerPendingMessage | null;
  remaining: ComposerPendingMessage[];
} {
  const message = messages.find((m) => m.kind === 'queue') ?? null;
  if (!message) return { message: null, remaining: [...messages] };
  return {
    message,
    remaining: messages.filter((m) => m.id !== message.id),
  };
}

/**
 * Promote a stash (or any pending) to another kind in place.
 * Used when the user explicitly converts stash → queue/steer.
 */
function promoteComposerPendingKind(
  messages: readonly ComposerPendingMessage[],
  id: string,
  kind: ComposerPendingKind,
  now = Date.now(),
): ComposerPendingMessage[] {
  const updated = messages.map((m) =>
    m.id === id
      ? {
          ...m,
          kind,
          updatedAt: now,
        }
      : m,
  );
  return orderComposerPendingMessages(updated);
}

export {
  cloneUserTurnDraft,
  composerPendingPreview,
  consumeNextComposerQueue,
  consumeNextComposerSteer,
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  moveComposerPendingWithinKind,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  updateComposerPendingDraft,
  userDraftHasPayload,
};
