/**
 * Pure protocol framing & serialization for Google Gemini Live WebSocket API (`BidiGenerateContent`).
 *
 * All functions are pure data transformations with no network I/O.
 *
 * @module
 */

import { groundingFromEvent } from '../../../kernel/engine/delta.ts';
import { getTool } from '../../../kernel/tools/registry.ts';
import type {
  InteractionPart,
  LiveVadSpec,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnTokens,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { base64ToBytes, bytesToBase64, wrapPcmAsWav } from '../../shared/pcm.ts';
import { parseToolArgumentsObject } from '../../shared/tool-args.ts';
import { GEMINI_LIVE_WS_URL } from '../urls.ts';
import { toGeminiOpenApiSchema } from './openapi-schema.ts';

/** Construct authenticated WebSocket URL for Gemini Live API. */
export function buildGeminiLiveWebSocketUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
}

export function wireFunctionDeclaration(decl: WireFunctionTool): Record<string, unknown> {
  const parameters = toGeminiOpenApiSchema(decl.parameters);
  return {
    name: decl.name,
    description: decl.description,
    parameters:
      parameters && typeof parameters === 'object'
        ? (parameters as Record<string, unknown>)
        : { type: 'OBJECT', properties: {} },
  };
}

export function wireLiveTools(req: ProviderCompleteRequest): Array<Record<string, unknown>> {
  const functionDeclarations: Array<Record<string, unknown>> = [];
  for (const id of req.builtins) {
    const entry = getTool(id);
    if (entry?.type === 'builtin' && entry.wire.live) {
      functionDeclarations.push({
        name: id,
        description: entry.description,
      });
    }
  }
  for (const decl of req.wireTools ?? []) {
    functionDeclarations.push(wireFunctionDeclaration(decl));
  }
  if (functionDeclarations.length === 0) {
    return [];
  }
  return [{ functionDeclarations }];
}

function buildLiveGenerationConfig(req: ProviderCompleteRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['AUDIO'],
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  };
  if (req.live?.voice) {
    generationConfig.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: req.live.voice,
        },
      },
    };
  }
  if (req.thinking && req.thinking !== 'none') {
    generationConfig.thinkingConfig = {
      thinkingLevel: req.thinking,
    };
  }
  return generationConfig;
}

function normalizeStartSensitivity(val?: string): string {
  return val?.includes('HIGH') ? 'START_SENSITIVITY_HIGH' : 'START_SENSITIVITY_LOW';
}

function normalizeEndSensitivity(val?: string): string {
  return val?.includes('HIGH') ? 'END_SENSITIVITY_HIGH' : 'END_SENSITIVITY_LOW';
}

