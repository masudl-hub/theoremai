/**
 * Where a chat's conversation lives for `createTheoremHandler`: the transcript
 * the person reads and the history the model reads next. The host owns it; the
 * browser holds only an opaque ref the store issued, and never sends history.
 *
 * A database store keys the conversation by its id. The sealed store keeps
 * nothing: its ref is the conversation itself, encrypted and signed with the
 * host's key, so the browser carries what it cannot read or change.
 *
 * @module
 */

import {
  labelText,
  type ProviderCheckpoint,
  providerCheckpointSchema,
  TheoremError,
  type TurnEvent,
  type TurnHistoryMessage,
  turnEventSchema,
  turnHistoryMessageSchema,
  z,
} from '@theoremjs/agents';
import { applyToolEvent, type TranscriptBlock } from '@theoremjs/agents/interface';
import { type Equals, openSecret, sealSecret } from '@theoremjs/agents/kernel';
import { transcriptBlockSchema } from '../client/transcript-schema.ts';
import { type RunningReply, type StatedTurn, statedTurnSchema } from '../client/transport.ts';
import { type MemorySessionStoreOptions, memoryStoreLimits } from './session-store.ts';

/** A reply's base and the count of its events that base holds, as they stood before a compaction. */
export type UncompactedBase = { base: TurnHistoryMessage[]; baseEvents: number };

/** A reply paused on gates: its events so far, and the history it was given. */
export type PausedReply = {
  events: TurnEvent[];
  /** The history the reply was given; its events append to this when it commits. */
  base: TurnHistoryMessage[];
  /** How many of `events` `base` already holds: a compaction mid-reply moves the base. */
  baseEvents: number;
  /** The base before a compaction folded in late results this reply read; a failure goes back to it. */
  uncompacted?: UncompactedBase;
  /** How long the reply worked before it paused (ms), approval waits excluded. */
  workedMs: number;
  /** When the reply last paused (epoch ms). */
  endedAt: number;
  /** The model, effort, and stated turn the reply ran with, for the run that goes on after its gates. */
  model?: string;
  effort?: string;
  stated?: StatedTurn;
  /** The reply's id under its chat's hold, so the reply that goes on after its gates resumes what it read. */
  reply?: string;
};

/** One conversation as the host stores it. */
export type StoredConversation = {
  version: 2;
  /**
   * The conversation's own id, kept through its rewinds. Each turn carries it as
   * `conversationId`, which its trace records as `gen_ai.conversation.id`.
   */
  id: string;
  /** What the person reads, without the paused reply. */
  transcript: TranscriptBlock[];
  /** What the model reads on the next turn, compacted when the profile compacts. */
  history: TurnHistoryMessage[];
  providerState?: ProviderCheckpoint;
  /** The last turn's input tokens, for the compaction meter. */
  inputTokens?: number;
  /** The history's size in tokens as the last compaction measured it. */
  historyTokens?: number;
  paused?: PausedReply;
};

const pausedReply = z.object({
  events: z.array(turnEventSchema),
  base: z.array(turnHistoryMessageSchema),
  baseEvents: z.number().int().nonnegative(),
  uncompacted: z
    .object({
      base: z.array(turnHistoryMessageSchema),
      baseEvents: z.number().int().nonnegative(),
    })
    .optional(),
  workedMs: z.number().nonnegative(),
  endedAt: z.number(),
  model: z.string().optional(),
  effort: z.string().optional(),
  stated: statedTurnSchema.optional(),
  reply: z.string().min(1).optional(),
});
true satisfies Equals<z.infer<typeof pausedReply>, PausedReply>;

const storedConversation = z.object({
  version: z.literal(2),
  id: z.string().min(1),
  transcript: z.array(transcriptBlockSchema),
  history: z.array(turnHistoryMessageSchema),
  providerState: providerCheckpointSchema.optional(),
  inputTokens: z.number().optional(),
  historyTokens: z.number().optional(),
  paused: pausedReply.optional(),
});
true satisfies Equals<z.infer<typeof storedConversation>, StoredConversation>;
/** A stored conversation as a host's own store reads it back. */
export const storedConversationSchema: z.ZodType<StoredConversation> = storedConversation;

/** An empty conversation: what a chat with no ref starts from. */
export function emptyConversation(): StoredConversation {
  return { version: 2, id: crypto.randomUUID(), transcript: [], history: [] };
}

export interface ConversationSnapshot {
  revision: string;
  conversation: StoredConversation;
  /**
   * A reply that runs on the conversation now, as the app's own records say: one under a hold the
   * app keeps (`inbox`), whichever server, channel or wake runs it. Set only while that hold is
   * live. A page reads it to show the reply working, and stops and steers it by the conversation.
   * The app tells the page when the reply ends (`notifier.publish` after its save). Unset, no
   * reply runs, or the store does not know.
   */
  running?: RunningReply;
}

