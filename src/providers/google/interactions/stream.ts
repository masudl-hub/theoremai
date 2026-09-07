/**
 * Google Interactions provider adapter.
 *
 * This adapter converts THEORUM's provider-neutral request into the Google
 * Interactions wire format and streams normalized `TurnEvent` objects.
 * Speech-role turns use `response_format: audio` + `speech_config` (same
 * transport as chat/image).
 *
 * @module
 */

import { isAbortError, TheorumError, toErrorEvent } from '../../../guardrails/error.ts';
import {
  codeExecutionEvidence,
  codeExecutionStepKey,
  eventsFromComplete,
  eventsFromDelta,
  extractTokenEvent,
  googleBuiltinEvidence,
  groundingFromEvent,
  isCodeExecutionType,
  isGoogleBuiltinStepType,
  mergeCodeExecutionPayload,
  parseStructuredOutput,
} from '../../../kernel/engine/delta.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import type { ModelProvider, ProviderCompleteRequest, TurnEvent } from '../../../kernel/types.ts';
import { base64ToBytes, bytesToBase64, wrapPcmAsWav } from '../../shared/pcm.ts';
import { readSseChunks } from '../../shared/sse.ts';
import { type ParsedToolArguments, parseToolArgumentsObject } from '../../shared/tool-args.ts';
import { tapFetch } from '../../shared/upstream-tap.ts';
import { fetchGemini, type GeminiTransport } from '../keys.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL } from '../urls.ts';
import { toInteractionsBody } from './framing.ts';

const HTTP_OK = 200;

export interface PendingFunctionCall {
  id?: string;
  name?: string;
  arguments: string;
}

export interface StreamFold {
  text: string;
  functionCalls: Map<number, PendingFunctionCall>;
  emittedToolKeys: Set<string>;
  emittedEvidenceKeys: Set<string>;
  codeSteps: Map<number, Record<string, unknown>>;
  sawStreamedMedia: boolean;
}

export function isRawPcmMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return (
    lower.startsWith('audio/pcm') || lower.startsWith('audio/raw') || lower.startsWith('audio/l16')
  );
}

export function normalizeSpeechMedia(event: TurnEvent, speech: boolean): TurnEvent {
  if (!speech || event.type !== 'media' || !event.media) {
    return event;
  }
  const { media } = event;
  if (!isRawPcmMime(media.mimeType)) {
    return event;
  }
  const pcm = base64ToBytes(media.data);
  const wav = wrapPcmAsWav(pcm, 24000);
  return {
    type: 'media',
    media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
  };
}

export function newStreamFold(): StreamFold {
  return {
    text: '',
    functionCalls: new Map(),
    emittedToolKeys: new Set(),
    emittedEvidenceKeys: new Set(),
    codeSteps: new Map(),
    sawStreamedMedia: false,
  };
}

export function eventType(payload: Record<string, unknown>): string {
  return String(payload.event_type ?? payload.type ?? '');
}

export function isDeltaEvent(type: string): boolean {
  return type === 'content.delta' || type === 'step.delta';
}

export function isCompleteEvent(type: string): boolean {
  return type === 'interaction.complete' || type === 'interaction.completed';
}

export function* yieldGrounding(event: Record<string, unknown>): Generator<TurnEvent> {
  const g = groundingFromEvent(event);
  if (g) {
    yield g;
  }
}

export function* yieldTokens(event: Record<string, unknown>): Generator<TurnEvent> {
  const tokens = extractTokenEvent(event);
  if (tokens) {
    yield tokens;
  }
}

export function functionCallKey(tool: {
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}): string {
  return `${tool.name ?? ''}:${tool.id ?? ''}:${JSON.stringify(tool.arguments ?? {})}`;
}

export function* yieldEvidenceStep(
  step: Record<string, unknown>,
  emittedKeys: Set<string>,
): Generator<TurnEvent> {
  const event = googleBuiltinEvidence(step);
  const ev = event.evidence;
  if (!ev) return;
  const kind = String(ev.kind ?? ev.raw?.type ?? '');
  const id =
    (typeof ev.callId === 'string' && ev.callId) ||
    (typeof ev.id === 'string' && ev.id) ||
    (typeof ev.raw?.call_id === 'string' && ev.raw.call_id) ||
    (typeof ev.raw?.id === 'string' && ev.raw.id) ||
    '';
  const hasResult = ev.raw?.result !== undefined;
  // Stub maps/search starts often arrive before `result`; allow a second emit once result lands.
  const key = `${kind}:${id}:${hasResult ? 'result' : 'stub'}:${ev.code ?? ''}`;
  if (emittedKeys.has(key)) return;
  // Prefer the result-bearing emit: drop the stub key so hosts don't keep an empty payload.
  if (hasResult) {
    emittedKeys.delete(`${kind}:${id}:stub:`);
  }
  emittedKeys.add(key);
  yield event;
}

