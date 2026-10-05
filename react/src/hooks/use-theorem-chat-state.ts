import {
  type AttachmentValidationIssue,
  type ComposerPendingMessage,
  emptyInterfaceTurnSession,
  type InterfaceTurnSession,
  type TranscriptBlock,
} from '@theoremjs/agents/interface';
import { useCallback, useRef, useState } from 'react';
import type { ClientFailure } from '../client/failure.ts';
import type { AnsweringGate } from '../client/tool-resume.ts';

type SetSession = (
  value: InterfaceTurnSession | ((prev: InterfaceTurnSession) => InterfaceTurnSession),
) => void;

export type { SetSession };

/**
 * How far the latest message has got: posted (`sending`), taken by the server
 * (`sent`), reached the model (`delivered`), answered (`read`).
 */
export type MessageDelivery = 'sending' | 'sent' | 'delivered' | 'read';

/** A conversation at rest: what the transcript shows and what the next turn is sent with. */
export type ChatSnapshot = { blocks: TranscriptBlock[]; session: InterfaceTurnSession };

/** Coalesces streamed partial blocks to one state update per animation frame. */
function useStreamFrames(setStreamBlocks: (blocks: TranscriptBlock[]) => void) {
  const streamRafRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<TranscriptBlock[] | null>(null);

  const cancelPendingStreamFrame = useCallback(() => {
    if (streamRafRef.current != null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    pendingStreamRef.current = null;
  }, []);

  const scheduleStreamBlocks = useCallback(
    (partial: TranscriptBlock[]) => {
      pendingStreamRef.current = partial;
      if (streamRafRef.current != null) return;
      streamRafRef.current = requestAnimationFrame(() => {
        streamRafRef.current = null;
        const next = pendingStreamRef.current;
        pendingStreamRef.current = null;
        if (next) setStreamBlocks(next);
      });
    },
    [setStreamBlocks],
  );

  return { cancelPendingStreamFrame, scheduleStreamBlocks };
}

/** Composer / transcript / session state behind {@link useTheoremChat}. */
export function useTheoremChatState(initial?: ChatSnapshot) {
  const [blocks, setBlocksState] = useState<TranscriptBlock[]>(initial?.blocks ?? []);
  const [streamBlocks, setStreamBlocks] = useState<TranscriptBlock[]>([]);
  const [draftText, setDraftText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingVoice, setPendingVoice] = useState<File[]>([]);
  const [pendingMessages, setPendingMessages] = useState<ComposerPendingMessage[]>([]);
  const [issues, setIssues] = useState<AttachmentValidationIssue[]>([]);
  const [failure, setFailure] = useState<ClientFailure | null>(null);
  const [answering, setAnswering] = useState<AnsweringGate | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatStarted, setChatStarted] = useState((initial?.blocks.length ?? 0) > 0);
  const [streaming, setStreaming] = useState(false);
  const [session, setSession] = useState<InterfaceTurnSession>(
    initial?.session ?? emptyInterfaceTurnSession(),
  );
  // why: One object per posted message, so a run can tell whether it posted one.
  const [delivery, setDeliveryState] = useState<{ status: MessageDelivery } | null>(null);

  const blocksRef = useRef(blocks);
  // why: Set as it is written, so a caller awaiting a turn reads the transcript the turn left.
  const setBlocks = useCallback(
    (value: TranscriptBlock[] | ((prev: TranscriptBlock[]) => TranscriptBlock[])) => {
      blocksRef.current = typeof value === 'function' ? value(blocksRef.current) : value;
      setBlocksState(blocksRef.current);
    },
    [],
  );
  const streamBlocksRef = useRef(streamBlocks);
  streamBlocksRef.current = streamBlocks;
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const pendingRef = useRef(pendingMessages);
  pendingRef.current = pendingMessages;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const drainLockRef = useRef(false);
  const allowQueueDrainRef = useRef(false);
  const runPromiseRef = useRef<Promise<void> | null>(null);
  const deliveryRef = useRef(delivery);

  const setDelivery = useCallback((next: { status: MessageDelivery } | null) => {
    deliveryRef.current = next;
    setDeliveryState(next);
  }, []);

  const { cancelPendingStreamFrame, scheduleStreamBlocks } = useStreamFrames(setStreamBlocks);

  const clearComposer = useCallback(() => {
    setDraftText('');
    setPendingFiles([]);
    setPendingVoice([]);
  }, []);

  return {
    blocks,
    setBlocks,
    streamBlocks,
    setStreamBlocks,
    streamBlocksRef,
    draftText,
    setDraftText,
    pendingFiles,
    setPendingFiles,
    pendingVoice,
    setPendingVoice,
    pendingMessages,
    setPendingMessages,
    issues,
    setIssues,
    failure,
    setFailure,
    answering,
    setAnswering,
    busy,
    setBusy,
    chatStarted,
    setChatStarted,
    streaming,
    setStreaming,
    session,
    setSession,
    delivery,
    setDelivery,
    deliveryRef,
    blocksRef,
    busyRef,
    abortRef,
    turnIdRef,
    pendingRef,
    sessionRef,
    drainLockRef,
    allowQueueDrainRef,
    runPromiseRef,
    cancelPendingStreamFrame,
    scheduleStreamBlocks,
    clearComposer,
  };
}