function buildLiveRealtimeInputConfig(vad: LiveVadSpec): Record<string, unknown> | undefined {
  const automaticActivityDetection: Record<string, unknown> = {};
  if (vad.startSensitivity !== undefined) {
    automaticActivityDetection.startOfSpeechSensitivity = normalizeStartSensitivity(
      vad.startSensitivity,
    );
  }
  if (vad.endSensitivity !== undefined) {
    automaticActivityDetection.endOfSpeechSensitivity = normalizeEndSensitivity(vad.endSensitivity);
  }
  if (vad.prefixPaddingMs !== undefined) {
    automaticActivityDetection.prefixPaddingMs = vad.prefixPaddingMs;
  }
  if (vad.silenceDurationMs !== undefined) {
    automaticActivityDetection.silenceDurationMs = vad.silenceDurationMs;
  }

  const config: Record<string, unknown> = {};
  if (vad.activityHandling !== undefined) {
    config.activityHandling = vad.activityHandling;
  }
  if (Object.keys(automaticActivityDetection).length > 0) {
    config.automaticActivityDetection = automaticActivityDetection;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function buildLiveSessionResumption(
  req: ProviderCompleteRequest,
): Record<string, unknown> | undefined {
  if (req.sessionResumptionHandle) {
    return { handle: req.sessionResumptionHandle };
  }
  if (req.live?.sessionResumption) {
    return {};
  }
  return undefined;
}

function liveModelName(apiId: string): string {
  return apiId.startsWith('models/') ? apiId : `models/${apiId}`;
}

function applyLiveOptionalFeatures(
  live: ProviderCompleteRequest['live'],
  setup: Record<string, unknown>,
): void {
  if (live?.transcription?.input) {
    setup.inputAudioTranscription = {};
  }
  if (live?.transcription?.output) {
    setup.outputAudioTranscription = {};
  }
  if (live?.proactiveAudio === true) {
    setup.proactivity = { proactiveAudio: true };
  }
}

/** Build the initial `setup` message sent once immediately after WebSocket open. */
export function buildGeminiLiveSetupMessage(req: ProviderCompleteRequest): Record<string, unknown> {
  const live = req.live;
  const realtimeInputConfig = live?.vad ? buildLiveRealtimeInputConfig(live.vad) : undefined;
  const tools = wireLiveTools(req);
  const sessionResumption = buildLiveSessionResumption(req);

  // Only opt into initial-history gating when we actually have history to seed.
  // With `initialHistoryInClientContent: true`, Gemini waits for clientContent
  // after setupComplete and will not start realtime generation until that lands —
  // empty sessions (e.g. Th30) would hang forever if this were always set.
  const seedInitialHistory = Boolean(req.history && req.history.length > 0);

  const setup: Record<string, unknown> = {
    model: liveModelName(req.apiId),
    generationConfig: buildLiveGenerationConfig(req),
    systemInstruction: {
      parts: [{ text: req.system }],
    },
    ...(tools.length > 0 ? { tools } : {}),
    ...(sessionResumption ? { sessionResumption } : {}),
    ...(live?.contextCompression === 'slidingWindow'
      ? { contextWindowCompression: { slidingWindow: {} } }
      : {}),
    ...(seedInitialHistory ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
    ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
  };

  applyLiveOptionalFeatures(live, setup);
  return { setup };
}

/** Format a single history message into a Google turn object. */
function historyTurnToGoogleTurn(msg: TurnHistoryMessage): Record<string, unknown> {
  const role = msg.role === 'assistant' ? 'model' : 'user';
  const parts: Array<Record<string, unknown>> = [];

  if (msg.content) {
    parts.push({ text: msg.content });
  }

  for (const part of msg.parts ?? []) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    } else {
      parts.push({
        inlineData: {
          mimeType: part.mimeType,
          data: part.data,
        },
      });
    }
  }

  return { role, parts };
}

/** Build the `clientContent` message used for seeding conversation history before realtime streaming. */
export function buildGeminiLiveClientContent(
  history: TurnHistoryMessage[],
): Record<string, unknown> | null {
  if (!history || history.length === 0) {
    return null;
  }
  return {
    clientContent: {
      turns: history.map(historyTurnToGoogleTurn),
      turnComplete: true,
    },
  };
}

/** Build a `realtimeInput` message for streaming audio, video, or text chunks. */
export function buildGeminiLiveRealtimeInput(part: InteractionPart): Record<string, unknown> {
  if (part.type === 'text') {
    return {
      realtimeInput: {
        text: part.text,
      },
    };
  }

  if (part.type === 'audio') {
    return {
      realtimeInput: {
        audio: {
          mimeType: part.mimeType.includes('rate=') ? part.mimeType : 'audio/pcm;rate=16000',
          data: part.data,
        },
      },
    };
  }

  // Image / video frame
  return {
    realtimeInput: {
      video: {
        mimeType: part.mimeType || 'image/jpeg',
        data: part.data,
      },
    },
  };
}

/** Build a `realtimeInput` message with text. */
export function buildGeminiLiveRealtimeText(text: string): Record<string, unknown> {
  return {
    realtimeInput: {
      text,
    },
  };
}

/** Build the Gemini Live `response` struct for a function result. */
function liveFunctionResponsePayload(output: unknown): Record<string, unknown> {
  if (
    typeof output === 'object' &&
    output !== null &&
    'error' in output &&
    typeof (output as { error?: unknown }).error === 'string'
  ) {
    return { error: (output as { error: string }).error };
  }
  return { result: output };
}

/** Build a `toolResponse` message returning the execution result of a tool call. */
export function buildGeminiLiveToolResponse(
  id: string,
  name: string,
  output: unknown,
): Record<string, unknown> {
  return buildGeminiLiveToolResponses([{ id, name, output }]);
}

/** Build a batched `toolResponse` for one or more function results. */
export function buildGeminiLiveToolResponses(
  responses: Array<{ id: string; name: string; output: unknown }>,
): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: responses.map(({ id, name, output }) => ({
        id,
        name,
        response: liveFunctionResponsePayload(output),
      })),
    },
  };
}

/** Parse raw WebSocket message text / buffer into a JSON record. */
export type ParsedLiveMessage =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'empty' | 'malformed' };