/**
 * How the reply a write saves ended. `committed`: it is over. `failed`: it ended with an error.
 * `stopped`: the person stopped it. `paused`: it waits on gates. `lost`: its hold no longer has
 * the conversation, so it tells nothing.
 */
export type ReplyEnd = 'committed' | 'failed' | 'stopped' | 'paused' | 'lost' | 'refused';

/**
 * What a write that saves a reply says beside the conversation. A store that keeps the app's own
 * records honours it in the same statement as the write. A write with no context saves no reply:
 * a new conversation, a posted message, a compaction, or a rewind.
 */
export type WriteContext = {
  /** The hold the reply runs under. A store that keeps the holds refuses one that lost the conversation. */
  hold?: string;
  /** The reply's id under its hold. */
  reply?: string;
  /** What the app's `beforeSave` returned as `host`. Theorem never reads it. */
  host?: unknown;
  ended: ReplyEnd;
  /** The ids of the inbox items this reply told, to mark in the same write. Empty when `ended` is `lost`. */
  told: readonly string[];
  /** The blocks this write adds to the transcript the store holds, so a store need not compare. */
  appended: readonly TranscriptBlock[];
};

/** A call a reply left running in the background, as it ended: the event its block takes. */
export type DetachedEnding = {
  operationId: string;
  tool: Extract<Extract<TurnEvent, { type: 'tool' }>['tool'], { phase: 'complete' | 'error' }>;
};

/**
 * `block` with `ending` on it, when it is the block of that call as it detached; any other block
 * as it is. A store's `end` writes each block through it.
 */
export function endedBlock(block: TranscriptBlock, ending: DetachedEnding): TranscriptBlock {
  if (block.kind !== 'tool' || block.tool.operationId !== ending.operationId) return block;
  const { tool } = block;
  if (tool.state?.phase !== 'background') return block;
  // why: A block saved before `detached` was kept takes it from its background phase, so the call
  // stays one that detached once it has ended.
  const detached = tool.detached ? tool : applyToolEvent(tool, tool.state);
  return { ...block, tool: applyToolEvent(detached, ending.tool) };
}

export type ConversationWriteResult =
  | { written: true; ref: string; revision: string }
  | { written: false };

/**
 * Where conversations live. `ref` is the store's own: the handler hands it to
 * the browser and back, and never reads it. Every read and write names the
 * session, so a ref from another session opens nothing.
 */
export interface TheoremConversationStore {
  /** The conversation, or undefined when this session has none under `ref`. */
  read(sessionId: string, ref: string): Promise<ConversationSnapshot | undefined>;
  /**
   * Compare and replace. A null `ref` creates a conversation; otherwise the
   * write lands only on a conversation this session can read, while its
   * stored revision is still `expectedRevision`.
   */
  write(
    sessionId: string,
    ref: string | null,
    expectedRevision: string | null,
    next: StoredConversation,
    context?: WriteContext,
  ): Promise<ConversationWriteResult>;
  /**
   * A call a reply left running in the background ended. The store puts the end on the call's
   * block in whichever of the session's conversations holds it (`endedBlock`), and keeps it there
   * when a later write still holds the block as it detached. It changes no revision, so a reply
   * that runs meanwhile still saves. With no such block (it was rewound away) it changes nothing.
   * A store that keeps nothing (`createSealedConversationStore`) does nothing: the page reads the
   * end from the session's record while the session keeps it (`operationRetentionMs`).
   */
  end(sessionId: string, ending: DetachedEnding): Promise<void>;
}

