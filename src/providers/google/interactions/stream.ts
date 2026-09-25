/**
 * Google Interactions provider adapter.
 *
 * This adapter converts THEOREM's provider-neutral request into the Google
 * Interactions wire format and streams normalized `TurnEvent` objects.
 * Speech-role turns use `response_format: audio` + `speech_config` (same
 * transport as chat/image).
 *
 * @module
 */

import { isAbortError, TheoremError, toErrorEvent } from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import type {
  ModelProvider,
  ProviderCompleteRequest,
  TurnEvent,
  TurnResponse,
} from '../../../kernel/types.ts';
import { pcmMediaAsWav } from '../../shared/pcm.ts';
import { foldResponse } from '../../shared/response-identity.ts';
import { readSseChunks } from '../../shared/sse.ts';
import { structuredEvent } from '../../shared/structured-output.ts';
import { parseToolArgumentsObject } from '../../shared/tool-args.ts';
import { readGeminiApiError, readNonOkError } from '../api-error.ts';
import { groundingFromDelta } from '../grounding.ts';
import { fetchGemini, type GeminiTransport } from '../keys.ts';
import { INTERACTIONS_JSON_URL, INTERACTIONS_URL } from '../urls.ts';
import { toInteractionsBody } from './framing.ts';
import {
  codeExecutionEvidence,
  eventsFromDelta,
  eventsFromInteractionEnd,
  eventsFromModelOutputStep,
  eventsFromThoughtStep,
  interactionResponse,
  isCodeExecutionType,
  isGoogleBuiltinStepType,
  rawStepEvidence,
} from './steps.ts';

const HTTP_OK = 200;

/*
 * One step, two deliveries (probes 23/09/2026, gemini-3.8-flash and
 * gemini-3.1-pro-preview):
 *
 * - Buffered (`stream: false`): the body's `steps[]` hold every step whole.
 * - Stream: `step.start` (index, step with `id` / `call_id` / `name` and an
 *   empty `signature`), then `step.delta` rows, then `step.stop` (index only).
 *   Text, thought summaries and media stream as their own deltas. A
 *   `function_call` starts with `arguments: {}` and streams the JSON string in
 *   `arguments_delta` rows; `code_execution_*` and builtin steps send their
 *   `arguments` / `result` / `is_error` / `signature` whole, in one delta.
 *
 * Streamed steps are merged per index and converted at `step.stop` by the same
 * `eventsFromStep` the buffered body uses, so both modes emit each step once
 * and whole. A step still open when the stream ends was never finished by the
 * provider: it is emitted as `evidence` marked `partial` with what arrived, and
 * a partial `function_call` never becomes a tool call.
 */

export interface StreamFold {
  /** Model text so far, for structured output. */
  text: string;
  /** Open `function_call`, `code_execution_*` and builtin steps by `index`. */
  steps: Map<number, Record<string, unknown>>;
  sawMedia: boolean;
  /** A `done` came out: the interaction reported a status. */
  sawDone: boolean;
  /** Identity named so far: `interaction.created` names it before any output, so a cut call still has it. */
  response?: TurnResponse;
}

export function newStreamFold(): StreamFold {
  return { text: '', steps: new Map(), sawMedia: false, sawDone: false };
}

function isMergedStepType(type: string): boolean {
  return type === 'function_call' || isCodeExecutionType(type) || isGoogleBuiltinStepType(type);
}

/** Emit a tool call, or a structured tool failure when the name or arguments are unusable. */
export function emitToolCallFromRawArguments(
  tool: { id?: string; name: string },
  rawArguments: unknown,
): TurnEvent[] {
  const name = tool.name.trim();
  if (!name) {
    return [
      {
        type: 'tool',
        tool: {
          id: tool.id,
          name: '',
          arguments: {},
          phase: 'error',
          failure: {
            code: 'malformed_arguments',
            kind: 'bad_response',
            message: 'function call is missing a name',
            details: { raw: rawArguments },
          },
        },
      },
    ];
  }
  const parsed = parseToolArgumentsObject(rawArguments);
  if (!parsed.ok) {
    return [
      {
        type: 'tool',
        tool: {
          id: tool.id,
          name,
          arguments: {},
          phase: 'error',
          failure: {
            code: 'malformed_arguments',
            kind: 'bad_response',
            message: parsed.error,
            details: { raw: parsed.raw },
          },
        },
      },
    ];
  }
  return [{ type: 'tool', tool: { id: tool.id, name, arguments: parsed.value } }];
}