export function parseGeminiLiveMessage(raw: unknown): ParsedLiveMessage {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
      const text = new TextDecoder().decode(raw);
      return parseGeminiLiveMessage(text);
    }
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'empty' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, reason: 'malformed' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

export function parseFunctionArguments(raw: unknown): ReturnType<typeof parseToolArgumentsObject> {
  return parseToolArgumentsObject(raw);
}

function readTokenCount(
  metadata: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): number {
  const val = metadata[camelKey] ?? metadata[snakeKey];
  return typeof val === 'number' ? val : 0;
}

export function extractUsageTokens(metadata: Record<string, unknown>): TurnTokens | undefined {
  const prompt = readTokenCount(metadata, 'promptTokenCount', 'prompt_token_count');
  const output = readTokenCount(metadata, 'responseTokenCount', 'response_token_count');
  const thinking = readTokenCount(metadata, 'thoughtsTokenCount', 'thoughts_token_count');
  const rawTotal = metadata.totalTokenCount ?? metadata.total_token_count;
  const total = typeof rawTotal === 'number' ? rawTotal : prompt + output;
  if (prompt === 0 && output === 0 && total === 0) {
    return undefined;
  }
  return {
    input: prompt,
    output,
    thinking: thinking > 0 ? thinking : undefined,
    total,
  };
}

function foldSessionUpdate(message: Record<string, unknown>, events: TurnEvent[]): void {
  const sessionUpdate = message.sessionResumptionUpdate as
    | { newHandle?: string; resumable?: boolean }
    | undefined;
  if (!sessionUpdate || typeof sessionUpdate !== 'object') return;
  const hasHandle =
    typeof sessionUpdate.newHandle === 'string' && sessionUpdate.newHandle.length > 0;
  const hasResumable = typeof sessionUpdate.resumable === 'boolean';
  if (!hasHandle && !hasResumable) return;
  events.push({
    type: 'evidence',
    ...(hasHandle ? { sessionResumptionHandle: sessionUpdate.newHandle } : {}),
    evidence: {
      provider: 'google',
      kind: 'session_resumption',
      resumable: hasResumable ? sessionUpdate.resumable : hasHandle,
      raw: sessionUpdate as Record<string, unknown>,
    },
  });
}

function foldToolCalls(message: Record<string, unknown>, events: TurnEvent[]): void {
  const toolCall = message.toolCall as
    | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
    | undefined;
  if (!toolCall?.functionCalls || !Array.isArray(toolCall.functionCalls)) return;
  for (const call of toolCall.functionCalls) {
    if (!call.name) continue;
    const parsed = parseFunctionArguments(call.args);
    if (!parsed.ok) {
      events.push({
        type: 'tool',
        tool: {
          id: call.id,
          name: call.name,
          arguments: {},
          phase: 'error',
          failure: {
            code: 'malformed_arguments',
            message: parsed.error,
            details: { raw: parsed.raw },
          },
        },
      });
      continue;
    }
    events.push({
      type: 'tool',
      tool: {
        id: call.id,
        name: call.name,
        arguments: parsed.value,
      },
    });
  }
}

function foldToolCancellations(message: Record<string, unknown>, events: TurnEvent[]): void {
  const cancellation = message.toolCallCancellation as { ids?: unknown } | undefined;
  const ids = cancellation?.ids;
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) continue;
    events.push({
      type: 'tool',
      tool: {
        id,
        name: '',
        phase: 'cancel',
      },
    });
  }
}

/** Parse Gemini goAway.timeLeft (seconds number, "10s", duration string) → ms when known. */
export function parseGoAwayTimeLeftMs(timeLeft: unknown): number | undefined {
  if (typeof timeLeft === 'number' && Number.isFinite(timeLeft) && timeLeft >= 0) {
    return Math.round(timeLeft * 1000);
  }
  if (typeof timeLeft !== 'string') return undefined;
  const trimmed = timeLeft.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const match = /^(\d+(?:\.\d+)?)\s*s$/i.exec(trimmed);
  if (match?.[1]) {
    const s = Number(match[1]);
    if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  }
  return undefined;
}

function foldGoAway(message: Record<string, unknown>, events: TurnEvent[]): void {
  const goAway = message.goAway as { timeLeft?: unknown } | undefined;
  if (!goAway || typeof goAway !== 'object') return;
  const timeLeftMs = parseGoAwayTimeLeftMs(goAway.timeLeft);
  events.push({
    type: 'session',
    session: {
      kind: 'closing_soon',
      ...(timeLeftMs !== undefined ? { timeLeftMs } : {}),
    },
  });
}

