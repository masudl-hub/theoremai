import { TheoremError } from '@theoremjs/agents';
import type {
  AttachmentValidationIssue,
  ComposerMenuAction,
  ComposerPendingMessage,
  ComposerProfileInterface,
  ComposerRunPhase,
  InterfaceTurnSession,
  TranscriptBlock,
  UserTurnDraft,
} from '@theoremjs/agents/interface';
import {
  convertSteersToFrontQueued,
  createComposerPendingMessage,
  orderComposerPendingMessages,
  removeComposerPendingMessage,
  userDraftHasPayload,
  userDraftToSteerInject,
} from '@theoremjs/agents/interface';
import { type MutableRefObject, useCallback } from 'react';
import { type ClientFailure, clientFailure } from '../client/failure.ts';
import {
  type AnsweringGate,
  composerFieldsFromDraft,
  encodeComposerDraft,
  resumeInterfaceTool,
  type StreamView,
  streamInterfaceDraftTurn,
  streamInterfaceTurn,
  type ToolDecisionAction,
  type ToolGateResolution,
} from '../client/index.ts';
import type { RunOutcome } from '../client/run-session.ts';
import type { TheoremTransport } from '../client/transport.ts';
import { issuedOperationId, type RunScope } from '../client/turn-client.ts';
import type { MessageDelivery } from './use-theorem-chat-state.ts';

function composerFieldsPayload(
  text: string,
  pendingFiles: readonly File[],
  pendingVoice: readonly File[],
) {
  const meta = (files: readonly File[]) =>
    files.map((f) => ({
      name: f.name,
      mimeType: f.type || 'application/octet-stream',
      sizeBytes: f.size,
    }));
  return {
    ...(text.trim() ? { text } : {}),
    ...(pendingFiles.length ? { attachments: meta(pendingFiles) } : {}),
    ...(pendingVoice.length ? { voice: meta(pendingVoice) } : {}),
  };
}

function newTurnId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `turn-${Date.now()}`;
}

export type RunTurnStream = (
  run: (view: StreamView) => Promise<RunOutcome>,
  options?: {
    /** The run sends a message: one that never posts goes back in the composer with its failure. */
    message?: { restore(): Promise<void> };
  },
) => Promise<void>;

function beginAbortableTurn(args: {
  iface: ComposerProfileInterface | null;
  abortRef: MutableRefObject<AbortController | null>;
  turnIdRef: MutableRefObject<string | null>;
}): {
  composer: ComposerProfileInterface;
  turnId: string;
  signal: AbortSignal;
} | null {
  if (!args.iface) return null;
  const controller = new AbortController();
  args.abortRef.current = controller;
  const turnId = newTurnId();
  args.turnIdRef.current = turnId;
  return {
    composer: args.iface,
    turnId,
    signal: controller.signal,
  };
}

export type TheoremChatActionArgs = {
  iface: ComposerProfileInterface | null;
  transport: TheoremTransport;
  phase: ComposerRunPhase;
  gated: boolean;
  draftText: string;
  pendingFiles: File[];
  pendingVoice: File[];
  /** The composer as it is now, for a run that ends after it changed. */
  composerRef: MutableRefObject<{ draftText: string; pendingFiles: File[]; pendingVoice: File[] }>;
  /** The ref of the conversation the chat continues; none before its first message posts. */
  conversationRef: MutableRefObject<string | undefined>;
  clearComposer: () => void;
  runTurnStream: RunTurnStream;
  sessionRef: MutableRefObject<InterfaceTurnSession>;
  blocksRef: MutableRefObject<TranscriptBlock[]>;
  abortRef: MutableRefObject<AbortController | null>;
  turnIdRef: MutableRefObject<string | null>;
  busyRef: MutableRefObject<boolean>;
  runPromiseRef: MutableRefObject<Promise<void> | null>;
  allowQueueDrainRef: MutableRefObject<boolean>;
  setBlocks: (value: TranscriptBlock[] | ((prev: TranscriptBlock[]) => TranscriptBlock[])) => void;
  setStreamBlocks: (value: TranscriptBlock[]) => void;
  setSession: (value: InterfaceTurnSession) => void;
  setChatStarted: (value: boolean) => void;
  setStreaming: (value: boolean) => void;
  setPendingMessages: (
    value:
      | ComposerPendingMessage[]
      | ((prev: ComposerPendingMessage[]) => ComposerPendingMessage[]),
  ) => void;
  setDraftText: (value: string) => void;
  setPendingFiles: (value: File[]) => void;
  setPendingVoice: (value: File[]) => void;
  setIssues: (value: AttachmentValidationIssue[]) => void;
  setFailure: (value: ClientFailure | null) => void;
  setAnswering: (value: AnsweringGate | null) => void;
  setDelivery: (value: { status: MessageDelivery } | null) => void;
  pendingRef: MutableRefObject<ComposerPendingMessage[]>;
};

