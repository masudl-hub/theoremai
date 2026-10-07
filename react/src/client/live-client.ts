/**
 * Pure client-side SDK for THEOREM Gemini 3.1 Flash Live sessions over WebSocket relay.
 *
 * Handles:
 * - Bidirectional WebSocket connection to `/api/live/relay`.
 * - 16-bit 16kHz PCM microphone audio recording & streaming.
 * - Gapless 24kHz PCM / WAV model voice playback scheduling.
 * - Barge-in interruption cancellation (instant audio queue flush).
 * - Quiet-mic gate while model audio plays (reduces false barge-in from speaker bleed).
 * - UI tool execution and response routing.
 *
 * @module
 */

import {
  describeError,
  type SessionEvent,
  type SessionEventOf,
  TheoremError,
  type TraceRecord,
  type TurnEventOf,
} from '@theoremjs/agents';
import { base64ToBytes, bytesToBase64 } from '@theoremjs/agents/kernel';
import { float32Rms, float32RmsToLevel, timeDomainBytesToLevel } from './audio-level.ts';
import {
  applyLiveToolTurnEvent,
  liveTranscriptFromEvidence,
  shouldForwardMicFrame,
} from './live/live-mic-forward.ts';
import type { LiveConnectPhase, LiveSessionStatus } from './live/live-state.ts';
import { isPermissionDeniedError } from './live-errors.ts';
import {
  type ExecuteToolOnRelay,
  type LiveClientMessage,
  type LiveOpenMessage,
  type LiveServerEnvelope,
  type LiveToolStep,
  parseLiveServerEnvelope,
} from './live-messages.ts';
import { MIC_CAPTURE_PROCESSOR, micCaptureWorkletUrl } from './mic-capture.ts';
import { downsampleAndConvertToInt16, pcm16BytesToFloat32 } from './pcm-downsample.ts';
import { type ClientTurnEvent, hostError } from './transport.ts';

type LiveToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ExecuteToolReply = Extract<LiveServerEnvelope, { type: 'executeToolResult' }>;

/** One message to the relay, in the shape a relay checks with `parseLiveClientMessage`. */
function clientMessage(message: LiveClientMessage): string {
  return JSON.stringify(message);
}

type MediaChunk = { data: string; mimeType?: string };

type InboundTurnAccum = {
  toolCalls: LiveToolCall[];
  mediaChunks: MediaChunk[];
  cancelledToolIds: Set<string>;
};

function emptyInboundTurnAccum(): InboundTurnAccum {
  return {
    toolCalls: [],
    mediaChunks: [],
    cancelledToolIds: new Set(),
  };
}

/**
 * While the model is playing audio, mic frames below this RMS are not forwarded.
 * Speaker bleed / keyboard / room noise sit under this; intentional barge-in speech
 * sits above it. Gemini VAD only offers LOW|HIGH start sensitivity — this is the
 * fine-grained "less choppy barge-in" knob.
 */
const BARGE_IN_RMS_WHILE_SPEAKING = 0.05;

/** How long the client waits before each try at taking a dropped call up again. After the last, the call fails. */
export const LIVE_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

export type { LiveConnection, LiveSocket } from './live-messages.ts';

import type { LiveSocket } from './live-messages.ts';