interface ModelTurnPart {
  text?: string;
  thought?: string | boolean;
  inlineData?: { mimeType?: string; data?: string };
}

function foldModelPart(part: ModelTurnPart, events: TurnEvent[]): void {
  if (part.text) {
    if (part.thought) {
      events.push({ type: 'thought', text: part.text });
    } else {
      events.push({ type: 'text', text: part.text });
    }
  }
  if (part.inlineData?.data) {
    const mime = part.inlineData.mimeType ?? 'audio/pcm;rate=24000';
    if (
      mime.startsWith('audio/pcm') ||
      mime.startsWith('audio/raw') ||
      mime.startsWith('audio/l16')
    ) {
      const wav = wrapPcmAsWav(base64ToBytes(part.inlineData.data), 24000);
      events.push({
        type: 'media',
        media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
      });
    } else {
      events.push({
        type: 'media',
        media: { mimeType: mime, data: part.inlineData.data },
      });
    }
  }
}

function foldTranscription(
  text: string | undefined,
  kind: 'input_transcription' | 'output_transcription',
  events: TurnEvent[],
  interim?: boolean,
): void {
  if (!text) return;
  events.push({
    type: 'evidence',
    text,
    evidence: {
      provider: 'google',
      kind,
      ...(interim ? { interim: true } : {}),
    },
  });
}

function foldLiveGrounding(serverContent: Record<string, unknown>, events: TurnEvent[]): void {
  const groundingEvent = groundingFromEvent({
    groundingMetadata: serverContent.groundingMetadata ?? serverContent.grounding_metadata,
  });
  if (groundingEvent) {
    events.push(groundingEvent);
  }
  const urlContext = serverContent.urlContextMetadata ?? serverContent.url_context_metadata;
  if (urlContext && typeof urlContext === 'object') {
    events.push({
      type: 'evidence',
      evidence: {
        provider: 'google',
        kind: 'url_context',
        raw: urlContext as Record<string, unknown>,
      },
    });
  }
}

function foldServerContent(message: Record<string, unknown>, events: TurnEvent[]): void {
  const serverContent = message.serverContent as Record<string, unknown> | undefined;
  if (!serverContent || typeof serverContent !== 'object') return;

  if (serverContent.interrupted === true) {
    events.push({
      type: 'done',
      interrupted: true,
      stop: { kind: 'interrupted' as const },
    });
  }

  if (serverContent.waitingForInput === true || serverContent.waiting_for_input === true) {
    events.push({
      type: 'session',
      session: { kind: 'waiting_for_input' },
    });
  }

  if (serverContent.generationComplete === true || serverContent.generation_complete === true) {
    events.push({
      type: 'done',
      stop: { kind: 'generation_complete' as const },
    });
  }

  const inputTranscription = serverContent.inputTranscription as { text?: string } | undefined;
  foldTranscription(inputTranscription?.text, 'input_transcription', events);

  const interimInput = serverContent.interimInputTranscription as { text?: string } | undefined;
  foldTranscription(interimInput?.text, 'input_transcription', events, true);

  const outputTranscription = serverContent.outputTranscription as { text?: string } | undefined;
  foldTranscription(outputTranscription?.text, 'output_transcription', events);

  const modelTurn = serverContent.modelTurn as { parts?: ModelTurnPart[] } | undefined;
  for (const part of modelTurn?.parts ?? []) {
    foldModelPart(part, events);
  }

  foldLiveGrounding(serverContent, events);
}

function foldUsageMetadata(message: Record<string, unknown>, events: TurnEvent[]): void {
  const usageMetadata = message.usageMetadata as Record<string, unknown> | undefined;
  if (usageMetadata) {
    const tokens = extractUsageTokens(usageMetadata);
    if (tokens) {
      events.push({ type: 'tokens', tokens });
    }
  }
}

/**
 * Fold a raw `BidiGenerateContentServerMessage` into normalized `TurnEvent` items.
 */
export function foldGeminiLiveServerMessage(
  message: Record<string, unknown> | null | undefined,
): TurnEvent[] {
  if (!message || typeof message !== 'object') return [];
  const events: TurnEvent[] = [];
  foldGoAway(message, events);
  foldSessionUpdate(message, events);
  foldToolCalls(message, events);
  foldToolCancellations(message, events);
  foldServerContent(message, events);
  foldUsageMetadata(message, events);
  return events;
}
