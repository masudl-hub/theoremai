import type { TranscriptBlock } from '@theoremjs/agents/interface';
import {
  type ChatController,
  type ChatOptionPicks,
  type ChatOptions,
  type ChatState,
  createChatController,
  type SendTextOptions,
  type SentTurn,
  type ToolDecisionAction,
} from '@theoremjs/web/client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type BackgroundJob,
  backgroundJobs,
  groupTranscriptBlocks,
} from '../client/transcript-groups.ts';
import { liveTurnStart, type TurnClock, useTurnClock } from './use-turn-clock.ts';

export type { SendTextOptions, SentTurn };

export type UseTheoremChatOptions = ChatOptions;

// why: Options reach the chat before the browser paints, and before a line can arrive; a server render runs no effects.
const useOptionsEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Headless chat model: transcript, streaming, composer drafts, pending
 * queue / steer / stash, tool gates. Render it with `@theoremjs/react/ui` or
 * your own components. A React binding of `createChatController` from
 * `@theoremjs/web/client`, which works with no framework.
 */
export function useTheoremChat(options: UseTheoremChatOptions): TheoremChatState {
  const [chat] = useState(() => createChatController(options));
  useOptionsEffect(() => chat.update(options));
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  const optionChoices = useMemo(
    () => (state.options ? { ...state.options, onChange: chat.pickOption } : undefined),
    [chat, state.options],
  );
  const shownBlocks = useMemo(
    () => [...state.blocks, ...state.streamBlocks],
    [state.blocks, state.streamBlocks],
  );
  const jobs = useMemo(() => backgroundJobs(shownBlocks), [shownBlocks]);
  const groups = useMemo(() => groupTranscriptBlocks(shownBlocks), [shownBlocks]);
  const turnClock = useTurnClock(groups, state.streaming);
  // why: The transcript draws each gate by its index; the chat answers the one gate that waits.
  const handleAuthenticated = useCallback(
    (_index: number, secret?: string) => chat.authenticate(secret),
    [chat],
  );
  const handleToolDecision = useCallback(
    (_index: number, action: ToolDecisionAction) => chat.decide(action),
    [chat],
  );
  return {
    ...state,
    optionChoices,
    shownBlocks,
    turnClock,
    workingSince: liveTurnStart(groups, turnClock, state.streaming),
    backgroundJobs: jobs,
    setDraftText: chat.setDraftText,
    setPendingFiles: chat.setPendingFiles,
    setPendingVoice: chat.setPendingVoice,
    setPendingMessages: chat.setPendingMessages,
    setIssues: chat.setIssues,
    handleAuthenticated,
    handleBranch: chat.branch,
    handleSubmit: chat.submit,
    handleStop: chat.stop,
    handleMenuAction: chat.menuAction,
    handlePendingQueue: chat.queuePending,
    handlePendingMove: chat.movePending,
    handlePendingRestore: chat.restorePending,
    handleSendNow: chat.sendNow,
    handleToolDecision,
    handleGenerationChange: chat.setGeneration,
    sendText: chat.sendText,
    controller: chat,
  };
}

/** What `useTheoremChat` returns: the chat's state and its actions. */
export type TheoremChatState = ChatState & {
  /** The profile's options with their values, and the setter; `undefined` when it declares none. */
  optionChoices: (ChatOptionPicks & { onChange: ChatController['pickOption'] }) | undefined;
  /** What the transcript shows: the committed blocks, then the reply streaming in. */
  shownBlocks: TranscriptBlock[];
  /**
   * When each turn started and how long it waited on approvals. Pass it to `ChatTranscript`'s
   * `clock` so its times agree with the composer's working pill.
   */
  turnClock: TurnClock;
  /** When the reply in progress started, its approval waits skipped; `undefined` when none runs. */
  workingSince: number | undefined;
  /** The tool calls still running in the background, oldest first, until their results land. */
  backgroundJobs: BackgroundJob[];
  setDraftText: ChatController['setDraftText'];
  setPendingFiles: ChatController['setPendingFiles'];
  setPendingVoice: ChatController['setPendingVoice'];
  setPendingMessages: ChatController['setPendingMessages'];
  setIssues: ChatController['setIssues'];
  /** Answers the sign-in gate; the index is the gate's place in the transcript. */
  handleAuthenticated: (index: number, secret?: string) => Promise<void>;
  handleBranch: ChatController['branch'];
  handleSubmit: ChatController['submit'];
  handleStop: ChatController['stop'];
  handleMenuAction: ChatController['menuAction'];
  handlePendingQueue: ChatController['queuePending'];
  handlePendingMove: ChatController['movePending'];
  handlePendingRestore: ChatController['restorePending'];
  handleSendNow: ChatController['sendNow'];
  /** Answers the approval gate; the index is the gate's place in the transcript. */
  handleToolDecision: (index: number, action: ToolDecisionAction) => Promise<void>;
  handleGenerationChange: ChatController['setGeneration'];
  sendText: ChatController['sendText'];
  /** The controller under it all, for a host that drives the chat from outside. */
  controller: ChatController;
};