function recordCodeStep(
  index: number,
  delta: Record<string, unknown>,
  steps: Map<number, Record<string, unknown>>,
): void {
  const existing = steps.get(index);
  if (!existing) {
    steps.set(index, delta);
    return;
  }
  mergeCodeExecutionPayload(existing, delta);
}

export function isCompleteCodeStep(step: Record<string, unknown>): boolean {
  return step.arguments !== undefined || step.result !== undefined;
}

function* flushCompletedCodeSteps(
  steps: Map<number, Record<string, unknown>>,
  emittedKeys: Set<string>,
): Generator<TurnEvent> {
  for (const [index, step] of steps) {
    if (!isCompleteCodeStep(step)) {
      continue;
    }
    const key = codeExecutionStepKey(step);
    if (!key || emittedKeys.has(key)) {
      continue;
    }
    const event = codeExecutionEvidence(step);
    if (event) {
      emittedKeys.add(key);
      steps.delete(index);
      yield event;
    }
  }
}

export function foldStepStart(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const step = asRecord(payload.step);
  if (!step) return [];
  const type = String(step.type ?? '');
  const index = typeof payload.index === 'number' ? payload.index : 0;
  if (type === 'function_call') {
    // Always buffer until step.stop. Gemini often sends arguments: {} on start, then
    // streams the real JSON via arguments_delta — early emit would run with empty args
    // and leave a nameless pending for the deltas.
    const existing = fold.functionCalls.get(index);
    let argumentsStr = existing?.arguments ?? '';
    if (typeof step.arguments === 'string') {
      argumentsStr = step.arguments;
    } else if (step.arguments !== undefined && typeof step.arguments === 'object') {
      argumentsStr = JSON.stringify(step.arguments);
    }
    fold.functionCalls.set(index, {
      id: typeof step.id === 'string' ? step.id : existing?.id,
      name: typeof step.name === 'string' ? step.name : existing?.name,
      arguments: argumentsStr,
    });
    return [];
  }
  if (isCodeExecutionType(type)) {
    recordCodeStep(index, step, fold.codeSteps);
    return Array.from(flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys));
  }
  if (isGoogleBuiltinStepType(type)) {
    return Array.from(yieldEvidenceStep(step, fold.emittedEvidenceKeys));
  }
  return [];
}

export type { ParsedToolArguments };

export function parseArgumentsObject(raw: unknown): ParsedToolArguments {
  return parseToolArgumentsObject(raw);
}

export function emitUniqueToolEvent(
  tool: {
    id?: string;
    name: string;
    arguments: Record<string, unknown>;
    phase?: 'error';
    failure?: { code: string; message: string; details?: unknown };
  },
  fold: StreamFold,
): TurnEvent[] {
  const key = functionCallKey(tool);
  if (fold.emittedToolKeys.has(key)) return [];
  fold.emittedToolKeys.add(key);
  return [{ type: 'tool', tool }];
}

/** Emit a tool call, or a structured tool failure when arguments cannot be parsed. */
export function emitToolCallFromRawArguments(
  tool: { id?: string; name: string },
  rawArguments: unknown,
  fold: StreamFold,
): TurnEvent[] {
  const name = tool.name.trim();
  if (!name) {
    return emitUniqueToolEvent(
      {
        id: tool.id,
        name: '',
        arguments: {},
        phase: 'error',
        failure: {
          code: 'malformed_arguments',
          message: 'function call is missing a name',
          details: { rawArguments },
        },
      },
      fold,
    );
  }
  const parsed = parseArgumentsObject(rawArguments);
  if (!parsed.ok) {
    return emitUniqueToolEvent(
      {
        id: tool.id,
        name,
        arguments: {},
        phase: 'error',
        failure: {
          code: 'malformed_arguments',
          message: parsed.error,
          details: { raw: parsed.raw },
        },
      },
      fold,
    );
  }
  return emitUniqueToolEvent({ id: tool.id, name, arguments: parsed.value }, fold);
}

