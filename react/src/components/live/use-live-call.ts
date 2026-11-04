import { liveIngressEnabledFromSpec } from '@theoremjs/agents';
import type { LiveProfileInterface } from '@theoremjs/agents/interface';
import type { LiveCallOptions, LiveConnection } from '@theoremjs/web/client';
import { createTraceFeed, liveState } from '@theoremjs/web/client';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LiveCaptionState,
  type LiveCaptionTurn,
  stashLiveCaptionCall,
} from '../../client/live/live-captions.ts';
import { usePageToolWarnings } from '../../hooks/use-page-tool-warnings.ts';
import { useLiveRunnerControls } from './use-live-runner-controls.ts';
import { useLiveRunnerGate, useLiveRunnerUiState } from './use-live-runner-ui.ts';
import { useLiveSessionClient } from './use-live-session-client.ts';

type LiveControls = ReturnType<typeof useLiveRunnerControls>;

/**
 * Calls start from the landing (voice, or video + voice), not on mount. Once
 * started, the call view stays until a reload; ending leaves Start call. Each
 * restart is a new conversation; earlier calls' captions stay, above a divider.
 */
function useLiveCallLifecycle(
  controls: LiveControls,
  captionsRef: MutableRefObject<LiveCaptionState>,
  sessionActive: boolean,
  videoAvailable: boolean,
) {
  const [callStarted, setCallStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  /** When this call first connected; a reconnect keeps it, a new call clears it. */
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const videoOnConnectRef = useRef(false);

  const startCall = useCallback(
    (options: { video: boolean }) => {
      videoOnConnectRef.current = options.video && videoAvailable;
      setCallStarted(true);
      setEnded(false);
      void controls.startSession();
    },
    [controls, videoAvailable],
  );

  useEffect(() => {
    if (sessionActive) setConnectedAt((at) => at ?? Date.now());
  }, [sessionActive]);

  // why: Camera capture needs a live session, so a video call turns it on once connected.
  useEffect(() => {
    if (!sessionActive || !videoOnConnectRef.current) return;
    videoOnConnectRef.current = false;
    void controls.handleToggleVideo();
  }, [controls, sessionActive]);

  const handleEnd = useCallback(() => {
    videoOnConnectRef.current = false;
    controls.teardownSession();
    setEnded(true);
    setConnectedAt(null);
  }, [controls]);

  const [pastCalls, setPastCalls] = useState<LiveCaptionTurn[][]>([]);

  const handleRestart = useCallback(async () => {
    const previous = captionsRef.current.turns;
    setPastCalls((calls) => stashLiveCaptionCall(calls, previous));
    setEnded(false);
    setConnectedAt(null);
    await controls.handleRestart();
  }, [controls, captionsRef]);

  const teardownSessionRef = useRef(controls.teardownSession);
  teardownSessionRef.current = controls.teardownSession;

  useEffect(() => {
    return () => {
      teardownSessionRef.current();
    };
  }, []);

  return { callStarted, connectedAt, ended, pastCalls, startCall, handleEnd, handleRestart };
}

/** What `useLiveCall` takes: the profile, what the call opens, and the host's part in the call. */
export type LiveCallInput = {
  iface: LiveProfileInterface;
  /**
   * What the call opens: a host with a fixed profile returns its id; the studio
   * returns its draft as the relay's open message.
   */
  connection: () => LiveConnection | Promise<LiveConnection>;
} & LiveCallOptions;

/** One live call: its state, captions, and controls. `LiveRunner` draws it. */
export type LiveCall = ReturnType<typeof useLiveCall>;

/**
 * Owns a live call: its session client, state, and controls. The call lasts as
 * long as the component that calls this hook, so a host that calls it above its
 * routes keeps the call while the person moves between pages.
 */
export function useLiveCall({ iface, connection, ...options }: LiveCallInput) {
  const ui = useLiveRunnerUiState(iface.labels);
  const gate = useLiveRunnerGate({
    setCaptions: ui.setCaptions,
    setActiveTool: ui.setActiveTool,
    reportFailure: ui.reportFailure,
  });
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const voiceAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'audio');
  const videoAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'video');
  const textAvailable = liveIngressEnabledFromSpec(iface.live.ingress, 'text');

  const state = useMemo(
    () =>
      liveState({
        status: ui.status,
        connectPhase: ui.connectPhase,
        toolName: ui.activeTool?.name ?? null,
        isMuted: ui.isMuted,
        voiceEnabled: voiceAvailable,
      }),
    [ui.activeTool, ui.connectPhase, ui.isMuted, ui.status, voiceAvailable],
  );

  // why: One feed per call: every session it opens adds its records.
  const traces = useMemo(createTraceFeed, []);
  const { clientRef, ensureClient, clearClient } = useLiveSessionClient({
    options: options.options,
    stated: options.stated,
    model: options.model,
    effort: options.effort,
    context: options.context,
    pageTools: options.pageTools,
    voiceAvailable,
    traces,
    handleLiveTurnEvent: gate.handleLiveTurnEvent,
    waitForGateDecision: gate.waitForGateDecision,
    gatePromptRef: gate.gatePromptRef,
    isMutedRef: ui.isMutedRef,
    sessionPermissionsRef: ui.sessionPermissionsRef,
    videoCaptureRef: ui.videoCaptureRef,
    setConnectPhase: ui.setConnectPhase,
    setStatus: ui.setStatus,
    setSessionActive: ui.setSessionActive,
    reportFailure: ui.reportFailure,
    clearFailure: ui.clearFailure,
    reportSessionEnded: ui.reportSessionEnded,
    clearSessionEnded: ui.clearSessionEnded,
    setCaptions: ui.setCaptions,
    setInputLevel: ui.setInputLevel,
    setOutputLevel: ui.setOutputLevel,
    setSessionPermissions: ui.setSessionPermissions,
    setVideoPreview: ui.setVideoPreview,
    setVideoFacingMode: ui.setVideoFacingMode,
    setIsVideoOn: ui.setIsVideoOn,
  });

  const controls = useLiveRunnerControls({
    clientRef,
    videoCaptureRef: ui.videoCaptureRef,
    connectionRef,
    statusRef: ui.statusRef,
    isMutedRef: ui.isMutedRef,
    sessionPermissionsRef: ui.sessionPermissionsRef,
    ensureClient,
    clearClient,
    cancelGateDecision: gate.cancelGateDecision,
    stopVideo: ui.stopVideo,
    resetCaptions: ui.resetCaptions,
    sessionActive: ui.sessionActive,
    textAvailable,
    videoAvailable,
    voiceAvailable,
    isVideoOn: ui.isVideoOn,
    textDraft: ui.textDraft,
    setTextDraft: ui.setTextDraft,
    setCaptions: ui.setCaptions,
    reportFailure: ui.reportFailure,
    clearFailure: ui.clearFailure,
    setIsMuted: ui.setIsMuted,
    setSessionActive: ui.setSessionActive,
    setSessionPermissions: ui.setSessionPermissions,
    setStatus: ui.setStatus,
    setConnectPhase: ui.setConnectPhase,
    setInputLevel: ui.setInputLevel,
    setOutputLevel: ui.setOutputLevel,
    setVideoPreview: ui.setVideoPreview,
    setVideoFacingMode: ui.setVideoFacingMode,
    setIsVideoOn: ui.setIsVideoOn,
  });

  const { callStarted, connectedAt, ended, pastCalls, startCall, handleEnd, handleRestart } =
    useLiveCallLifecycle(controls, ui.captionsRef, ui.sessionActive, videoAvailable);

  // why: The page's context is compared by value, so a host may build it inline on each render.
  const contextJson = JSON.stringify(options.context);
  useEffect(() => {
    clientRef.current?.setContext(contextJson === undefined ? undefined : JSON.parse(contextJson));
  }, [clientRef, contextJson]);

  // why: Options are compared by value too; a changed value takes an open call up again with it.
  const optionsJson = JSON.stringify(options.options);
  useEffect(() => {
    clientRef.current?.setOptions(optionsJson === undefined ? undefined : JSON.parse(optionsJson));
  }, [clientRef, optionsJson]);

  // why: As options: a changed pick takes an open call up again with the lines it chooses.
  const statedJson = JSON.stringify(options.stated);
  useEffect(() => {
    clientRef.current?.setStated(statedJson === undefined ? undefined : JSON.parse(statedJson));
  }, [clientRef, statedJson]);

  usePageToolWarnings(iface.tools.page, options.pageTools);

  return {
    iface,
    handle: iface.identity.handle,
    traces,
    callStarted,
    connectedAt,
    pastCalls,
    captions: ui.captions,
    failure: ui.failure,
    sessionEnded: ui.sessionEnded,
    levelsRef: ui.levelsRef,
    isMuted: ui.isMuted,
    isVideoOn: ui.isVideoOn,
    sessionActive: ui.sessionActive,
    liveState: state,
    activeTool: ui.activeTool,
    status: ui.status,
    textAvailable,
    textDraft: ui.textDraft,
    toolActive: ui.activeTool !== null || gate.gatePrompt !== null,
    videoAvailable,
    videoFacingMode: ui.videoFacingMode,
    videoPreview: ui.videoPreview,
    voiceAvailable,
    // why: Also after ending (or failing) before the first connect, so the call can't get stuck.
    canRestart:
      !ui.sessionActive &&
      ui.status !== 'connecting' &&
      (ui.everConnected || ended || ui.failure !== null),
    gatePrompt: gate.gatePrompt,
    setTextDraft: ui.setTextDraft,
    handleEnd,
    startCall,
    handleRestart,
    handleSendText: controls.handleSendText,
    handleToggleMic: controls.handleToggleMic,
    handleFlipCamera: controls.handleFlipCamera,
    handleToggleVideo: controls.handleToggleVideo,
    resolveGateDecision: gate.resolveGateDecision,
  };
}
