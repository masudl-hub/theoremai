/**
 * Pure protocol framing & serialization for Google Gemini Live WebSocket API (`BidiGenerateContent`).
 *
 * All functions are pure data transformations with no network I/O.
 *
 * @module
 */

import { TheoremError, toErrorEvent } from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import { reportedTokens, usageCount } from '../../../kernel/engine/usage.ts';
import { historyMessageParts, isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import { mediaKindForMime } from '../../../kernel/registry/catalog.ts';
import { requireBuiltinWire } from '../../../kernel/tools/registry.ts';
import type {
  InteractionMediaPart,
  InteractionPart,
  LiveContextCompressionSpec,
  LiveVadSpec,
  ProviderCompleteRequest,
  TurnEvent,
  TurnHistoryMessage,
  TurnTokens,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { isRecord } from '../../../kernel/util/record.ts';
import { pcmMediaAsWav } from '../../shared/pcm.ts';
import {
  historyToolArguments,
  historyToolIdentity,
  parseToolArgumentsObject,
} from '../../shared/tool-args.ts';
import { groundingFromLiveMetadata } from '../grounding.ts';
import { GEMINI_LIVE_WS_URL } from '../urls.ts';
import { byModality, modalityCounts } from '../usage.ts';
import { toGeminiOpenApiSchema } from './openapi-schema.ts';

/** Construct authenticated WebSocket URL for Gemini Live API. */
export function buildGeminiLiveWebSocketUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Live tools are always declared non-blocking: the host runs each call through
 * `LiveSession.executeTool` while the model keeps speaking, and a cancel reaches
 * the host as a `tool` event with `phase: 'cancel'`.
 */
const LIVE_FUNCTION_BEHAVIOR = 'NON_BLOCKING';

export function wireFunctionDeclaration(decl: WireFunctionTool): Record<string, unknown> {
  const parameters = toGeminiOpenApiSchema(decl.parameters);
  return {
    name: decl.name,
    description: decl.description,
    behavior: LIVE_FUNCTION_BEHAVIOR,
    parameters:
      parameters && typeof parameters === 'object'
        ? (parameters as Record<string, unknown>)
        : { type: 'OBJECT', properties: {} },
  };
}

/**
 * Builtins are their own tool entries (`{ googleSearch: {} }`), functions share
 * one `functionDeclarations` entry. Which builtins a model takes is the API's
 * answer (probe 23/09/2026: a model without one closes the socket with 1007).
 */
function wireLiveTools(req: ProviderCompleteRequest): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  for (const id of req.builtins) {
    tools.push({ [requireBuiltinWire(id, 'live')]: {} });
  }
  const functionDeclarations = (req.wireTools ?? []).map(wireFunctionDeclaration);
  if (functionDeclarations.length > 0) {
    tools.push({ functionDeclarations });
  }
  return tools;
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

/** Gemini's `contextWindowCompression` for the profile's; unset numbers stay Gemini's. */
function buildContextWindowCompression(
  compression: LiveContextCompressionSpec,
): Record<string, unknown> {
  const { triggerTokens } = compression;
  const { targetTokens } = compression.slidingWindow;
  return {
    ...(triggerTokens !== undefined ? { triggerTokens } : {}),
    slidingWindow: targetTokens !== undefined ? { targetTokens } : {},
  };
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
    ...(live?.contextCompression
      ? { contextWindowCompression: buildContextWindowCompression(live.contextCompression) }
      : {}),
    ...(seedInitialHistory ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
    ...(realtimeInputConfig ? { realtimeInputConfig } : {}),
  };

  applyLiveOptionalFeatures(live, setup);
  return { setup };
}

/** Live carries inline bytes only — provider file references are rejected until support is verified. */
function inlineMediaPart(part: Exclude<InteractionPart, { type: 'text' }>): InteractionMediaPart {
  if (isMediaRefPart(part)) {
    throw new TheoremError('unsupported', 'media references are not supported on geminiLive');
  }
  return part;
}

function inlineData(part: Exclude<InteractionPart, { type: 'text' }>): Record<string, string> {
  const inline = inlineMediaPart(part);
  return { mimeType: inline.mimeType, data: inline.data };
}

function contentPart(part: InteractionPart): Record<string, unknown> {
  return part.type === 'text' ? { text: part.text } : { inlineData: inlineData(part) };
}

/**
 * A `tool` message as one `functionResponse` part in a `user` turn (probed 23/09/2026).
 * Text parts are the `result`; media rides nested in `functionResponse.parts`.
 */
function functionResponseTurn(msg: TurnHistoryMessage): Record<string, unknown> {
  const parts = historyMessageParts(msg);
  const result = parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  const media = parts.filter((part) => part.type !== 'text').map(contentPart);
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          ...historyToolIdentity({ id: msg.tool_call_id, name: msg.name }),
          response: { result },
          ...(media.length > 0 ? { parts: media } : {}),
        },
      },
    ],
  };
}