/** One whole step — a buffered `steps[]` entry, or a streamed step merged up to `step.stop`. */
export function eventsFromStep(step: Record<string, unknown>): TurnEvent[] {
  const type = String(step.type ?? '');
  if (type === 'function_call') {
    const id = typeof step.id === 'string' ? step.id : undefined;
    const name = typeof step.name === 'string' ? step.name : '';
    return emitToolCallFromRawArguments({ id, name }, step.arguments);
  }
  if (isCodeExecutionType(type)) {
    return [codeExecutionEvidence(step)];
  }
  if (isGoogleBuiltinStepType(type)) {
    return [rawStepEvidence(step)];
  }
  if (type === 'thought') {
    return eventsFromThoughtStep(step);
  }
  if (type === 'model_output') {
    return eventsFromModelOutputStep(step);
  }
  return [];
}

function stepIndex(payload: Record<string, unknown>): number {
  return typeof payload.index === 'number' ? payload.index : 0;
}

function foldStepStart(payload: Record<string, unknown>, fold: StreamFold): void {
  const step = asRecord(payload.step);
  if (step && isMergedStepType(String(step.type ?? ''))) {
    fold.steps.set(stepIndex(payload), { ...step });
  }
}

function foldStepDelta(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const delta = asRecord(payload.delta);
  if (!delta) {
    return [];
  }
  const open = fold.steps.get(stepIndex(payload));
  if (!open) {
    return eventsFromDelta(delta);
  }
  if (delta.type === 'arguments_delta') {
    // Replaces the `arguments: {}` placeholder from `step.start` with the streamed JSON string.
    const sofar = typeof open.arguments === 'string' ? open.arguments : '';
    open.arguments = sofar + (typeof delta.arguments === 'string' ? delta.arguments : '');
    return [];
  }
  Object.assign(open, delta);
  return [];
}

function foldStepStop(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const index = stepIndex(payload);
  const step = fold.steps.get(index);
  if (!step) {
    return [];
  }
  fold.steps.delete(index);
  return eventsFromStep(step);
}

/** A step the stream opened and never stopped, as `partial` evidence. */
function partialStepEvidence(step: Record<string, unknown>): TurnEvent {
  const event = isCodeExecutionType(String(step.type ?? ''))
    ? codeExecutionEvidence(step)
    : rawStepEvidence(step);
  return event.evidence ? { ...event, evidence: { ...event.evidence, partial: true } } : event;
}

/** Every step still open, as `partial` evidence; the fold holds none afterwards. */
export function openStepEvents(fold: StreamFold): TurnEvent[] {
  const events = [...fold.steps.values()].map(partialStepEvidence);
  fold.steps.clear();
  return events;
}

/**
 * Record what the caller receives: text for structured output, and media —
 * raw PCM wrapped as WAV at the format its mime states.
 */
function delivered(events: TurnEvent[], fold: StreamFold): TurnEvent[] {
  return events.map((ev) => {
    if (ev.type === 'done') {
      fold.sawDone = true;
    }
    if (ev.type === 'text' && ev.text) {
      fold.text += ev.text;
    }
    if (ev.type !== 'media' || !ev.media) {
      return ev;
    }
    fold.sawMedia = true;
    return { ...ev, media: pcmMediaAsWav(ev.media) };
  });
}

function eventsFromStreamRow(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  if (payload.eventType === 'sse_unparsed') {
    // Every observed Interactions row is a JSON object; anything else is a wire change.
    return [
      toErrorEvent(
        new TheoremError('bad_response', 'Interactions stream row was not a JSON object'),
      ),
    ];
  }
  const apiError = readGeminiApiError(payload);
  if (apiError) {
    return [toErrorEvent(apiError)];
  }
  const grounding = groundingFromDelta(payload);
  const events: TurnEvent[] = grounding ? [grounding] : [];
  switch (payload.event_type) {
    case 'step.start':
      foldStepStart(payload, fold);
      break;
    case 'step.delta':
      events.push(...foldStepDelta(payload, fold));
      break;
    case 'step.stop':
      events.push(...foldStepStop(payload, fold));
      break;
    case 'interaction.created': {
      const interaction = asRecord(payload.interaction);
      if (interaction) events.push(...identityEvents(interaction, fold));
      break;
    }
    case 'interaction.completed': {
      const interaction = asRecord(payload.interaction);
      if (interaction) {
        events.push(...identityEvents(interaction, fold), ...eventsFromInteractionEnd(interaction));
      }
      break;
    }
  }
  return events;
}