/** The run's scope: the conversation the chat continues, and the run's own turn. */
function scopeOf(args: TheoremChatActionArgs, turnId?: string): RunScope {
  return { conversation: args.conversationRef.current, turnId };
}

type ComposerFields = { text: string; files: File[]; voice: File[] };

/**
 * Puts a message back in the composer. What the composer holds now is
 * stashed first, so nothing the user typed is lost.
 */
function useRestoreToComposer(args: TheoremChatActionArgs) {
  return useCallback(
    async (fields: ComposerFields) => {
      const { draftText, pendingFiles, pendingVoice } = args.composerRef.current;
      if (userDraftHasPayload(composerFieldsPayload(draftText, pendingFiles, pendingVoice))) {
        const draft = await encodeComposerDraft({ text: draftText, pendingFiles, pendingVoice });
        const stash = createComposerPendingMessage({ kind: 'stash', draft });
        args.setPendingMessages((prev) => orderComposerPendingMessages([...prev, stash]));
      }
      args.setDraftText(fields.text);
      args.setPendingFiles(fields.files);
      args.setPendingVoice(fields.voice);
      args.setIssues([]);
    },
    [args],
  );
}

/** Starts a turn from the composer's fields, or from an encoded draft (queued or send-now). */
function useTurnStarters(
  args: TheoremChatActionArgs,
  restoreToComposer: (fields: ComposerFields) => Promise<void>,
) {
  const startTurnFromFields = useCallback(
    async (fields: ComposerFields) => {
      const started = beginAbortableTurn(args);
      if (!started) return;

      await args.runTurnStream(
        (view) =>
          streamInterfaceTurn({
            iface: started.composer,
            transport: args.transport,
            session: args.sessionRef.current,
            text: fields.text,
            pendingFiles: fields.files,
            pendingVoice: fields.voice,
            signal: started.signal,
            scope: scopeOf(args, started.turnId),
            view,
            transcript: args.blocksRef.current,
            onUserBlocks: (userBlocks) => {
              args.setBlocks((prev) => [...prev, ...userBlocks]);
              args.setDelivery({ status: 'sending' });
              args.setChatStarted(true);
              args.setStreaming(true);
              args.clearComposer();
            },
          }),
        { message: { restore: () => restoreToComposer(fields) } },
      );
    },
    [args, restoreToComposer],
  );

  const startTurnFromDraft = useCallback(
    async (
      draft: ComposerPendingMessage['draft'],
      options: {
        /** Send while the reply waits on gates: the message walks away from them. */
        walkAway?: boolean;
        /** Once the message posts: it leaves wherever it was waiting to be sent. */
        onPosted?: () => void;
      } = {},
    ) => {
      const started = beginAbortableTurn(args);
      if (!started) return;

      await args.runTurnStream(
        (view) =>
          streamInterfaceDraftTurn({
            iface: started.composer,
            transport: args.transport,
            session: args.sessionRef.current,
            draft,
            signal: started.signal,
            scope: scopeOf(args, started.turnId),
            view,
            transcript: args.blocksRef.current,
            walkAway: options.walkAway === true,
            onUserBlocks: (posted) => {
              args.setBlocks((prev) => [...prev, ...posted]);
              args.setStreamBlocks([]);
              args.setDelivery({ status: 'sending' });
              args.setChatStarted(true);
              args.setStreaming(true);
              options.onPosted?.();
            },
          }),
        { message: { restore: () => restoreToComposer(composerFieldsFromDraft(draft)) } },
      );
    },
    [args, restoreToComposer],
  );

  return { startTurnFromFields, startTurnFromDraft };
}

