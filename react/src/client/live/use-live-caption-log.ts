import type { TurnEvent } from '@theoremjs/agents';
import { useCallback, useRef, useState } from 'react';
import {
  applyLiveTranscript,
  applyLiveTurnEvent,
  emptyLiveCaptionState,
  type LiveCaptionState,
  type LiveCaptionTurn,
  stashLiveCaptionCall,
} from './live-captions.ts';

/**
 * The captions a live call shows: this call's lines, and earlier calls kept
 * when it is started again. Speech arrives through `applyTranscript`, and the
 * call's turn events (thoughts, tool calls, the reply's end) through
 * `applyTurnEvent`. A typed send is `noteSentText`, which always starts its own line.
 */
export function useLiveCaptionLog() {
  const [captions, setCaptions] = useState<LiveCaptionState>(emptyLiveCaptionState);
  const [pastCalls, setPastCalls] = useState<LiveCaptionTurn[][]>([]);
  const captionsRef = useRef(captions);
  captionsRef.current = captions;

  const applyTranscript = useCallback((text: string, isUser: boolean, interim?: boolean) => {
    const next = applyLiveTranscript(captionsRef.current, text, isUser, interim);
    captionsRef.current = next;
    setCaptions(next);
  }, []);

  const applyTurnEvent = useCallback((event: TurnEvent) => {
    const next = applyLiveTurnEvent(captionsRef.current, event);
    captionsRef.current = next;
    setCaptions(next);
  }, []);

  const noteSentText = useCallback((text: string) => {
    const next = applyLiveTranscript(captionsRef.current, text, true, false, { forceNew: true });
    captionsRef.current = next;
    setCaptions(next);
  }, []);

  const beginNextCall = useCallback(() => {
    const previous = captionsRef.current.turns;
    setPastCalls((calls) => stashLiveCaptionCall(calls, previous));
    const next = emptyLiveCaptionState();
    captionsRef.current = next;
    setCaptions(next);
  }, []);

  const clear = useCallback(() => {
    setPastCalls([]);
    const next = emptyLiveCaptionState();
    captionsRef.current = next;
    setCaptions(next);
  }, []);

  return {
    captions,
    pastCalls,
    applyTranscript,
    applyTurnEvent,
    noteSentText,
    beginNextCall,
    clear,
  };
}