export function foldArgumentsDelta(
  delta: Record<string, unknown>,
  index: number,
  fold: StreamFold,
): void {
  const existing = fold.functionCalls.get(index) ?? { arguments: '' };
  const chunk = typeof delta.arguments === 'string' ? delta.arguments : '';
  if (!chunk) {
    fold.functionCalls.set(index, existing);
    return;
  }
  // Replace empty / `{}` placeholder from step.start so streamed JSON is not concatenated onto it.
  if (existing.arguments === '' || existing.arguments === '{}') {
    existing.arguments = chunk;
  } else {
    existing.arguments += chunk;
  }
  fold.functionCalls.set(index, existing);
}

export function foldFunctionCallDelta(
  delta: Record<string, unknown>,
  fold: StreamFold,
): TurnEvent[] {
  const id = typeof delta.id === 'string' ? delta.id : undefined;
  const name = typeof delta.name === 'string' ? delta.name : '';
  return emitToolCallFromRawArguments({ id, name }, delta.arguments, fold);
}

export function foldDeltaPayload(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const delta = asRecord(payload.delta);
  if (!delta) {
    return [];
  }
  const stepType = String(delta.type ?? '');
  const index = typeof payload.index === 'number' ? payload.index : 0;
  if (stepType === 'arguments_delta' || stepType === 'arguments') {
    foldArgumentsDelta(delta, index, fold);
    return [];
  }
  if (stepType === 'function_call') {
    return foldFunctionCallDelta(delta, fold);
  }
  if (isCodeExecutionType(stepType)) {
    recordCodeStep(index, delta, fold.codeSteps);
    return Array.from(flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys));
  }
  if (isGoogleBuiltinStepType(stepType)) {
    return Array.from(yieldEvidenceStep(delta, fold.emittedEvidenceKeys));
  }
  const events: TurnEvent[] = [];
  for (const ev of eventsFromDelta(delta)) {
    if (ev.type === 'text' && ev.text) {
      fold.text += ev.text;
    }
    events.push(ev);
  }
  return events;
}

export function readData(part: Record<string, unknown>): string | undefined {
  const data = part.data;
  if (typeof data === 'string' && data.length > 0) return data;
  return undefined;
}

export function readMime(part: Record<string, unknown>): string | undefined {
  const mime = part.mime_type ?? part.mimeType;
  if (typeof mime === 'string' && mime.length > 0) return mime;
  return undefined;
}

export function* yieldMediaChunk(part: Record<string, unknown>): Generator<TurnEvent> {
  const data = readData(part);
  if (!data) return;
  const mime = readMime(part) ?? 'application/octet-stream';
  if (isRawPcmMime(mime)) {
    const wav = wrapPcmAsWav(base64ToBytes(data), 24000);
    yield {
      type: 'media',
      media: { mimeType: 'audio/wav', data: bytesToBase64(wav) },
    };
    return;
  }
  yield { type: 'media', media: { mimeType: mime, data } };
}

export function* scanMediaParts(content: unknown): Generator<TurnEvent> {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'image' || type === 'audio' || type === 'media' || type === 'video') {
      yield* yieldMediaChunk(part);
    }
  }
}

export function emitPendingFunctionCall(index: number, fold: StreamFold): TurnEvent[] {
  const pending = fold.functionCalls.get(index);
  if (!pending) return [];
  fold.functionCalls.delete(index);
  return emitToolCallFromRawArguments(
    { id: pending.id, name: pending.name ?? '' },
    pending.arguments || {},
    fold,
  );
}

export function foldStepStop(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const index = typeof payload.index === 'number' ? payload.index : 0;
  const fromFunctionCall = emitPendingFunctionCall(index, fold);
  if (fromFunctionCall.length > 0) {
    return fromFunctionCall;
  }
  const step = asRecord(payload.step);
  if (!step) return [];
  const stepType = String(step.type ?? '');
  if (isGoogleBuiltinStepType(stepType)) {
    return Array.from(yieldEvidenceStep(step, fold.emittedEvidenceKeys));
  }
  if (isCodeExecutionType(stepType)) {
    return [codeExecutionEvidence(step)];
  }
  return [];
}

