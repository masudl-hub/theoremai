// invariant: `steer` injects at `onStage` boundaries of the same run; `queue` sends after the run fully ends
// (not on tool pause); `stash` never auto-sends. `send_now` is an action, not a pending kind.
// invariant: a message with `saved` is the host's. The page never sends it again, and no action changes it;
// it leaves the list when a reply reads it.

import type { TurnEvent } from '../kernel/types.ts';
import { hasRef } from '../kernel/user-parts.ts';
import type { UserTurnDraft } from './types.ts';

/** Display order: steers, then queues, then stashes. */
export const COMPOSER_PENDING_KINDS = ['steer', 'queue', 'stash'] as const;
/** One of {@linkcode COMPOSER_PENDING_KINDS}. */
export type ComposerPendingKind = (typeof COMPOSER_PENDING_KINDS)[number];

/** A message the user has set aside while a turn runs. */
export interface ComposerPendingMessage {
  id: string;
  kind: ComposerPendingKind;
  draft: UserTurnDraft;
  createdAt: number;
  updatedAt: number;
  /**
   * Set once the host saved the message itself: a reply reads it later. `landsAs` is each id a
   * reply names the message by.
   */
  saved?: { landsAs: readonly string[] };
}

/** What `createComposerPendingMessage` takes: the kind and the draft. */
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

