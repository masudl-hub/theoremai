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

import type { TurnEvent } from '../../../mod.ts';
import { float32Rms, float32RmsToLevel, timeDomainBytesToLevel } from './audio-level';
import { isPermissionDeniedError } from './live-errors';
import {
	applyLiveToolTurnEvent,
	liveTranscriptFromEvidence,
	shouldForwardMicFrame,
} from './live/live-mic-forward';
import { type LiveServerEnvelope, parseLiveServerEnvelope } from './live-messages';
import { base64ToBytes, bytesToBase64 } from '../../../src/kernel/util/base64.ts';
import { downsampleAndConvertToInt16, pcm16BytesToFloat32 } from './pcm-downsample';
import micCaptureWorkletUrl from './mic-capture.worklet?worker&url';

type LiveToolCall = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	error?: string;
};

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

export type LiveSessionStatus =
	| 'disconnected'
	| 'connecting'
	| 'ready'
	| 'listening'
	| 'speaking'
	| 'working'
	| 'error';

export type LiveConnectPhase = 'socket' | 'microphone';

export interface LiveClientOptions {
	profile?: string;
	relayUrl?: string;
	/** When false, skip microphone capture; session still receives model audio. */
	voiceIngress?: boolean;
	onStatusChange?: (status: LiveSessionStatus) => void;
	onConnectPhase?: (phase: LiveConnectPhase | null) => void;
	onTranscript?: (text: string, isUser: boolean, meta?: { interim?: boolean }) => void;
	onTurnEvent?: (event: TurnEvent) => void;
	onError?: (error: string) => void;
	/** Provider signalled the upstream session is draining (e.g. goAway). */
	onSessionClosing?: (timeLeftMs?: number) => void;
	onToolCall?: (
		name: string,
		args: Record<string, unknown>,
		meta: { callId: string },
	) => Promise<Record<string, unknown>> | Record<string, unknown>;
	/** Fired when the relay assigns a live session id (steer inbox key). */
	onSessionReady?: (info: { sessionId?: string; profile?: string }) => void;
	onVolumeLevel?: (level: number, isUser: boolean) => void;
}