/** The `response` event when this interaction names more of its identity than the fold knew. */
function identityEvents(interaction: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const identity = foldResponse(fold.response, interactionResponse(interaction));
  fold.response = identity.known;
  return identity.event ? [identity.event] : [];
}

/** Fold one SSE row into the events it completes. */
export function foldPayload(payload: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  return delivered(eventsFromStreamRow(payload, fold), fold);
}

/** Every event of a buffered (`stream: false`) interaction body. */
export function foldBody(body: Record<string, unknown>, fold: StreamFold): TurnEvent[] {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const fromSteps = steps.flatMap((value) => {
    const step = asRecord(value);
    return step ? eventsFromStep(step) : [];
  });
  return delivered(
    [...identityEvents(body, fold), ...fromSteps, ...eventsFromInteractionEnd(body)],
    fold,
  );
}

export function* finalizeStructured(
  req: ProviderCompleteRequest,
  fold: StreamFold,
): Generator<TurnEvent> {
  if (!req.structured || !fold.text) {
    return;
  }
  yield structuredEvent(fold.text);
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
  return isVoiceProfile(req) && !fold.sawMedia;
}

/** Speech-role turns must receive real audio; never invent PCM from text bytes. */
export function* missingSpeechAudioError(): Generator<TurnEvent> {
  yield toErrorEvent(
    new TheoremError('bad_response', 'speech audio was not returned by the model'),
  );
}

async function* parseInteractionsSse(
  response: Response,
  req: ProviderCompleteRequest,
): AsyncGenerator<TurnEvent> {
  if (!response.body) {
    yield toErrorEvent(new TheoremError('bad_response', 'empty response body'));
    return;
  }
  const fold = newStreamFold();
  for await (const row of readSseChunks(response.body)) {
    req.tapUpstream?.(row);
    if (row.eventType === 'sse_done') {
      break;
    }
    const events = foldPayload(row, fold);
    yield* events;
    if (events.some((ev) => ev.type === 'error')) {
      yield* openStepEvents(fold);
      return;
    }
  }
  yield* openStepEvents(fold);
  yield* finalizeStructured(req, fold);
  if (shouldReportMissingSpeechAudio(req, fold)) {
    yield* missingSpeechAudioError();
  }
  if (!fold.sawDone) {
    // The stream ended before the interaction reported a status: it did not complete.
    yield { type: 'done', stop: { kind: 'stream_incomplete' } };
  }
}

/** POST the request to `url`; a non-2xx status throws with the provider's message. */
async function postInteractions(
  url: string,
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): Promise<Response> {
  if (!req.keySlot) {
    throw new TheoremError('config', 'Request requires keySlot');
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toInteractionsBody(req)),
    signal: req.signal,
  };
  const response = await fetchGemini(url, init, req.keySlot, transport, req.tapUpstream);
  if (response.status !== HTTP_OK) {
    throw await readNonOkError(response);
  }
  return response;
}

async function* fetchInteractionsOnce(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const response = await postInteractions(INTERACTIONS_JSON_URL, req, transport);
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const apiError = readGeminiApiError(parsed);
  if (apiError) {
    throw apiError;
  }
  req.tapUpstream?.(parsed);
  const fold = newStreamFold();
  yield* foldBody(parsed, fold);
  yield* finalizeStructured(req, fold);
  if (shouldReportMissingSpeechAudio(req, fold)) {
    yield* missingSpeechAudioError();
  }
}

async function* streamInteractions(
  req: ProviderCompleteRequest,
  transport: GeminiTransport,
): AsyncGenerator<TurnEvent> {
  const response = await postInteractions(INTERACTIONS_URL, req, transport);
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
