import {
  type ChatOptions,
  createChatController,
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

export type { SentTurn };

export type UseTheoremChatOptions = ChatOptions;

// why: Options reach the chat before the browser paints, and before a line can arrive; a server render runs no effects.
const useOptionsEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Headless chat model: transcript, streaming, composer drafts, pending
 * queue / steer / stash, tool gates. Render it with `@theoremjs/react/ui` or
 * your own components. A React binding of `createChatController` from
 * `@theoremjs/web/client`, which works with no framework.
 */
export function useTheoremChat(options: UseTheoremChatOptions) {
  const [chat] = useState(() => createChatController(options));
  useOptionsEffect(() => chat.update(options));
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  const slotChoices = useMemo(
    () => (state.slots ? { ...state.slots, onChange: chat.pickSlot } : undefined),
    [chat, state.slots],
  );
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
    slotChoices,
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
  };
}