/** A steer with no running turn: the user reads `session.turn_ended`; queued steers move to the front. */
function steerAfterTurnEnded(args: TheoremChatActionArgs, messageId: string): void {
  args.setFailure(
    clientFailure(
      // labels-exempt: internal diagnostic; the user reads session.turn_ended
      new TheoremError('request', 'steer: no active turn', { copy: { key: 'session.turn_ended' } }),
      args.iface?.labels,
    ),
  );
  args.setPendingMessages((prev) =>
    orderComposerPendingMessages(
      convertSteersToFrontQueued(removeComposerPendingMessage(prev, messageId)),
    ),
  );
}

/** Queue / steer / stash the composer draft, and restore a pending message into the composer. */
function usePendingActions(
  args: TheoremChatActionArgs,
  restoreToComposer: (fields: ComposerFields) => Promise<void>,
) {
  const enqueuePending = useCallback(
    async (kind: 'queue' | 'steer' | 'stash') => {
      if (
        !userDraftHasPayload(
          composerFieldsPayload(args.draftText, args.pendingFiles, args.pendingVoice),
        )
      ) {
        return;
      }
      args.setIssues([]);
      try {
        const draft = await encodeComposerDraft({
          text: args.draftText,
          pendingFiles: args.pendingFiles,
          pendingVoice: args.pendingVoice,
        });
        const message = createComposerPendingMessage({ kind, draft });
        args.setPendingMessages((prev) => orderComposerPendingMessages([...prev, message]));
        args.clearComposer();

        if (kind !== 'steer') return;
        const turnId = args.turnIdRef.current;
        if (!turnId) {
          steerAfterTurnEnded(args, message.id);
          return;
        }
        const inject = userDraftToSteerInject(draft);
        if (inject.length === 0) return;
        await args.transport.steer({ turnId, id: message.id, inject });
      } catch (err) {
        args.setFailure(clientFailure(err, args.iface?.labels));
      }
    },
    [args],
  );

  const handlePendingRestore = useCallback(
    async (id: string) => {
      const message = args.pendingRef.current.find((m) => m.id === id);
      if (!message) return;
      try {
        await restoreToComposer(composerFieldsFromDraft(message.draft));
        args.setPendingMessages((prev) => removeComposerPendingMessage(prev, id));
      } catch (err) {
        args.setFailure(clientFailure(err, args.iface?.labels));
      }
    },
    [args, restoreToComposer],
  );

  return { enqueuePending, handlePendingRestore };
}

/** Answer the gate the session waits on: a decision, or a sign-in. */
function useGateActions(args: TheoremChatActionArgs) {
  const resumeGatedTool = useCallback(
    async (resolution: ToolGateResolution) => {
      const composer = args.iface;
      if (!composer) return;
      // why: Set once the run starts (not while another runs), and cleared once it has ended.
      let started = false;
      try {
        await args.runTurnStream((view) => {
          started = true;
          const session = args.sessionRef.current;
          // why: A person's answer shows on its gate while it settles; the page's has no gate to show on.
          if (session.gatedTool && resolution.action !== 'page')
            args.setAnswering({
              callId: session.gatedTool.callId,
              operationId: issuedOperationId(session.gatedTool),
              action: resolution.action,
            });
          return resumeInterfaceTool({
            iface: composer,
            transport: args.transport,
            session,
            scope: scopeOf(args),
            resolution,
            view,
          });
        });
      } finally {
        if (started) args.setAnswering(null);
      }
    },
    [args],
  );

  const handleToolDecision = useCallback(
    async (_index: number, action: ToolDecisionAction) => {
      await resumeGatedTool({ action });
    },
    [resumeGatedTool],
  );

  const handleAuthenticated = useCallback(
    async (_index: number, secret?: string) => {
      await resumeGatedTool({ action: 'auth', ...(secret === undefined ? {} : { secret }) });
    },
    [resumeGatedTool],
  );

  return { handleToolDecision, handleAuthenticated, resumeGatedTool };
}