export interface LiveClientOptions {
  profile?: string;
  /** The host's own JSON for its relay, sent as the open message's `host`. */
  openMessage?: Record<string, unknown>;
  /** The value chosen for each of the profile's `inputs.slots`, fixed for the call. */
  slots?: Record<string, string>;
  /** What the page tells the agent as the call opens; `setContext` replaces it during the call. */
  context?: unknown;
  relayUrl?: string;
  /** In-process connections reuse the same microphone, playback and tool client. */
  createSocket?: () => LiveSocket;
  /** When false, skip microphone capture; session still receives model audio. */
  voiceIngress?: boolean;
  onStatusChange?: (status: LiveSessionStatus) => void;
  onConnectPhase?: (phase: LiveConnectPhase | null) => void;
  onTranscript?: (text: string, isUser: boolean, meta?: { interim?: boolean }) => void;
  /**
   * Every event the session sends, `unsupported` for a kind this client does
   * not know, and `malformed` for one that failed its check (left out; the call goes on).
   */
  onTurnEvent?: (event: ClientTurnEvent) => void;
  /** A trace record the session wrote, when the relay delivers them. */
  onTrace?: (record: TraceRecord) => void;
  /** A failure, typed by kind; word it with `clientFailure` and the interface's `lexicon`. */
  onError?: (error: Error) => void;
  /** Provider signalled the upstream session is draining (e.g. goAway). */
  onSessionClosing?: (timeLeftMs?: number) => void;
  /**
   * The provider ended the session after warning it would: not a failure.
   * `session.message` is the user's line; `session.ended` the close, for the builder.
   */
  onSessionEnded?: (session: SessionEventOf<'ended'>) => void;
  /**
   * The model called a tool. The host runs it with `executeToolOnRelay` and
   * answers its gates; the session answers the model. A throw reaches `onError`.
   */
  onToolCall: (
    name: string,
    args: Record<string, unknown>,
    meta: { callId: string },
  ) => Promise<void>;
  /** The relay opened the call: the id it gave the call, and the profile it runs. */
  onSessionReady?: (info: { sessionId?: string; profile?: string }) => void;
  onVolumeLevel?: (level: number, isUser: boolean) => void;
}

/** A caught value as an `Error`; one that is not keeps its text as `internal` detail. */
function asError(err: unknown): Error {
  return err instanceof Error
    ? err
    : new TheoremError('internal', describeError(err), { cause: err });
}

function safeDisconnect(node?: { disconnect?: () => void } | null): void {
  if (!node || typeof node.disconnect !== 'function') return;
  try {
    node.disconnect();
  } catch {
    // why: disconnect() throws for a node that is not connected; it is disconnected either way.
  }
}