function safeDisconnect(node?: { disconnect?: () => void } | null): void {
	if (!node || typeof node.disconnect !== 'function') return;
	try {
		node.disconnect();
	} catch {
		/* ignore */
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
	private ws: WebSocket | null = null;
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
	/** Bumped on barge-in / cancel so stale audioChain work is skipped. */
	private audioEpoch = 0;
	private sessionId: string | undefined;
	private pendingExecuteResults = new Map<
		string,
		{
			resolve: (value: Extract<LiveServerEnvelope, { type: 'executeToolResult' }>) => void;
			reject: (reason: Error) => void;
		}
	>();

	constructor(options: LiveClientOptions = {}) {
		this.options = options;
	}

	private setStatus(newStatus: LiveSessionStatus): void {
		this.status = newStatus;
		if (newStatus === 'listening' || newStatus === 'disconnected' || newStatus === 'error') {
			this.clearConnectTimeout();
		}
		this.options.onStatusChange?.(newStatus);
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
		if (!this.ws) return;
		this.ws.onopen = null;
		this.ws.onmessage = null;
		this.ws.onclose = null;
		this.ws.onerror = null;
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
	}

	private teardownConnection(): void {
		this.clearConnectTimeout();
		this.micActivating = false;
		this.setConnectPhase(null);
		this.detachWebSocket();
		this.cleanupAudio();
	}

	private failConnect(message: string, denied = false): void {
		if (this.status === 'error' || this.status === 'disconnected') return;
		this.teardownConnection();
		this.options.onError?.(denied ? 'Permission denied...' : message);
		this.setStatus('error');
	}

	// fallow-ignore-next-line unused-class-member -- called from useLiveRunnerControls via client refs
	public async connect(): Promise<void> {
		this.teardownConnection();
		this.setStatus('connecting');
		this.setConnectPhase('socket');

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

			this.ws = new WebSocket(url);
			this.ws.binaryType = 'arraybuffer';

			this.connectTimeout = setTimeout(() => {
				if (this.status === 'connecting') {
					this.failConnect('Live connection timed out');
				}
			}, 20_000);

			this.ws.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
				this.enqueueServerMessage(event.data);
			};

			this.ws.onclose = () => {
				if (this.status === 'connecting') {
					this.failConnect('Live connection closed before ready');
					return;
				}
				this.teardownConnection();
				this.setStatus('disconnected');
			};

			this.ws.onerror = () => {
				this.failConnect('WebSocket live connection error');
			};
		} catch (err) {
			const error = err as DOMException & Error;
			this.failConnect(
				error.message || 'Failed to start live session',
				isPermissionDeniedError(err),
			);
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
		if (this.micActivating || this.status !== 'connecting') return;
		this.micActivating = true;
		this.setConnectPhase('microphone');

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
			this.setConnectPhase(null);
			this.setStatus('listening');
		} catch (err) {
			const error = err as DOMException & Error;
			this.failConnect(
				error.message || 'Failed to access microphone',
				isPermissionDeniedError(err),
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
			socket.send(JSON.stringify({ type: 'audio', data: base64 }));
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
			await this.audioContext.audioWorklet.addModule(micCaptureWorkletUrl);
			this.micWorkletModuleLoaded = true;
		}

		this.micWorklet = new AudioWorkletNode(this.audioContext, 'mic-capture-processor');
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
		const runnableTools = accum.toolCalls.filter(
			(call) => !accum.cancelledToolIds.has(call.id),
		);
		if (runnableTools.length > 0) {
			await this.handleToolExecutions(runnableTools);
		}
		this.scheduleMediaChunks(accum.mediaChunks);
	}

	private enqueueServerMessage(data: string | ArrayBuffer | Blob): void {
		this.inboundChain = this.inboundChain
			.then(async () => {
				if (typeof data !== 'string') return;

				try {
					const payload = parseLiveServerEnvelope(JSON.parse(data) as unknown);
					if (payload) await this.processServerEnvelope(payload);
				} catch (err) {
					this.options.onError?.((err as Error).message || 'Failed to parse live server event');
				}
			})
			.catch((err: unknown) => {
				this.options.onError?.(
					err instanceof Error ? err.message : 'Failed to handle live server event',
				);
			});
	}

	private async handleReadyEnvelope(
		payload: Extract<LiveServerEnvelope, { type: 'ready' }>,
	): Promise<void> {
		this.sessionId = payload.sessionId;
		this.options.onSessionReady?.({
			sessionId: payload.sessionId,
			profile: payload.profile,
		});
		if (this.options.voiceIngress === false) {
			this.setConnectPhase(null);
			this.setStatus('listening');
		} else {
			await this.activateMicrophone();
		}
	}

	private handleExecuteToolResultEnvelope(
		payload: Extract<LiveServerEnvelope, { type: 'executeToolResult' }>,
	): void {
		const pending = this.pendingExecuteResults.get(payload.callId);
		if (pending) {
			this.pendingExecuteResults.delete(payload.callId);
			pending.resolve(payload);
		}
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
		if (payload.type === 'error') {
			this.options.onError?.(payload.error);
			this.setStatus('error');
			return true;
		}
		return false;
	}

	private collectInboundTurn(events: TurnEvent[]): InboundTurnAccum {
		const accum = emptyInboundTurnAccum();
		for (const event of events) {
			this.processTurnEvent(event, accum);
		}
		return accum;
	}

	private processTurnEvent(event: TurnEvent, accum: InboundTurnAccum): void {
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
				this.collectToolTurnEvent(event, accum);
				break;
			case 'done':
				this.handleDoneTurnEvent(event);
				break;
		}
	}

	private handleEvidenceTurnEvent(event: TurnEvent): void {
		if (event.type !== 'evidence' || !event.text) return;
		const transcript = liveTranscriptFromEvidence({
			kind: event.evidence?.kind,
			text: event.text,
			interim: event.evidence?.interim,
		});
		if (transcript) this.options.onTranscript?.(transcript.text, transcript.isUser, { interim: transcript.interim });
	}

	private handleSessionTurnEvent(event: TurnEvent): void {
		if (event.type !== 'session' || !event.session) return;
		const { kind, timeLeftMs } = event.session;
		if (kind === 'closing_soon') {
			this.options.onSessionClosing?.(timeLeftMs);
			return;
		}
		this.serverWorking = kind === 'working';
		const nextStatus = resolveWorkingStatusTransition(this.status, this.serverWorking);
		if (nextStatus) this.setStatus(nextStatus);
	}

	/** Status to settle into once model speech stops. */
	private restingStatus(): LiveSessionStatus {
		return this.serverWorking ? 'working' : 'listening';
	}

	private collectMediaTurnEvent(event: TurnEvent, accum: InboundTurnAccum): void {
		if (event.type !== 'media' || !event.media?.data) return;
		this.setStatus('speaking');
		accum.mediaChunks.push({
			data: event.media.data,
			mimeType: event.media.mimeType,
		});
	}

	private collectToolTurnEvent(event: TurnEvent, accum: InboundTurnAccum): void {
		if (event.type !== 'tool' || !event.tool) return;
		applyLiveToolTurnEvent(event.tool, accum);
	}

	private handleDoneTurnEvent(event: TurnEvent): void {
		if (event.type !== 'done') return;
		if (event.interrupted) {
			this.cancelPlayback();
		}
		if (event.stop?.kind !== 'generation_complete') {
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
					this.options.onError?.(err instanceof Error ? err.message : 'Failed to play audio chunk');
				});
		}
	}

	private sendToolErrorResponse(id: string, name: string, error: string): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(
				JSON.stringify({
					type: 'toolResponses',
					responses: [{ id, name, output: { error } }],
				}),
			);
		}
	}

	private async handleToolExecutions(calls: LiveToolCall[]): Promise<void> {
		for (const call of calls) {
			if (call.error) {
				// Escape hatch for pre-failed calls — still need an upstream response.
				this.sendToolErrorResponse(call.id, call.name, call.error);
				continue;
			}

			if (this.options.onToolCall) {
				// Host may run UI / credentials; then we prefer session.executeTool on the relay.
				try {
					await this.options.onToolCall(call.name, call.arguments, {
						callId: call.id,
					});
				} catch (err) {
					const message = (err as Error).message || 'Tool execution failed';
					this.sendToolErrorResponse(call.id, call.name, message);
				}
				continue;
			}

			// Default: run through LiveSession.executeTool on the relay (stages + upstream).
			await this.executeToolOnRelay({
				name: call.name,
				callId: call.id || `call_${Date.now()}`,
				input: call.arguments,
			});
		}
	}

	/**
	 * Ask the relay to run `LiveSession.executeTool` (stages + upstream tool response).
	 * Returns the settlement; when gated, the host must call again with resume.
	 */
	executeToolOnRelay(args: {
		name: string;
		callId: string;
		input?: unknown;
		resume?: { value?: unknown; granted?: boolean };
		credentials?: Record<string, unknown>;
	}): Promise<Extract<LiveServerEnvelope, { type: 'executeToolResult' }>> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Live session is not connected');
		}
		const resultPromise = new Promise<Extract<LiveServerEnvelope, { type: 'executeToolResult' }>>(
			(resolve, reject) => {
				this.pendingExecuteResults.set(args.callId, { resolve, reject });
			},
		);
		this.ws.send(
			JSON.stringify({
				type: 'executeTool',
				name: args.name,
				callId: args.callId,
				input: args.input,
				resume: args.resume,
				credentials: args.credentials,
			}),
		);
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
					// Raw PCM 24kHz 1-channel 16-bit LE
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
			this.options.onError?.((err as Error).message || 'Failed to play audio chunk');
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
				/* ignore */
			}
		}
		this.playbackNodes = [];
		this.stopPlaybackMeter();
		if (this.audioContext) {
			this.nextPlaybackTime = this.audioContext.currentTime;
		}
	}

	// fallow-ignore-next-line unused-class-member -- called from useLiveRunnerControls via client refs
	public toggleMute(): boolean {
		this.isMuted = !this.isMuted;
		return this.isMuted;
	}

	// fallow-ignore-next-line unused-class-member -- called from useLiveRunnerControls via client refs
	public sendText(text: string): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'text', text }));
		}
	}

	// fallow-ignore-next-line unused-class-member -- called from useLiveRunnerControls via client refs
	public sendVideo(data: string, mimeType = 'image/jpeg'): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'video', data, mimeType }));
		}
	}

	// fallow-ignore-next-line unused-class-member -- called from useLiveSessionClient teardown
	public disconnect(): void {
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
				/* ignore */
			}
			this.audioContext = null;
		}
	}
}