/** Format a single history message into a Google turn object. */
function historyTurnToGoogleTurn(msg: TurnHistoryMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return functionResponseTurn(msg);
  }
  const role = msg.role === 'assistant' ? 'model' : 'user';
  const parts = historyMessageParts(msg).map(contentPart);
  for (const call of msg.role === 'assistant' ? (msg.tool_calls ?? []) : []) {
    parts.push({
      functionCall: {
        id: call.id,
        name: call.function.name,
        args: historyToolArguments(call.function.arguments),
      },
    });
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
export function buildGeminiLiveRealtimeInput(input: InteractionPart): Record<string, unknown> {
  if (input.type === 'text') {
    return {
      realtimeInput: {
        text: input.text,
      },
    };
  }
  const part = inlineMediaPart(input);

  // The part's mime as given: the API reads the rate from it and rejects what it cannot take.
  const media = { mimeType: part.mimeType, data: part.data };
  return { realtimeInput: part.type === 'audio' ? { audio: media } : { video: media } };
}

/** Build the Gemini Live `response` struct for a function result: what the model reads. */
export function liveFunctionResponsePayload(output: unknown): Record<string, unknown> {
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

/** A `functionResponse` as the tool message the model reads: its `response`, as sent. */
function functionResponseMessage(response: Record<string, unknown>): TurnHistoryMessage {
  return {
    role: 'tool',
    ...(typeof response.id === 'string' ? { tool_call_id: response.id } : {}),
    ...(typeof response.name === 'string' ? { name: response.name } : {}),
    content: JSON.stringify(response.response ?? null),
  };
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Record<string, unknown>[] => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

/** One `clientContent` turn as kernel messages: its content, then any function responses. */
function clientTurnMessages(turn: Record<string, unknown>): TurnHistoryMessage[] {
  const parts: InteractionPart[] = [];
  const calls: NonNullable<TurnHistoryMessage['tool_calls']> = [];
  const responses: TurnHistoryMessage[] = [];
  for (const part of records(turn.parts)) {
    const inline = asRecord(part.inlineData);
    const call = asRecord(part.functionCall);
    const response = asRecord(part.functionResponse);
    if (typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (inline && typeof inline.mimeType === 'string' && typeof inline.data === 'string') {
      const type = mediaKindForMime(inline.mimeType) ?? 'document';
      parts.push({ type, mimeType: inline.mimeType, data: inline.data });
    } else if (call) {
      calls.push({
        id: typeof call.id === 'string' ? call.id : '',
        type: 'function',
        function: { name: String(call.name ?? ''), arguments: JSON.stringify(call.args ?? {}) },
      });
    } else if (response) {
      responses.push(functionResponseMessage(response));
    }
  }
  const role = turn.role === 'model' ? 'assistant' : 'user';
  const content: TurnHistoryMessage[] =
    parts.length > 0 || calls.length > 0
      ? [{ role, parts, ...(calls.length > 0 ? { tool_calls: calls } : {}) }]
      : [];
  return [...content, ...responses];
}

/**
 * What one outbound frame gives the model to read, as kernel messages in the
 * order sent. Setup and control frames (activity markers, `audioStreamEnd`)
 * give none.
 */
export function liveFrameInput(frame: Record<string, unknown>): TurnHistoryMessage[] {
  const realtime = asRecord(frame.realtimeInput);
  if (realtime) {
    const audio = asRecord(realtime.audio);
    const video = asRecord(realtime.video);
    const media = audio ?? video;
    if (media && typeof media.mimeType === 'string' && typeof media.data === 'string') {
      const type = audio ? 'audio' : 'video';
      return [{ role: 'user', parts: [{ type, mimeType: media.mimeType, data: media.data }] }];
    }
    return typeof realtime.text === 'string'
      ? [{ role: 'user', parts: [{ type: 'text', text: realtime.text }] }]
      : [];
  }
  const client = asRecord(frame.clientContent);
  if (client) {
    return records(client.turns).flatMap(clientTurnMessages);
  }
  const toolResponse = asRecord(frame.toolResponse);
  return toolResponse ? records(toolResponse.functionResponses).map(functionResponseMessage) : [];
}

/** Parse raw WebSocket message text / buffer into a JSON record. */
export type ParsedLiveMessage =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'empty' | 'malformed' };

export function parseGeminiLiveMessage(raw: unknown): ParsedLiveMessage {
  if (isRecord(raw)) {
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

/**
 * Live `usageMetadata` → `TurnTokens`. Live sends one row per model response,
 * at its `turnComplete`, covering that response alone; the prompt count grows
 * because each response re-reads the session.
 *
 * Live probe (gemini-3.1-flash-live-preview, 22/09/2026): `thoughtsTokenCount`
 * sits outside both `responseTokenCount` and `totalTokenCount`, so it is added
 * to output. `toolUsePromptTokenCount` (not seen in that probe) is added to
 * input, as on Interactions.
 */
export function extractLiveUsageTokens(metadata: Record<string, unknown>): TurnTokens | undefined {
  const prompt = usageCount(metadata.promptTokenCount);
  const response = usageCount(metadata.responseTokenCount);
  const thoughts = usageCount(metadata.thoughtsTokenCount) ?? 0;
  const toolUse = usageCount(metadata.toolUsePromptTokenCount) ?? 0;
  return reportedTokens({
    input: prompt ? prompt + toolUse : undefined,
    output: response === undefined ? undefined : response + thoughts,
    thinking: thoughts,
    toolUse,
    cached: usageCount(metadata.cachedContentTokenCount),
    byModality: byModality(
      modalityCounts(metadata.promptTokensDetails, 'tokenCount'),
      modalityCounts(metadata.responseTokensDetails, 'tokenCount'),
    ),
  });
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

/** What one Live connection remembers across server messages. */
export interface LiveFold {
  /** Tool call names by id, for the cancel that names only ids. */
  calls: Map<string, string>;
}

export function newLiveFold(): LiveFold {
  return { calls: new Map() };
}

function foldToolCalls(
  message: Record<string, unknown>,
  fold: LiveFold,
  events: TurnEvent[],
): void {
  const toolCall = message.toolCall as
    | { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
    | undefined;
  if (!toolCall?.functionCalls || !Array.isArray(toolCall.functionCalls)) return;
  for (const call of toolCall.functionCalls) {
    if (!call.name) continue;
    if (call.id) fold.calls.set(call.id, call.name);
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
            kind: 'bad_response',
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

/**
 * `toolCallCancellation: { ids }` (probe 23/09/2026: gemini-3.1-flash-live and
 * gemini-2.5-flash-native-audio on barge-in; gemini-3.8-live never sends it).
 * It names only ids, so each cancel takes its name from the call this
 * connection issued.
 */
function foldToolCancellations(
  message: Record<string, unknown>,
  fold: LiveFold,
  events: TurnEvent[],
): void {
  const cancellation = message.toolCallCancellation as { ids?: unknown } | undefined;
  const ids = cancellation?.ids;
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    const name = typeof id === 'string' ? fold.calls.get(id) : undefined;
    if (!name) {
      // Every observed cancel names a call this connection issued; anything else is a wire change.
      events.push(
        toErrorEvent(
          new TheoremError(
            'bad_response',
            `Live cancelled a tool call it never issued: ${String(id)}`,
          ),
        ),
      );
      continue;
    }
    fold.calls.delete(id);
    events.push({ type: 'tool', tool: { id, name, phase: 'cancel' } });
  }
}

/**
 * `voiceActivity: { type: 'ACTIVITY_START' | 'ACTIVITY_END', audioOffset: '0.360s' }`
 * (probe 23/09/2026: gemini-3.1-flash-live only), as `evidence` with the
 * message as `raw`.
 */
function foldVoiceActivity(message: Record<string, unknown>, events: TurnEvent[]): void {
  const voiceActivity = asRecord(message.voiceActivity);
  if (!voiceActivity) return;
  events.push({
    type: 'evidence',
    evidence: { provider: 'google', kind: 'voice_activity', raw: voiceActivity },
  });
}

/**
 * `goAway.timeLeft` → milliseconds. It is a protobuf Duration, which JSON
 * encodes as seconds with an `s` suffix (`"10s"`, `"1.5s"`).
 */
export function parseGoAwayTimeLeftMs(timeLeft: unknown): number | undefined {
  if (typeof timeLeft !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(timeLeft);
  return match?.[1] ? Math.round(Number(match[1]) * 1000) : undefined;
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
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  codeExecutionResult?: { outcome?: string; output?: string };
}

/**
 * Output audio arrives as `inlineData` with `mimeType: 'audio/pcm;rate=24000'`
 * (probes 23/09/2026, every Live model); it becomes WAV at the stated rate.
 * Thinking models mark reasoning text with `thought: true`.
 */
function foldModelPart(part: ModelTurnPart, events: TurnEvent[]): void {
  if (part.text) {
    events.push({ type: part.thought === true ? 'thought' : 'text', text: part.text });
  }
  const { mimeType, data } = part.inlineData ?? {};
  if (mimeType && data) {
    events.push({ type: 'media', media: pcmMediaAsWav({ mimeType, data }) });
  }
  if (part.codeExecutionResult) {
    events.push(codeExecutionResultEvidence(part.codeExecutionResult));
  }
}

/**
 * `codeExecutionResult: { outcome, output }` (probe 23/09/2026:
 * gemini-2.5-flash-native-audio reports each search / URL fetch this way, e.g.
 * `OUTCOME_OK` / `Browsing the web.`). No `executableCode` part was seen on any
 * Live model.
 */
function codeExecutionResultEvidence(result: { outcome?: string; output?: string }): TurnEvent {
  return {
    type: 'evidence',
    evidence: {
      provider: 'google',
      kind: 'code_execution_result',
      ...(typeof result.output === 'string' ? { result: result.output } : {}),
      ...(typeof result.outcome === 'string' ? { isError: result.outcome !== 'OUTCOME_OK' } : {}),
      raw: result as Record<string, unknown>,
    },
  };
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
  const groundingEvent = groundingFromLiveMetadata(serverContent.groundingMetadata);
  if (groundingEvent) {
    events.push(groundingEvent);
  }
  const urlContext = serverContent.urlContextMetadata;
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

export type LiveInteractionStatus = 'IN_PROGRESS' | 'IDLE';

/**
 * `serverContent.interactionStatus`, sent beside `turnComplete` by models that
 * keep working after a turn (gemini-3.8-live-extended-thinking, probe
 * 23/09/2026: `IN_PROGRESS` on each intermediate `turnComplete` of a tool
 * flow, `IDLE` on the last).
 */
export function readLiveInteractionStatus(
  message: Record<string, unknown>,
): LiveInteractionStatus | undefined {
  const raw = asRecord(message.serverContent)?.interactionStatus;
  if (raw === 'IN_PROGRESS' || raw === 'IDLE') return raw;
  return undefined;
}

function foldInteractionStatus(message: Record<string, unknown>, events: TurnEvent[]): void {
  const status = readLiveInteractionStatus(message);
  if (!status) return;
  events.push({
    type: 'session',
    session: { kind: status === 'IDLE' ? 'idle' : 'working' },
  });
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

  if (serverContent.waitingForInput === true) {
    events.push({
      type: 'session',
      session: { kind: 'waiting_for_input' },
    });
  }

  if (serverContent.generationComplete === true) {
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

  if (serverContent.turnComplete === true) {
    events.push({ type: 'session', session: { kind: 'turn_complete' } });
  }
}

function foldUsageMetadata(message: Record<string, unknown>, events: TurnEvent[]): void {
  const usageMetadata = message.usageMetadata as Record<string, unknown> | undefined;
  if (usageMetadata) {
    const tokens = extractLiveUsageTokens(usageMetadata);
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
  fold: LiveFold,
): TurnEvent[] {
  if (!message || typeof message !== 'object') return [];
  const events: TurnEvent[] = [];
  foldGoAway(message, events);
  foldSessionUpdate(message, events);
  foldToolCalls(message, fold, events);
  foldToolCancellations(message, fold, events);
  foldVoiceActivity(message, events);
  foldServerContent(message, events);
  foldInteractionStatus(message, events);
  foldUsageMetadata(message, events);
  return events;
}