/** True when the draft holds text, an attachment, or voice. */
function userDraftHasPayload(draft: UserTurnDraft): boolean {
  return Boolean(
    draft.text?.trim() ||
      hasRef(draft.parts) ||
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

/** Throws on an empty draft. */
function createComposerPendingMessage(
  args: CreateComposerPendingMessageArgs,
): ComposerPendingMessage {
  if (!userDraftHasPayload(args.draft)) {
    throw new Error('Composer pending message requires a non-empty draft'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
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

/** A copy of the draft that shares nothing with the original. */
function cloneUserTurnDraft(draft: UserTurnDraft): UserTurnDraft {
  return {
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.parts ? { parts: draft.parts.map((part) => ({ ...part })) } : {}),
    ...(draft.attachments ? { attachments: draft.attachments.map((a) => ({ ...a })) } : {}),
    ...(draft.voice ? { voice: draft.voice.map((a) => ({ ...a })) } : {}),
  };
}

/** Steer, then queue, then stash; FIFO within a kind. */
function orderComposerPendingMessages(
  messages: readonly ComposerPendingMessage[],
): ComposerPendingMessage[] {
  return [
    ...messages.filter((m) => m.kind === 'steer'),
    ...messages.filter((m) => m.kind === 'queue'),
    ...messages.filter((m) => m.kind === 'stash'),
  ];
}

/** When a run ends, undelivered steers become queues ahead of the existing ones. */
function convertSteersToFrontQueued(
  messages: readonly ComposerPendingMessage[],
  now: number = Date.now(),
): ComposerPendingMessage[] {
  const saved = messages.filter((m) => m.saved !== undefined);
  const steers = messages
    .filter((m) => m.kind === 'steer' && m.saved === undefined)
    .map((m) => ({
      ...m,
      kind: 'queue' as const,
      updatedAt: now,
    }));
  const queues = messages.filter((m) => m.kind === 'queue');
  const stashes = messages.filter((m) => m.kind === 'stash');
  return [...saved, ...steers, ...queues, ...stashes];
}

/**
 * The messages with this id marked as saved by the host. It shows with the steers: a reply reads
 * it, and the page does not send it.
 */
function saveComposerPendingMessage(
  messages: readonly ComposerPendingMessage[],
  id: string,
  landsAs: readonly string[],
  now: number = Date.now(),
): ComposerPendingMessage[] {
  return orderComposerPendingMessages(
    messages.map((m) =>
      m.id === id ? { ...m, kind: 'steer' as const, saved: { landsAs }, updatedAt: now } : m,
    ),
  );
}

/** Takes out the saved messages that a reply named by one of `ids`. */
function takeSavedComposerPending(
  messages: readonly ComposerPendingMessage[],
  ids: readonly string[],
): { landed: ComposerPendingMessage[]; remaining: ComposerPendingMessage[] } {
  const named = new Set(ids);
  const lands = (m: ComposerPendingMessage) =>
    m.saved?.landsAs.some((id) => named.has(id)) === true;
  return { landed: messages.filter(lands), remaining: messages.filter((m) => !lands(m)) };
}

/**
 * Drops the steers a turn event reports as landed in the conversation. A steer
 * it never names stays pending, so the run's end requeues it.
 */
function removeLandedSteers(
  messages: readonly ComposerPendingMessage[],
  event: TurnEvent,
): ComposerPendingMessage[] {
  if (event.type !== 'stage' || !event.injected?.length) return [...messages];
  const ids = event.injected.map((steer) => steer.id);
  const landed = new Set(ids);
  return takeSavedComposerPending(messages, ids).remaining.filter(
    (m) => !(m.kind === 'steer' && landed.has(m.id)),
  );
}

/** The messages without the one with this id. A message the host saved stays. */
function removeComposerPendingMessage(
  messages: readonly ComposerPendingMessage[],
  id: string,
): ComposerPendingMessage[] {
  return messages.filter((m) => m.id !== id || m.saved !== undefined);
}

/** The messages with this id's draft replaced; throws when the new draft is empty. */
function updateComposerPendingDraft(
  messages: readonly ComposerPendingMessage[],
  id: string,
  draft: UserTurnDraft,
  now: number = Date.now(),
): ComposerPendingMessage[] {
  if (!userDraftHasPayload(draft)) {
    throw new Error('Composer pending message requires a non-empty draft'); // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
  return messages.map((m) =>
    m.id === id && m.saved === undefined
      ? {
          ...m,
          draft: cloneUserTurnDraft(draft),
          updatedAt: now,
        }
      : m,
  );
}

/** The messages with this id moved one place up or down among those of its kind. */
function moveComposerPendingWithinKind(
  messages: readonly ComposerPendingMessage[],
  id: string,
  direction: 'up' | 'down',
): ComposerPendingMessage[] {
  const message = messages.find((m) => m.id === id);
  if (!message || message.saved !== undefined) return [...messages];

  const sameKind = messages.filter((m) => m.kind === message.kind);
  const currentIndex = sameKind.findIndex((m) => m.id === id);
  if (currentIndex < 0) return orderComposerPendingMessages(messages);

  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= sameKind.length || sameKind[nextIndex]?.saved !== undefined) {
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
 * Which ways the message with this id can move: a move stays among the messages of its kind, so a
 * message can go up only past one of its kind before it, and down only past one after it.
 */
function composerPendingMoves(
  messages: readonly ComposerPendingMessage[],
  id: string,
): { up: boolean; down: boolean } {
  const message = messages.find((m) => m.id === id);
  if (!message || message.saved !== undefined) return { up: false, down: false };
  const sameKind = messages.filter((m) => m.kind === message.kind);
  const index = sameKind.findIndex((m) => m.id === id);
  const movable = (at: number) => sameKind[at] !== undefined && sameKind[at].saved === undefined;
  return { up: movable(index - 1), down: movable(index + 1) };
}

/** One steer per safe boundary: call once per `onStage` inject site. */
function consumeNextComposerSteer(messages: readonly ComposerPendingMessage[]): {
  message: ComposerPendingMessage | null;
  remaining: ComposerPendingMessage[];
} {
  const message = messages.find((m) => m.kind === 'steer' && m.saved === undefined) ?? null;
  if (!message) return { message: null, remaining: [...messages] };
  return {
    message,
    remaining: messages.filter((m) => m.id !== message.id),
  };
}

/** Call only after the agent run has fully ended, not on a tool pause. */
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

/** The messages with this id changed to another kind. */
function promoteComposerPendingKind(
  messages: readonly ComposerPendingMessage[],
  id: string,
  kind: ComposerPendingKind,
  now: number = Date.now(),
): ComposerPendingMessage[] {
  const updated = messages.map((m) =>
    m.id === id && m.saved === undefined
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
  composerPendingMoves,
  composerPendingPreview,
  consumeNextComposerQueue,
  consumeNextComposerSteer,
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  moveComposerPendingWithinKind,
  orderComposerPendingMessages,
  promoteComposerPendingKind,
  removeComposerPendingMessage,
  removeLandedSteers,
  saveComposerPendingMessage,
  takeSavedComposerPending,
  updateComposerPendingDraft,
  userDraftHasPayload,
};
