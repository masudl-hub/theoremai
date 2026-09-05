/**
 * Pure protocol framing & serialization for Google Gemini Live WebSocket API (`BidiGenerateContent`).
 *
 * All functions are pure data transformations with no network I/O.
 *
 * @module
 */

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

/** Default VAD configuration when omitted on profile. */
const DEFAULT_VAD: Required<LiveVadSpec> = {
  activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
  startSensitivity: 'START_SENSITIVITY_LOW',
  endSensitivity: 'END_SENSITIVITY_LOW',
  prefixPaddingMs: 500,
  silenceDurationMs: 1500,
};

/** Construct authenticated WebSocket URL for Gemini Live API. */
export function buildGeminiLiveWebSocketUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
}

export function wireFunctionDeclaration(decl: WireFunctionTool): Record<string, unknown> {
  return {
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
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

function buildLiveRealtimeInputConfig(vad: Required<LiveVadSpec>): Record<string, unknown> {
  return {
    activityHandling: vad.activityHandling,
    automaticActivityDetection: {
      startOfSpeechSensitivity: normalizeStartSensitivity(vad.startSensitivity),
      endOfSpeechSensitivity: normalizeEndSensitivity(vad.endSensitivity),
      prefixPaddingMs: vad.prefixPaddingMs,
      silenceDurationMs: vad.silenceDurationMs,
    },
  };
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
}

/** Build the initial `setup` message sent once immediately after WebSocket open. */
export function buildGeminiLiveSetupMessage(req: ProviderCompleteRequest): Record<string, unknown> {
  const live = req.live;
  const vad = { ...DEFAULT_VAD, ...(live?.vad ?? {}) };
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
    contextWindowCompression:
      live?.contextCompression === 'none' ? undefined : { slidingWindow: {} },
    ...(seedInitialHistory ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
    realtimeInputConfig: buildLiveRealtimeInputConfig(vad),
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
  if (sessionUpdate?.newHandle) {
    events.push({
      type: 'evidence',
      sessionResumptionHandle: sessionUpdate.newHandle,
    });
  }
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

function foldServerContent(message: Record<string, unknown>, events: TurnEvent[]): void {
  const serverContent = message.serverContent as
    | {
        modelTurn?: { parts?: ModelTurnPart[] };
        inputTranscription?: { text?: string };
        interrupted?: boolean;
      }
    | undefined;
  if (!serverContent) return;

  if (serverContent.interrupted) {
    events.push({
      type: 'done',
      interrupted: true,
      stop: { kind: 'interrupted' as const },
    });
  }

  if (serverContent.inputTranscription?.text) {
    events.push({
      type: 'evidence',
      text: serverContent.inputTranscription.text,
      evidence: {
        provider: 'google',
        kind: 'input_transcription',
      },
    });
  }

  for (const part of serverContent.modelTurn?.parts ?? []) {
    foldModelPart(part, events);
  }
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
  foldSessionUpdate(message, events);
  foldToolCalls(message, events);
  foldServerContent(message, events);
  foldUsageMetadata(message, events);
  return events;
}