export function useTheoremChatActions(args: TheoremChatActionArgs) {
  const restoreToComposer = useRestoreToComposer(args);
  const { startTurnFromFields, startTurnFromDraft } = useTurnStarters(args, restoreToComposer);
  const { enqueuePending, handlePendingRestore } = usePendingActions(args, restoreToComposer);
  const { handleToolDecision, handleAuthenticated, resumeGatedTool } = useGateActions(args);

  const handleStop = useCallback(() => {
    args.abortRef.current?.abort();
  }, [args]);

  const handleSubmit = useCallback(async () => {
    if (args.phase === 'streaming' || args.phase === 'gated') {
      await enqueuePending('queue');
      return;
    }
    if (args.gated) return;
    args.setIssues([]);
    await startTurnFromFields({
      text: args.draftText,
      files: [...args.pendingFiles],
      voice: [...args.pendingVoice],
    });
  }, [args, enqueuePending, startTurnFromFields]);

  /** The queued message's draft, or the composer's when it holds something to send. */
  const draftToSend = useCallback(
    async (draftSource?: ComposerPendingMessage): Promise<UserTurnDraft | undefined> => {
      if (draftSource) return draftSource.draft;
      const draft = await encodeComposerDraft({
        text: args.draftText,
        pendingFiles: args.pendingFiles,
        pendingVoice: args.pendingVoice,
      });
      return userDraftHasPayload(draft) ? draft : undefined;
    },
    [args],
  );

  /** The sent message leaves the queue, or the composer it came from. */
  const releaseDraft = useCallback(
    (draftSource?: ComposerPendingMessage) => {
      if (!draftSource) {
        args.clearComposer();
        return;
      }
      const pendingId = draftSource.id;
      args.setPendingMessages((prev) => removeComposerPendingMessage(prev, pendingId));
    },
    [args],
  );

  const handleSendNow = useCallback(
    async (draftSource?: ComposerPendingMessage) => {
      if (!args.iface) return;

      const draft = await draftToSend(draftSource);
      if (!draft) return;

      if (args.busyRef.current) {
        args.abortRef.current?.abort();
        await args.runPromiseRef.current;
      }

      args.setPendingMessages((prev) => convertSteersToFrontQueued(prev));
      args.allowQueueDrainRef.current = false;
      // why: Sent while the reply waits on gates, the message walks away from them in its own request.
      await startTurnFromDraft(draft, {
        walkAway: args.sessionRef.current.gatedTool !== null,
        onPosted: () => releaseDraft(draftSource),
      });
    },
    [args, draftToSend, releaseDraft, startTurnFromDraft],
  );

  const handleMenuAction = useCallback(
    (action: ComposerMenuAction) => {
      if (action === 'queue' || action === 'steer' || action === 'stash') {
        void enqueuePending(action);
        return;
      }
      if (action === 'send_now') void handleSendNow();
    },
    [enqueuePending, handleSendNow],
  );

  return {
    startTurnFromFields,
    startTurnFromDraft,
    handleStop,
    handleSubmit,
    handleSendNow,
    handleMenuAction,
    handleToolDecision,
    handleAuthenticated,
    resumeGatedTool,
    handlePendingRestore,
    enqueuePending,
  };
}