export function foldInteractionSteps(
  interaction: Record<string, unknown>,
  fold: StreamFold,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  const steps = interaction.steps;
  if (!Array.isArray(steps)) return events;

  for (const s of steps) {
    const step = asRecord(s);
    if (!step) continue;
    const stepType = String(step.type ?? '');
    if (stepType === 'function_call') {
      const id = typeof step.id === 'string' ? step.id : undefined;
      const name = typeof step.name === 'string' ? step.name : '';
      events.push(...emitToolCallFromRawArguments({ id, name }, step.arguments, fold));
    }
  }
  return events;
}

export function foldCompleteEvents(
  payload: Record<string, unknown>,
  fold: StreamFold,
): TurnEvent[] {
  const events: TurnEvent[] = [];
  const fromComp = eventsFromComplete(payload, fold.text.length > 0);
  for (const ev of fromComp) {
    if (ev.type === 'evidence' && ev.evidence?.raw) {
      const key = codeExecutionStepKey(ev.evidence.raw);
      if (fold.emittedEvidenceKeys.has(key)) continue;
      fold.emittedEvidenceKeys.add(key);
    }
    if (ev.type === 'media') {
      fold.sawStreamedMedia = true;
    }
    events.push(ev);
  }
  return events;
}

export function foldPayload(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const apiError = readApiErrorMessage(payload);
  if (apiError) {
    return [toErrorEvent(new TheorumError(apiError))];
  }
  const events: TurnEvent[] = [];
  for (const ev of yieldGrounding(payload)) events.push(ev);

  const type = eventType(payload);
  if (!isCompleteEvent(type)) {
    for (const ev of yieldTokens(payload)) events.push(ev);
  }

  if (type === 'step.start') {
    events.push(...foldStepStart(payload, fold));
    return events;
  }
  if (type === 'step.stop') {
    events.push(...foldStepStop(payload, fold));
    return events;
  }
  if (isDeltaEvent(type)) {
    events.push(...foldDeltaPayload(payload, fold));
    return events;
  }
  if (type === 'interaction.status_update' || isCompleteEvent(type)) {
    const interaction = asRecord(payload.interaction) ?? payload;
    events.push(...foldInteractionSteps(interaction, fold));
    if (isCompleteEvent(type)) {
      events.push(...foldCompleteEvents(payload, fold));
    }
    return events;
  }
  return events;
}

export function* finalizeStructured(
  req: ProviderCompleteRequest,
  fold: StreamFold,
): Generator<TurnEvent> {
  if (!req.structured || !fold.text) {
    return;
  }
  const parsed = parseStructuredOutput(fold.text);
  if (!parsed.ok) {
    yield toErrorEvent(new TheorumError(parsed.error));
    return;
  }
  yield { type: 'structured', structured: parsed.structured };
}

export function* scanInteractionsMedia(json: Record<string, unknown>): Generator<TurnEvent> {
  const steps = json.steps;
  if (!Array.isArray(steps)) {
    return;
  }
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const content = (step as Record<string, unknown>).content;
    yield* scanMediaParts(content);
  }
}

export function isVoiceProfile(req: ProviderCompleteRequest): boolean {
  return Boolean(req.speech?.voice);
}

export function shouldReportMissingSpeechAudio(
  req: ProviderCompleteRequest,
  fold: StreamFold,
): boolean {
  // Any speech-role completion without real audio is a failure — including
  // empty turns (no text and no media). Never invent PCM from text.
  return isVoiceProfile(req) && !fold.sawStreamedMedia;
}

/** Speech-role turns must receive real audio; never invent PCM from text bytes. */
export function* missingSpeechAudioError(): Generator<TurnEvent> {
  yield toErrorEvent(new TheorumError('speech audio was not returned by the model'));
}

async function* parseInteractionsSse(
  response: Response,
  req: ProviderCompleteRequest,
): AsyncGenerator<TurnEvent> {
  if (!response.body) {
    yield toErrorEvent('empty response body');
    return;
  }
  const fold = newStreamFold();
  const speech = Boolean(req.speech);
  let hasError = false;
  for await (const row of readSseChunks(response.body)) {
    req.tapUpstream?.(row);
    if (row.eventType === 'sse_done') {
      break;
    }
    const events = foldPayload(row, fold);
    for (const ev of events) {
      if (ev.type === 'media') {
        fold.sawStreamedMedia = true;
      }
      if (ev.type === 'error') {
        hasError = true;
      }
      yield normalizeSpeechMedia(ev, speech);
    }
    if (hasError) {
      return;
    }
  }
  if (hasError) {
    return;
  }
  yield* flushCompletedCodeSteps(fold.codeSteps, fold.emittedEvidenceKeys);
  yield* finalizeStructured(req, fold);
  if (shouldReportMissingSpeechAudio(req, fold)) {
    yield* missingSpeechAudioError();
  }
}

