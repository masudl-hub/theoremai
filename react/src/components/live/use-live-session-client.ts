import type { SessionEventOf, TurnEvent } from '@theoremjs/agents';
import type {
  LiveCallOptions,
  LiveConnectPhase,
  LiveGateAnswer,
  LiveGateReply,
  LiveSessionStatus,
  LiveToolGatePrompt,
  TraceFeed,
} from '@theoremjs/web/client';
import {
  continueGatedToolInvocation,
  type LiveConnection,
  LiveSessionClient,
} from '@theoremjs/web/client';
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from 'react';
import { applyLiveTranscript, type LiveCaptionState } from '../../client/live/live-captions.ts';
import type { LiveFacingMode, LiveVideoCapture } from '../../client/live/live-video.ts';

export type LiveClientBindings = LiveCallOptions & {
  voiceAvailable: boolean;
  /** Where the session's trace records go, when the relay delivers them. */
  traces: TraceFeed;
  handleLiveTurnEvent: (event: TurnEvent) => void;
  waitForGateDecision: (prompt: LiveToolGatePrompt) => Promise<LiveGateAnswer>;
  gatePromptRef: MutableRefObject<LiveToolGatePrompt | null>;
  isMutedRef: MutableRefObject<boolean>;
  sessionPermissionsRef: MutableRefObject<string[]>;
  videoCaptureRef: MutableRefObject<LiveVideoCapture | null>;
  setConnectPhase: Dispatch<SetStateAction<LiveConnectPhase | null>>;
  setStatus: Dispatch<SetStateAction<LiveSessionStatus>>;
  setSessionActive: Dispatch<SetStateAction<boolean>>;
  reportFailure: (err: unknown) => void;
  clearFailure: () => void;
  reportSessionEnded: (session: SessionEventOf<'ended'>) => void;
  clearSessionEnded: () => void;
  setCaptions: Dispatch<SetStateAction<LiveCaptionState>>;
  setInputLevel: Dispatch<SetStateAction<number>>;
  setOutputLevel: Dispatch<SetStateAction<number>>;
  setActiveTool: Dispatch<SetStateAction<string | null>>;
  setSessionPermissions: Dispatch<SetStateAction<string[]>>;
  setVideoPreview: Dispatch<SetStateAction<HTMLVideoElement | null>>;
  setVideoFacingMode: Dispatch<SetStateAction<LiveFacingMode>>;
  setIsVideoOn: Dispatch<SetStateAction<boolean>>;
};

function onLiveStatusChange(next: LiveSessionStatus, bindings: LiveClientBindings): void {
  bindings.setStatus(next);
  if (next === 'listening' || next === 'ready') {
    bindings.setSessionActive(true);
    bindings.clearFailure();
    bindings.clearSessionEnded();
    return;
  }
  if (next !== 'disconnected' && next !== 'error') return;
  bindings.setSessionActive(false);
  if (bindings.videoCaptureRef.current) {
    bindings.videoCaptureRef.current.stop();
    bindings.videoCaptureRef.current = null;
  }
  bindings.setVideoPreview(null);
  bindings.setVideoFacingMode('user');
  bindings.setIsVideoOn(false);
}

function onLiveTranscript(
  text: string,
  isUser: boolean,
  meta: { interim?: boolean } | undefined,
  bindings: LiveClientBindings,
): void {
  // why: A thought or a tool call in the same batch is already queued; each folds onto the last.
  bindings.setCaptions((prev) => applyLiveTranscript(prev, text, isUser, meta?.interim));
}

/** The user's answer to a gate, as the session takes it; an approval records the permissions it grants. */
async function onLiveGate(
  prompt: LiveToolGatePrompt,
  bindings: LiveClientBindings,
): Promise<LiveGateReply> {
  const resolution = await bindings.waitForGateDecision(prompt);
  if (resolution === 'withdrawn') return 'withdrawn';
  const reply = continueGatedToolInvocation({
    toolName: prompt.toolName,
    gate: prompt.gate,
    sessionPermissions: bindings.sessionPermissionsRef.current,
    resolution,
  });
  if (reply.decision === 'approve') {
    bindings.sessionPermissionsRef.current = reply.sessionPermissions;
    bindings.setSessionPermissions(reply.sessionPermissions);
  }
  return reply;
}

/** Owns LiveSessionClient construction + reconnect identity. */
export function useLiveSessionClient(bindings: LiveClientBindings) {
  const clientRef = useRef<LiveSessionClient | null>(null);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const ensureClient = useCallback((connection: LiveConnection) => {
    if (clientRef.current) return clientRef.current;
    const b = bindingsRef.current;
    const client = new LiveSessionClient({
      ...connection,
      slots: b.slots,
      context: b.context,
      voiceIngress: b.voiceAvailable,
      onConnectPhase: (phase) => {
        b.setConnectPhase(phase);
      },
      onStatusChange: (next) => {
        onLiveStatusChange(next, bindingsRef.current);
      },
      onTranscript: (text, isUser, meta) => {
        onLiveTranscript(text, isUser, meta, bindingsRef.current);
      },
      onTurnEvent: (event) => {
        // why: An `unsupported` event is the host's to read; Theorem's UI shows nothing for it.
        if (event.type === 'unsupported') return;
        // why: A `malformed` one was left out and the call goes on; the user reads that part was skipped.
        if (event.type === 'malformed') {
          bindingsRef.current.reportFailure(event.error);
          return;
        }
        // why: A new call from the model clears the last failure.
        if (event.type === 'tool' && event.tool.phase === undefined)
          bindingsRef.current.clearFailure();
        bindingsRef.current.handleLiveTurnEvent(event);
      },
      onTrace: (record) => {
        bindingsRef.current.traces.push(record);
      },
      onVolumeLevel: (level, isUser) => {
        const current = bindingsRef.current;
        if (isUser) {
          current.setInputLevel(current.isMutedRef.current ? 0 : level);
        } else {
          current.setOutputLevel(level);
        }
      },
      onError: (err) => {
        bindingsRef.current.reportFailure(err);
      },
      onSessionEnded: (session) => {
        bindingsRef.current.reportSessionEnded(session);
      },
      // why: Read at each call, so a handler the host renders anew is the one that answers.
      get pageTools() {
        return bindingsRef.current.pageTools;
      },
      onGate: (prompt) => onLiveGate(prompt, bindingsRef.current),
    });
    clientRef.current = client;
    return client;
  }, []);

  const clearClient = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
  }, []);

  return { clientRef, ensureClient, clearClient };
}
