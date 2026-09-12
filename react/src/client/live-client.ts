/**
 * Pure client-side SDK for THEORUM Gemini 3.1 Flash Live sessions over WebSocket relay.
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

import type { TurnEvent } from 'theorum';
import { float32Rms, float32RmsToLevel, timeDomainBytesToLevel } from './audio-level';
import { isPermissionDeniedError } from './live-errors';
import { type LiveServerEnvelope, parseLiveServerEnvelope } from './live-messages';
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
	'disconnected' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'error';

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

/** Decode base64 ASCII string to raw byte array. */
function base64ToBytes(data: string): Uint8Array {
	const bin = atob(data);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Encode raw byte array to base64 ASCII string. */
function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

/** Resample Float32 audio buffer from inputRate to 16000Hz and convert to Int16 PCM. */
function downsampleAndConvertToInt16(
	inputData: Float32Array,
	inputRate: number,
	outputRate = 16000,
): Int16Array {
	if (inputRate === outputRate) {
		const result = new Int16Array(inputData.length);
		for (let i = 0; i < inputData.length; i++) {
			const val = inputData[i] ?? 0;
			const s = Math.max(-1, Math.min(1, val));
			result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		return result;
	}

	const ratio = inputRate / outputRate;
	const newLength = Math.round(inputData.length / ratio);
	const result = new Int16Array(newLength);
	let offsetResult = 0;
	let offsetInput = 0;

	while (offsetResult < result.length) {
		const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
		let accum = 0;
		let count = 0;
		for (let i = offsetInput; i < nextOffsetInput && i < inputData.length; i++) {
			accum += inputData[i] ?? 0;
			count++;
		}
		const sample = count > 0 ? accum / count : 0;
		const s = Math.max(-1, Math.min(1, sample));
		result[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
		offsetResult++;
		offsetInput = nextOffsetInput;
	}
	return result;
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
	private playbackMeterBuffer: Uint8Array | null = null;
	private nextPlaybackTime = 0;
	private status: LiveSessionStatus = 'disconnected';
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

	getLiveSessionId(): string | undefined {
		return this.sessionId;
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

	public async connect(): Promise<void> {
		this.teardownConnection();
		this.setStatus('connecting');
		this.setConnectPhase('socket');

		try {
			const AudioContextClass = window.AudioContext;
			this.audioContext = new AudioContextClass();
			if (this.audioContext.state === 'suspended') {
				await this.audioContext.resume();
			}

			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
			const profileParam = this.options.profile
				? `?profile=${encodeURIComponent(this.options.profile)}`
				: '';
			const defaultUrl = `${protocol}//${window.location.host}/api/live/relay${profileParam}`;
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

	private async activateMicrophone(): Promise<void> {
		if (this.micActivating || this.status !== 'connecting') return;
		this.micActivating = true;
		this.setConnectPhase('microphone');

		try {
			if (!this.audioContext || this.audioContext.state === 'closed') {
				const AudioContextClass = window.AudioContext;
				this.audioContext = new AudioContextClass();
				if (this.audioContext.state === 'suspended') {
					await this.audioContext.resume();
				}
			}

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

	private async setupMicrophonePipeline(): Promise<void> {
		if (!this.micStream || !this.audioContext) return;

		this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
		const silent = this.audioContext.createGain();
		silent.gain.value = 0;

		const forwardMicFrame = (inputFloat32: Float32Array) => {
			if (!this.isMuted) {
				this.options.onVolumeLevel?.(float32RmsToLevel(inputFloat32), true);
			}

			if (this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
				return;
			}

			const sampleRate = this.audioContext?.sampleRate ?? 48000;
			const rms = float32Rms(inputFloat32);

			// Hold back quiet mic frames during model playback so speaker bleed does not
			// trip START_OF_ACTIVITY_INTERRUPTS. Loud user speech still passes for barge-in.
			const modelPlaying = this.playbackNodes.length > 0 || this.status === 'speaking';
			if (modelPlaying && rms < BARGE_IN_RMS_WHILE_SPEAKING) return;

			const pcm16 = downsampleAndConvertToInt16(inputFloat32, sampleRate, 16000);
			const base64 = bytesToBase64(new Uint8Array(pcm16.buffer));
			this.ws.send(JSON.stringify({ type: 'audio', data: base64 }));
		};

		if (!this.micWorkletModuleLoaded) {
			await this.audioContext.audioWorklet.addModule(micCaptureWorkletUrl);
			this.micWorkletModuleLoaded = true;
		}

		this.micWorklet = new AudioWorkletNode(this.audioContext, 'mic-capture-processor');
		this.micWorklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
			const inputFloat32 = new Float32Array(event.data);
			forwardMicFrame(inputFloat32);
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

	private enqueueServerMessage(data: string | ArrayBuffer | Blob): void {
		this.inboundChain = this.inboundChain
			.then(async () => {
				if (typeof data !== 'string') return;

				try {
					const payload = parseLiveServerEnvelope(JSON.parse(data) as unknown);
					if (!payload) return;
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

	private async tryHandleControlEnvelope(payload: LiveServerEnvelope): Promise<boolean> {
		if (payload.type === 'ready') {
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
			return true;
		}
		if (payload.type === 'executeToolResult') {
			const pending = this.pendingExecuteResults.get(payload.callId);
			if (pending) {
				this.pendingExecuteResults.delete(payload.callId);
				pending.resolve(payload);
			}
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
		const interim = event.evidence?.interim === true;
		const kind = event.evidence?.kind;
		if (kind === 'input_transcription') {
			this.options.onTranscript?.(event.text, true, { interim });
			return;
		}
		if (kind === 'output_transcription') {
			this.options.onTranscript?.(event.text, false, { interim });
		}
	}

	private handleSessionTurnEvent(event: TurnEvent): void {
		if (event.type === 'session' && event.session?.kind === 'closing_soon') {
			this.options.onSessionClosing?.(event.session.timeLeftMs);
		}
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
		const tool = event.tool;
		if (tool.phase === 'cancel') {
			if (tool.id) accum.cancelledToolIds.add(tool.id);
			return;
		}
		if (!tool.name) return;
		const failure =
			tool.phase === 'error' && tool.failure?.message ? tool.failure.message : undefined;
		accum.toolCalls.push({
			id: tool.id ?? '',
			name: tool.name,
			arguments: tool.arguments ?? {},
			error: failure,
		});
	}

	private handleDoneTurnEvent(event: TurnEvent): void {
		if (event.type !== 'done') return;
		if (event.interrupted) {
			this.cancelPlayback();
		}
		if (event.stop?.kind !== 'generation_complete') {
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

	private async handleToolExecutions(calls: LiveToolCall[]): Promise<void> {
		for (const call of calls) {
			if (call.error) {
				// Escape hatch for pre-failed calls — still need an upstream response.
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					this.ws.send(
						JSON.stringify({
							type: 'toolResponses',
							responses: [
								{
									id: call.id,
									name: call.name,
									output: { error: call.error },
								},
							],
						}),
					);
				}
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
					if (this.ws && this.ws.readyState === WebSocket.OPEN) {
						this.ws.send(
							JSON.stringify({
								type: 'toolResponses',
								responses: [
									{
										id: call.id,
										name: call.name,
										output: { error: message },
									},
								],
							}),
						);
					}
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

	/**
	 * Escape hatch: send tool output upstream without `executeTool` stages.
	 * Use after a UI deny (or similar) when the call was gated and never started.
	 */
	sendToolResponses(responses: Array<{ id: string; name: string; output: unknown }>): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Live session is not connected');
		}
		this.ws.send(JSON.stringify({ type: 'toolResponses', responses }));
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
				const int16 = new Int16Array(bytes.buffer);
				const float32 = new Float32Array(int16.length);
				for (let i = 0; i < int16.length; i++) {
					const sample = int16[i] ?? 0;
					float32[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
				}
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
						this.setStatus('listening');
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

	public toggleMute(): boolean {
		this.isMuted = !this.isMuted;
		return this.isMuted;
	}

	public sendText(text: string): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'text', text }));
		}
	}

	public sendVideo(data: string, mimeType = 'image/jpeg'): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: 'video', data, mimeType }));
		}
	}

	public disconnect(): void {
		this.teardownConnection();
		this.setStatus('disconnected');
	}

	private cleanupAudio(): void {
		this.cancelPlayback();
		this.stopPlaybackMeter();

		if (this.playbackBus) {
			try {
				this.playbackBus.disconnect();
			} catch {
				/* ignore */
			}
			this.playbackBus = null;
		}
		this.playbackAnalyser = null;
		this.playbackMeterBuffer = null;

		if (this.micWorklet) {
			try {
				this.micWorklet.port.onmessage = null;
				this.micWorklet.disconnect();
			} catch {
				/* ignore */
			}
			this.micWorklet = null;
		}

		if (this.micSource) {
			try {
				this.micSource.disconnect();
			} catch {
				/* ignore */
			}
			this.micSource = null;
		}

		if (this.micStream) {
			for (const track of this.micStream.getTracks()) {
				track.stop();
			}
			this.micStream = null;
		}

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