export function readApiErrorMessage(record: Record<string, unknown>): string | null {
  const error = record.error;
  if (!error) {
    if (
      record.sseEvent === 'error' ||
      record.eventType === 'error' ||
      record.event_type === 'error' ||
      record.type === 'error'
    ) {
      const msg = typeof record.message === 'string' ? record.message : null;
      return msg || 'Gemini returned an error.';
    }
    return null;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (typeof error !== 'object') return null;
  const errorRecord = error as { message?: unknown; status?: unknown; code?: unknown };
  if (typeof errorRecord.message === 'string' && errorRecord.message.length > 0) {
    const status = typeof errorRecord.status === 'string' ? errorRecord.status : null;
    return status ? `${status}: ${errorRecord.message}` : errorRecord.message;
  }
  return 'Gemini returned an error.';
}

export async function readNonOkErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const msg = readApiErrorMessage(parsed as Record<string, unknown>);
        if (msg) return msg;
      }
    } catch {
      // JSON parse failed; return raw body below.
    }
    return `Gemini HTTP ${response.status}: ${text}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

function prepareInteractionsFetch(req: ProviderCompleteRequest): {
  slot: NonNullable<ProviderCompleteRequest['keySlot']>;
  init: RequestInit;
} {
  if (!req.keySlot) {
    throw new TheorumError('Request requires keySlot');
  }
  const body = JSON.stringify(toInteractionsBody(req));
  return {
    slot: req.keySlot,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: req.signal,
    },
  };
}

async function* fetchInteractionsOnce(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const { slot, init } = prepareInteractionsFetch(req);
  const response = await fetchGemini(INTERACTIONS_JSON_URL, init, slot, transport);
  if (response.status !== HTTP_OK) {
    const reason = await readNonOkErrorMessage(response);
    throw new TheorumError(reason);
  }
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const apiError = readApiErrorMessage(parsed);
  if (apiError) {
    throw new TheorumError(apiError);
  }
  req.tapUpstream?.(parsed);
  yield* yieldGrounding(parsed);
  yield* yieldTokens(parsed);
  const fold = newStreamFold();
  for (const ev of scanInteractionsMedia(parsed)) {
    fold.sawStreamedMedia = true;
    yield ev;
  }
  for (const ev of eventsFromComplete(parsed, fold.text.length > 0)) {
    if (ev.type === 'text' && ev.text) fold.text += ev.text;
    yield ev;
  }
  yield* finalizeStructured(req, fold);
  if (shouldReportMissingSpeechAudio(req, fold)) {
    yield* missingSpeechAudioError();
  }
}

export function withTap(req: ProviderCompleteRequest, transport: GeminiTransport): GeminiTransport {
  if (!req.tapUpstream) {
    return transport;
  }
  const fetchFn = tapFetch(req.tapUpstream, transport.fetch ?? fetch);
  return { ...transport, fetch: fetchFn };
}

async function* streamInteractions(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const { slot, init } = prepareInteractionsFetch(req);
  const customTransport = withTap(req, transport);
  const response = await fetchGemini(INTERACTIONS_URL, init, slot, customTransport);
  if (response.status !== HTTP_OK) {
    const reason = await readNonOkErrorMessage(response);
    throw new TheorumError(reason);
  }
  yield* parseInteractionsSse(response, req);
}

/** Create a `ModelProvider` backed by Google Interactions HTTP / SSE. */
export function createInteractionsProvider(transport: GeminiTransport): ModelProvider {
  return {
    async *complete(req: ProviderCompleteRequest): AsyncGenerator<TurnEvent> {
      try {
        if (req.stream === false) {
          yield* fetchInteractionsOnce(req, transport);
        } else {
          yield* streamInteractions(req, transport);
        }
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        yield toErrorEvent(err);
      }
    },
  };
}