function stopMediaTracks(stream?: { getTracks?: () => Array<{ stop: () => void }> } | null): void {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function checkMicFrameForward(args: {
  isMuted: boolean;
  wsOpen: boolean;
  hasPlaybackNodes: boolean;
  status: LiveSessionStatus;
  inputFloat32: Float32Array;
}): boolean {
  const rms = float32Rms(args.inputFloat32);
  const modelPlaying = args.hasPlaybackNodes || args.status === 'speaking';
  return shouldForwardMicFrame({
    isMuted: args.isMuted,
    socketOpen: args.wsOpen,
    modelPlaying,
    rms,
    bargeInRmsWhileSpeaking: BARGE_IN_RMS_WHILE_SPEAKING,
  });
}

function resolveWorkingStatusTransition(
  currentStatus: LiveSessionStatus,
  serverWorking: boolean,
): LiveSessionStatus | null {
  if (currentStatus === 'listening' && serverWorking) return 'working';
  if (currentStatus === 'working' && !serverWorking) return 'listening';
  return null;
}

export class LiveSessionClient {
  private ws: LiveSocket | null = null;
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micWorklet: AudioWorkletNode | null = null;
  private micWorkletModuleLoaded = false;
  private playbackNodes: AudioBufferSourceNode[] = [];
  private playbackBus: GainNode | null = null;
  private playbackAnalyser: AnalyserNode | null = null;
  private playbackMeterFrame = 0;
  private playbackMeterBuffer: Uint8Array<ArrayBuffer> | null = null;
  private nextPlaybackTime = 0;
  private status: LiveSessionStatus = 'disconnected';
  /** Server reported background work (reasoning / async tools) still in flight. */
  private serverWorking = false;
  private micActivating = false;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isMuted = false;
  private options: LiveClientOptions;
  /** Serialize control-plane handling (tools / status) without waiting on audio decode. */
  private inboundChain: Promise<void> = Promise.resolve();
  /** Ordered model-audio playback queue (separate so tools are not stuck behind decode). */
  private audioChain: Promise<void> = Promise.resolve();
  /**
   * Tool calls, one at a time in the order the model made them. Apart from
   * `inboundChain`: a call waits on the relay's reply, which arrives inbound.
   */
  private toolChain: Promise<void> = Promise.resolve();
  /** Bumped on barge-in / cancel so stale audioChain work is skipped. */
  private audioEpoch = 0;
  private pendingExecuteResults = new Map<
    string,
    { resolve: (value: LiveToolStep) => void; reject: (reason: Error) => void }
  >();
  /** The page's context package, and the JSON of the one the relay last got. */
  private context: unknown;
  private sentContext: string | undefined;
  /** The provider's latest handle for taking this call up again after a drop. */
  private resumeHandle: string | undefined;
  /** The session said it ended, or failed: a close after that is the end, not a drop. */
  private sessionOver = false;
  /** When the call dropped, for the time away a resume reports. */
  private droppedAt: number | undefined;
  private reconnectTries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveClientOptions) {
    this.options = options;
    this.context = options.context;
  }

  private setStatus(newStatus: LiveSessionStatus): void {
    this.status = newStatus;
    if (newStatus === 'listening' || newStatus === 'disconnected' || newStatus === 'error') {
      this.clearConnectTimeout();
    }
    this.options.onStatusChange?.(newStatus);
  }

  /** Still opening: the first connect, or a try at taking a dropped call up again. */
  private get opening(): boolean {
    return this.status === 'connecting' || this.status === 'reconnecting';
  }

  private setConnectPhase(phase: LiveConnectPhase | null): void {
    this.options.onConnectPhase?.(phase);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private detachWebSocket(): void {
    for (const [callId, pending] of this.pendingExecuteResults) {
      // lexicon-exempt: internal diagnostic; the user reads error.network
      pending.reject(
        new TheoremError('network', `live session closed before call ${callId} settled`),
      );
    }
    this.pendingExecuteResults.clear();
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    try {
      this.ws.close();
    } catch {
      // why: closing a socket that already closed throws; the connection is over either way.
    }
    this.ws = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectTries = 0;
    this.droppedAt = undefined;
  }

  private teardownConnection(): void {
    this.clearConnectTimeout();
    this.micActivating = false;
    this.setConnectPhase(null);
    this.detachWebSocket();
    this.cleanupAudio();
  }

  /** End the session on `error`: a failed connect or a lost socket. */
  private failSession(error: Error): void {
    if (this.status === 'error' || this.status === 'disconnected') return;
    this.clearReconnect();
    this.teardownConnection();
    this.options.onError?.(error);
    this.setStatus('error');
  }

  private createSocket(url: string): LiveSocket {
    return this.options.createSocket?.() ?? new WebSocket(url);
  }

  /** Start a new call. A call that drops takes itself up again; this is not for that. */
  public connect(): Promise<void> {
    this.clearReconnect();
    this.resumeHandle = undefined;
    return this.open('connecting');
  }

  /** The first message: the call's values, and the handle and time away when it takes a dropped call up again. */
  private openMessage(): LiveOpenMessage {
    const { slots, openMessage: host } = this.options;
    return {
      type: 'open',
      ...(slots ? { slots } : {}),
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.resumeHandle
        ? {
            resume: {
              handle: this.resumeHandle,
              awayMs: this.droppedAt === undefined ? 0 : Date.now() - this.droppedAt,
            },
          }
        : {}),
      ...(host ? { host } : {}),
    };
  }

  /** The socket closed while the call was open: take it up again if the provider gave a handle, else end. */
  private handleDrop(): void {
    if (!this.resumeHandle || this.sessionOver) {
      this.teardownConnection();
      this.setStatus('disconnected');
      return;
    }
    this.droppedAt ??= Date.now();
    this.teardownConnection();
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = LIVE_RECONNECT_DELAYS_MS[this.reconnectTries];
    if (delay === undefined) {
      // lexicon-exempt: internal diagnostic; the user reads error.network
      this.failSession(new TheoremError('network', 'live call dropped and could not reconnect'));
      return;
    }
    this.reconnectTries += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open('reconnecting');
    }, delay);
  }

  /** A try at opening failed: a reconnect waits and tries again, a first connect fails the call. */
  private failOpen(error: Error): void {
    if (this.status !== 'reconnecting') {
      this.failSession(error);
      return;
    }
    this.teardownConnection();
    this.scheduleReconnect();
  }

  private async open(as: 'connecting' | 'reconnecting'): Promise<void> {
    this.teardownConnection();
    this.sessionOver = false;
    this.setStatus(as);
    if (as === 'connecting') this.setConnectPhase('socket');

    try {
      const AudioContextClass = globalThis.AudioContext;
      this.audioContext = new AudioContextClass();
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const profileParam = this.options.profile
        ? `?profile=${encodeURIComponent(this.options.profile)}`
        : '';
      const defaultUrl = `${protocol}//${globalThis.location.host}/api/live/relay${profileParam}`;
      const url = this.options.relayUrl || defaultUrl;

      this.ws = this.createSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        const open = this.openMessage();
        this.sentContext = JSON.stringify(open.context);
        this.ws?.send(JSON.stringify(open));
      };

      this.connectTimeout = setTimeout(() => {
        if (this.opening) {
          // lexicon-exempt: internal diagnostic; the user reads error.timeout
          this.failOpen(new TheoremError('timeout', 'live connect timed out'));
        }
      }, 20_000);

      this.ws.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
        this.enqueueServerMessage(event.data);
      };

      this.ws.onclose = () => {
        if (this.opening) {
          // lexicon-exempt: internal diagnostic; the user reads error.network
          this.failOpen(new TheoremError('network', 'live socket closed before ready'));
          return;
        }
        this.handleDrop();
      };

      this.ws.onerror = () => {
        if (!this.opening && this.resumeHandle && !this.sessionOver) {
          this.handleDrop();
          return;
        }
        // lexicon-exempt: internal diagnostic; the user reads error.network
        this.failOpen(new TheoremError('network', 'live socket error'));
      };
    } catch (err) {
      this.failOpen(new TheoremError('internal', describeError(err), { cause: err }));
    }
  }

  private async ensureAudioContext(): Promise<void> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextClass = globalThis.AudioContext;
      this.audioContext = new AudioContextClass();
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
    }
  }

  private async activateMicrophone(): Promise<void> {
    if (this.micActivating || !this.opening) return;
    this.micActivating = true;
    if (this.status === 'connecting') this.setConnectPhase('microphone');

    try {
      await this.ensureAudioContext();
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      await this.setupMicrophonePipeline();
      this.becomeReady();
    } catch (err) {
      const denied = isPermissionDeniedError(err);
      this.failSession(
        new TheoremError(denied ? 'auth' : 'internal', describeError(err), {
          cause: err,
          copy: { key: denied ? 'voice.permission' : 'voice.unavailable' },
        }),
      );
    } finally {
      this.micActivating = false;
    }
  }

  private sendMicFrame(inputFloat32: Float32Array, sampleRate: number): void {
    const pcm16 = downsampleAndConvertToInt16(inputFloat32, sampleRate, 16000);
    const base64 = bytesToBase64(new Uint8Array(pcm16.buffer));
    const socket = this.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(clientMessage({ type: 'audio', data: base64 }));
    }
  }

  private reportMicVolume(inputFloat32: Float32Array): void {
    if (this.isMuted) return;
    this.options.onVolumeLevel?.(float32RmsToLevel(inputFloat32), true);
  }

  private forwardMicBuffer(inputFloat32: Float32Array): void {
    this.reportMicVolume(inputFloat32);
    const forward = checkMicFrameForward({
      isMuted: this.isMuted,
      wsOpen: this.ws?.readyState === WebSocket.OPEN,
      hasPlaybackNodes: this.playbackNodes.length > 0,
      status: this.status,
      inputFloat32,
    });
    if (forward) {
      const sampleRate = this.audioContext ? this.audioContext.sampleRate : 48000;
      this.sendMicFrame(inputFloat32, sampleRate);
    }
  }

  private async setupMicrophonePipeline(): Promise<void> {
    if (!this.micStream || !this.audioContext) return;

    this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
    const silent = this.audioContext.createGain();
    silent.gain.value = 0;

    if (!this.micWorkletModuleLoaded) {
      await this.audioContext.audioWorklet.addModule(micCaptureWorkletUrl());
      this.micWorkletModuleLoaded = true;
    }

    this.micWorklet = new AudioWorkletNode(this.audioContext, MIC_CAPTURE_PROCESSOR);
    this.micWorklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const inputFloat32 = new Float32Array(event.data);
      this.forwardMicBuffer(inputFloat32);
    };

    this.micSource.connect(this.micWorklet);
    this.micWorklet.connect(silent);
    silent.connect(this.audioContext.destination);
  }

  private ensurePlaybackBus(): void {
    if (!this.audioContext || this.playbackBus) return;

    this.playbackBus = this.audioContext.createGain();
    this.playbackAnalyser = this.audioContext.createAnalyser();
    this.playbackAnalyser.fftSize = 512;
    this.playbackAnalyser.smoothingTimeConstant = 0.35;
    this.playbackBus.connect(this.playbackAnalyser);
    this.playbackAnalyser.connect(this.audioContext.destination);
    this.playbackMeterBuffer = new Uint8Array(this.playbackAnalyser.fftSize);
  }

  private stopPlaybackMeter(): void {
    if (this.playbackMeterFrame) {
      cancelAnimationFrame(this.playbackMeterFrame);
      this.playbackMeterFrame = 0;
    }
    this.options.onVolumeLevel?.(0, false);
  }

  private startPlaybackMeter(): void {
    if (this.playbackMeterFrame) return;

    const tick = () => {
      if (this.playbackNodes.length === 0 || !this.playbackAnalyser || !this.playbackMeterBuffer) {
        this.stopPlaybackMeter();
        return;
      }

      this.playbackAnalyser.getByteTimeDomainData(this.playbackMeterBuffer);
      this.options.onVolumeLevel?.(timeDomainBytesToLevel(this.playbackMeterBuffer), false);
      this.playbackMeterFrame = requestAnimationFrame(tick);
    };

    this.playbackMeterFrame = requestAnimationFrame(tick);
  }

  private async processServerEnvelope(payload: LiveServerEnvelope): Promise<void> {
    if (await this.tryHandleControlEnvelope(payload)) return;
    if (payload.type !== 'events') return;

    const accum = this.collectInboundTurn(payload.events);
    const runnableTools = accum.toolCalls.filter((call) => !accum.cancelledToolIds.has(call.id));
    for (const call of runnableTools) {
      this.toolChain = this.toolChain
        .then(() => this.options.onToolCall(call.name, call.arguments, { callId: call.id }))
        .catch((err: unknown) => {
          this.options.onError?.(asError(err));
        });
    }
    this.scheduleMediaChunks(accum.mediaChunks);
  }

  private enqueueServerMessage(data: string | ArrayBuffer | Blob): void {
    this.inboundChain = this.inboundChain
      .then(async () => {
        if (typeof data !== 'string') return;

        const payload = parseLiveServerEnvelope(data);
        // why: An envelope the client can't use reaches onTurnEvent like any event; the call goes on.
        if (payload.type === 'unsupported' || payload.type === 'malformed') {
          this.options.onTurnEvent?.(payload);
        } else await this.processServerEnvelope(payload);
      })
      .catch((err: unknown) => {
        this.options.onError?.(asError(err));
      });
  }

  private async handleReadyEnvelope(
    payload: Extract<LiveServerEnvelope, { type: 'ready' }>,
  ): Promise<void> {
    this.options.onSessionReady?.({
      sessionId: payload.sessionId,
      profile: payload.profile,
    });
    if (this.options.voiceIngress === false) {
      this.becomeReady();
    } else {
      await this.activateMicrophone();
    }
  }

  /** The call is open, first or again: the page's context catches up with what changed meanwhile. */
  private becomeReady(): void {
    this.clearReconnect();
    this.setConnectPhase(null);
    this.setStatus('listening');
    this.flushContext();
  }

  private handleExecuteToolResultEnvelope(payload: ExecuteToolReply): void {
    const pending = this.pendingExecuteResults.get(payload.callId);
    if (!pending) return;
    this.pendingExecuteResults.delete(payload.callId);
    if (payload.status === 'refused') {
      pending.reject(hostError(payload.body, 'request'));
    } else if (payload.status === 'gated') {
      pending.resolve({ status: 'gated', gate: payload.gate });
    } else pending.resolve({ status: 'settled' });
  }

  private async tryHandleControlEnvelope(payload: LiveServerEnvelope): Promise<boolean> {
    if (payload.type === 'ready') {
      await this.handleReadyEnvelope(payload);
      return true;
    }
    if (payload.type === 'executeToolResult') {
      this.handleExecuteToolResultEnvelope(payload);
      return true;
    }
    if (payload.type === 'trace') {
      this.options.onTrace?.(payload.record);
      return true;
    }
    if (payload.type === 'error') {
      this.sessionOver = true;
      this.options.onError?.(hostError(payload, 'unavailable'));
      this.setStatus('error');
      return true;
    }
    return false;
  }

  private collectInboundTurn(events: readonly ClientTurnEvent[]): InboundTurnAccum {
    const accum = emptyInboundTurnAccum();
    for (const event of events) {
      this.processTurnEvent(event, accum);
    }
    return accum;
  }

  private processTurnEvent(event: ClientTurnEvent, accum: InboundTurnAccum): void {
    this.options.onTurnEvent?.(event);
    switch (event.type) {
      case 'evidence':
        this.handleEvidenceTurnEvent(event);
        break;
      case 'session':
        this.handleSessionTurnEvent(event);
        break;
      case 'media':
        this.collectMediaTurnEvent(event, accum);
        break;
      case 'tool':
        applyLiveToolTurnEvent(event.tool, accum);
        break;
      case 'done':
        this.handleDoneTurnEvent(event);
        break;
    }
  }

  private handleEvidenceTurnEvent(event: TurnEventOf<'evidence'>): void {
    if (event.sessionResumptionHandle) this.resumeHandle = event.sessionResumptionHandle;
    const transcript = liveTranscriptFromEvidence(event);
    if (transcript) {
      this.options.onTranscript?.(transcript.text, transcript.isUser, {
        interim: transcript.interim,
      });
    }
  }

  private handleSessionTurnEvent(event: TurnEventOf<'session'>): void {
    if (this.notifySessionLifecycle(event.session)) return;
    this.serverWorking = event.session.kind === 'working';
    const nextStatus = resolveWorkingStatusTransition(this.status, this.serverWorking);
    if (nextStatus) this.setStatus(nextStatus);
  }

  /** Hand the session's closing and end to the host; `true` when it was one of them. */
  private notifySessionLifecycle(session: SessionEvent): boolean {
    if (session.kind === 'closing_soon') {
      this.options.onSessionClosing?.(session.timeLeftMs);
      return true;
    }
    if (session.kind !== 'ended') return false;
    this.sessionOver = true;
    this.options.onSessionEnded?.(session);
    return true;
  }

  /** Status to settle into once model speech stops. */
  private restingStatus(): LiveSessionStatus {
    return this.serverWorking ? 'working' : 'listening';
  }

  private collectMediaTurnEvent(event: TurnEventOf<'media'>, accum: InboundTurnAccum): void {
    if (!event.media.data) return;
    this.setStatus('speaking');
    accum.mediaChunks.push({
      data: event.media.data,
      mimeType: event.media.mimeType,
    });
  }

  private handleDoneTurnEvent(event: TurnEventOf<'done'>): void {
    if (event.interrupted) {
      this.cancelPlayback();
    }
    if (event.stop.kind !== 'generation_complete') {
      this.serverWorking = false;
      this.setStatus('listening');
    }
  }

  private scheduleMediaChunks(mediaChunks: MediaChunk[]): void {
    if (mediaChunks.length === 0) return;
    const epoch = this.audioEpoch;
    for (const chunk of mediaChunks) {
      this.audioChain = this.audioChain
        .then(async () => {
          if (epoch !== this.audioEpoch) return;
          await this.enqueueAudioChunk(chunk.data, chunk.mimeType);
        })
        .catch((err: unknown) => {
          this.options.onError?.(asError(err));
        });
    }
  }

  /** The relay runs `LiveSession.executeTool`; see `ExecuteToolOnRelay`. */
  executeToolOnRelay(args: Parameters<ExecuteToolOnRelay>[0]): Promise<LiveToolStep> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new TheoremError('request', 'live session is not connected'); // lexicon-exempt: internal diagnostic
    }
    const resultPromise = new Promise<LiveToolStep>((resolve, reject) => {
      this.pendingExecuteResults.set(args.callId, { resolve, reject });
    });
    this.ws.send(clientMessage({ type: 'executeTool', ...args }));
    return resultPromise;
  }

  private async enqueueAudioChunk(base64Data: string, mimeType?: string): Promise<void> {
    if (!this.audioContext) return;

    try {
      this.ensurePlaybackBus();
      if (!this.playbackBus) return;

      const bytes = base64ToBytes(base64Data);
      let audioBuffer: AudioBuffer;

      if (mimeType?.includes('wav')) {
        const wavBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        audioBuffer = await this.audioContext.decodeAudioData(wavBuffer as ArrayBuffer);
      } else {
        // why: Raw PCM 24kHz 1-channel 16-bit LE
        const float32 = pcm16BytesToFloat32(bytes);
        audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
        audioBuffer.getChannelData(0).set(float32);
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackBus);

      const now = this.audioContext.currentTime;
      const startTime = Math.max(now, this.nextPlaybackTime);
      source.start(startTime);

      this.nextPlaybackTime = startTime + audioBuffer.duration;
      this.playbackNodes.push(source);
      this.startPlaybackMeter();

      source.onended = () => {
        const idx = this.playbackNodes.indexOf(source);
        if (idx !== -1) this.playbackNodes.splice(idx, 1);
        if (this.playbackNodes.length === 0) {
          this.stopPlaybackMeter();
          if (this.status === 'speaking') {
            this.setStatus(this.restingStatus());
          }
        }
      };
    } catch (err) {
      this.options.onError?.(asError(err));
    }
  }

  public cancelPlayback(): void {
    this.audioEpoch += 1;
    this.audioChain = Promise.resolve();
    for (const node of this.playbackNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // why: a node that already stopped throws on stop() and disconnect(); it leaves the list either way.
      }
    }
    this.playbackNodes = [];
    this.stopPlaybackMeter();
    if (this.audioContext) {
      this.nextPlaybackTime = this.audioContext.currentTime;
    }
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }

  public sendText(text: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(clientMessage({ type: 'text', text }));
    }
  }

  /**
   * Replace the page's context package. In a call it reaches the agent as
   * background, with no reply; before one, it goes with the call's opening.
   */
  public setContext(context: unknown): void {
    this.context = context;
    this.flushContext();
  }

  private flushContext(): void {
    if (this.opening || this.ws?.readyState !== WebSocket.OPEN) return;
    const next = JSON.stringify(this.context);
    if (next === this.sentContext) return;
    this.sentContext = next;
    this.ws.send(clientMessage({ type: 'context', context: this.context }));
  }

  public sendVideo(data: string, mimeType = 'image/jpeg'): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(clientMessage({ type: 'video', data, mimeType }));
    }
  }

  public disconnect(): void {
    this.clearReconnect();
    this.resumeHandle = undefined;
    this.teardownConnection();
    this.setStatus('disconnected');
  }

  private cleanupAudio(): void {
    this.cancelPlayback();
    this.stopPlaybackMeter();

    safeDisconnect(this.playbackBus);
    this.playbackBus = null;
    this.playbackAnalyser = null;
    this.playbackMeterBuffer = null;

    if (this.micWorklet) {
      this.micWorklet.port.onmessage = null;
      safeDisconnect(this.micWorklet);
      this.micWorklet = null;
    }

    safeDisconnect(this.micSource);
    this.micSource = null;

    stopMediaTracks(this.micStream);
    this.micStream = null;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        void this.audioContext.close();
      } catch {
        // why: close() throws on a context that already closed.
      }
      this.audioContext = null;
    }
  }
}