/** Refuses a ref the store does not know or cannot open: the browser reads `session.conversation_unknown`. */
export function unknownConversation(cause?: unknown): TheoremError {
  return new TheoremError('not_found', labelText('session.conversation_unknown'), {
    copy: { key: 'session.conversation_unknown' },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Conversations in process memory, until the limits it is given. For one instance. */
export function createMemoryConversationStore(
  options: Omit<MemorySessionStoreOptions, 'sessionLimits'> = {},
): TheoremConversationStore {
  const { ttlMs, maxSessions } = memoryStoreLimits(options);
  const conversations = new Map<
    string,
    { sessionId: string; snapshot: ConversationSnapshot; touched: number }
  >();
  const current = (sessionId: string, ref: string) => {
    const entry = conversations.get(ref);
    if (!entry || entry.sessionId !== sessionId) return undefined;
    if (Date.now() - entry.touched >= ttlMs) {
      conversations.delete(ref);
      return undefined;
    }
    return entry.snapshot;
  };
  const written = (
    ...[sessionId, ref, expectedRevision, next, context]: Parameters<
      TheoremConversationStore['write']
    >
  ): ConversationWriteResult => {
    // invariant: This store keeps no holds, so a reply whose hold lost the conversation writes nothing here.
    if (context?.ended === 'lost') return { written: false };
    const snapshot = ref === null ? undefined : current(sessionId, ref);
    // invariant: A ref this session cannot read takes no write, so no session overwrites another's conversation.
    if (ref !== null && snapshot === undefined) return { written: false };
    if ((snapshot?.revision ?? null) !== expectedRevision) return { written: false };
    const conversation = keptEnds(storedConversation.parse(next), snapshot?.conversation);
    const key = ref ?? crypto.randomUUID();
    const revision = crypto.randomUUID();
    conversations.delete(key);
    conversations.set(key, {
      sessionId,
      snapshot: { revision, conversation: structuredClone(conversation) },
      touched: Date.now(),
    });
    while (conversations.size > maxSessions) {
      const oldest = conversations.keys().next().value;
      if (oldest === undefined) break;
      conversations.delete(oldest);
    }
    return { written: true, ref: key, revision };
  };
  return {
    read: (sessionId, ref) => Promise.resolve(structuredClone(current(sessionId, ref))),
    // why: A write that fails its check rejects, as any store's does, rather than throwing at the call.
    write: (...args) => new Promise((resolve) => resolve(written(...args))),
    end: (sessionId, ending) =>
      new Promise((resolve) => {
        for (const entry of conversations.values()) {
          if (entry.sessionId !== sessionId) continue;
          const { conversation } = entry.snapshot;
          const transcript = conversation.transcript.map((block) => endedBlock(block, ending));
          entry.snapshot = { ...entry.snapshot, conversation: { ...conversation, transcript } };
        }
        resolve();
      }),
  };
}

/** `next`, with each detached call's end that `stored` holds kept on the block `next` still holds as it detached. */
function keptEnds(
  next: StoredConversation,
  stored: StoredConversation | undefined,
): StoredConversation {
  const ends = new Map<string, TranscriptBlock>();
  for (const block of stored?.transcript ?? []) {
    if (block.kind === 'tool' && block.tool.operationId && block.tool.detached) {
      if (block.tool.state?.phase !== 'background') ends.set(block.tool.operationId, block);
    }
  }
  if (ends.size === 0) return next;
  const transcript = next.transcript.map((block) => {
    if (block.kind !== 'tool' || block.tool.state?.phase !== 'background') return block;
    const ended = block.tool.operationId ? ends.get(block.tool.operationId) : undefined;
    return ended ?? block;
  });
  return { ...next, transcript };
}

export type SealedConversationStoreOptions = {
  /** Every sealing key still in use, by version: each at least 32 bytes, kept off the browser. */
  keys: Readonly<Record<number, string>>;
  /** The key that seals new writes. */
  keyVersion: number;
};

/**
 * A store for a host that keeps nothing. The ref is the conversation sealed
 * with the host's key and bound to the session: the browser carries it and
 * cannot read or change it, and it opens in no other session.
 *
 * It cannot tell an older seal from the newest, so an older seal opens: like a
 * rewind, it returns a conversation the host wrote. Its revision is the seal.
 */
export function createSealedConversationStore(
  options: SealedConversationStoreOptions,
): TheoremConversationStore {
  const sealKey = options.keys[options.keyVersion];
  if (sealKey === undefined) {
    throw new TheoremError('config', labelText('error.config'), {
      cause: { code: 'conversation_seal_key_missing', keyVersion: options.keyVersion },
    });
  }
  return {
    async read(sessionId, ref) {
      const plaintext = await openSecret({ sealed: ref, keys: options.keys, binding: [sessionId] })
        // why: A seal that does not open is a ref this session does not own; the caller refuses it.
        .catch(() => undefined);
      if (plaintext === undefined) return undefined;
      const conversation = storedConversation.parse(JSON.parse(plaintext));
      return { revision: ref, conversation };
    },
    // why: The browser carries the conversation, so the server holds nothing to put an end on.
    end: () => Promise.resolve(),
    async write(sessionId, ref, expectedRevision, next, context) {
      // invariant: This store keeps no holds, so a reply whose hold lost the conversation writes nothing here.
      if (context?.ended === 'lost') return { written: false };
      if (ref !== expectedRevision) return { written: false };
      const conversation = storedConversation.parse(next);
      const sealed = await sealSecret({
        plaintext: JSON.stringify(conversation),
        key: sealKey,
        binding: [sessionId],
        keyVersion: options.keyVersion,
      });
      return { written: true, ref: sealed, revision: sealed };
    },
  };
}
