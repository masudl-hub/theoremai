import { TheoremError, toErrorEvent } from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import type { ModelEvent, ModelRequest, TurnEventOf, TurnResponse } from '../../../kernel/types.ts';
import { pcmMediaAsWav } from '../../shared/pcm.ts';
import { foldResponse } from '../../shared/response-identity.ts';
import { structuredEvent } from '../../shared/structured-output.ts';
import { toolCallEvents } from '../../shared/tool-args.ts';
import { toolDraftEvents } from '../../shared/tool-draft.ts';
import { readGeminiApiError } from '../api-error.ts';
import { groundingFromDelta } from '../grounding.ts';
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

/*probed 2026-09-23:
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
 * a partial `function_call` never becomes a tool call. While a streamed
 * `function_call` is open, each `arguments_delta` also goes out as a
 * `tool_draft`, a preview only: the call at `step.stop` owns the arguments.
 */

export interface StreamFold {
  text: string;
  /** Open `function_call`, `code_execution_*` and builtin steps by `index`. */
  steps: Map<number, Record<string, unknown>>;
  sawMedia: boolean;
  /** A `done` came out: the interaction reported a status. */
  sawDone: boolean;
  /** Identity named so far: `interaction.created` names it before any output, so a cut call still has it. */
  response?: TurnResponse;
  /** The signature of the last thought, until the `function_call` that follows it takes it. */
  thoughtSignature?: string;
  /** Function calls read so far: a signature names its call by this position. */
  calls: number;
}

export function newStreamFold(): StreamFold {
  return { text: '', steps: new Map(), sawMedia: false, sawDone: false, calls: 0 };
}

function isMergedStepType(type: string): boolean {
  return type === 'function_call' || isCodeExecutionType(type) || isGoogleBuiltinStepType(type);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Hold a thought's signature for the call that follows it. The model thinks
 * once before a step's calls, so the signature arrives on a `thought` step:
 * whole when buffered, as a `thought_signature` delta when streamed (probe
 * 25/09/2026, gemini-3.1-flash-lite). Calls carried an empty `signature`.
 */
function holdThoughtSignature(signature: unknown, fold: StreamFold): void {
  const held = nonEmptyString(signature);
  if (held) fold.thoughtSignature = held;
}

/**
 * The signature a `function_call` replays with: its own when it carries a
 * non-empty one, else the held thought's. The first call takes the held one;
 * its siblings share that thought and carry none.
 */
function takeThoughtSignature(step: Record<string, unknown>, fold: StreamFold): string | undefined {
  const signature = nonEmptyString(step.signature) ?? fold.thoughtSignature;
  fold.thoughtSignature = undefined;
  return signature;
}

export function eventsFromStep(step: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  const type = String(step.type ?? '');
  if (type === 'function_call') {
    const id = typeof step.id === 'string' ? step.id : undefined;
    const name = typeof step.name === 'string' ? step.name : '';
    const signature = takeThoughtSignature(step, fold);
    const call = fold.calls++;
    return [
      ...(signature
        ? [
            {
              type: 'reasoning' as const,
              data: { call, signature },
              origin: { protocol: 'geminiInteractions' },
            },
          ]
        : []),
      ...toolCallEvents({ id, name }, step.arguments),
    ];
  }
  if (isCodeExecutionType(type)) {
    return [codeExecutionEvidence(step)];
  }
  if (isGoogleBuiltinStepType(type)) {
    return [rawStepEvidence(step)];
  }
  if (type === 'thought') {
    holdThoughtSignature(step.signature, fold);
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
  if (!step) return;
  const type = String(step.type ?? '');
  if (type === 'thought') {
    holdThoughtSignature(step.signature, fold);
  }
  if (isMergedStepType(type)) {
    fold.steps.set(stepIndex(payload), { ...step });
  }
}

function foldStepDelta(payload: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  const delta = asRecord(payload.delta);
  if (!delta) {
    return [];
  }
  const open = fold.steps.get(stepIndex(payload));
  if (!open) {
    if (delta.type === 'thought_signature') {
      holdThoughtSignature(delta.signature, fold);
    }
    return eventsFromDelta(delta);
  }
  if (delta.type === 'arguments_delta') {
    // why: Replaces the `arguments: {}` placeholder from `step.start` with the streamed JSON string.
    const sofar = typeof open.arguments === 'string' ? open.arguments : '';
    const args = sofar + (typeof delta.arguments === 'string' ? delta.arguments : '');
    open.arguments = args;
    if (open.type !== 'function_call') return [];
    // why: The call at `step.stop` goes out under the `id` and `name` that `step.start` gave.
    return toolDraftEvents({
      id: nonEmptyString(open.id),
      name: typeof open.name === 'string' ? open.name : '',
      args,
      drafted: sofar.length,
    });
  }
  Object.assign(open, delta);
  return [];
}

function foldStepStop(payload: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  const index = stepIndex(payload);
  const step = fold.steps.get(index);
  if (!step) {
    return [];
  }
  fold.steps.delete(index);
  return eventsFromStep(step, fold);
}

function partialStepEvidence(step: Record<string, unknown>): TurnEventOf<'evidence'> {
  const event = isCodeExecutionType(String(step.type ?? ''))
    ? codeExecutionEvidence(step)
    : rawStepEvidence(step);
  return { ...event, evidence: { ...event.evidence, partial: true } };
}

export function openStepEvents(fold: StreamFold): ModelEvent[] {
  const events = [...fold.steps.values()].map(partialStepEvidence);
  fold.steps.clear();
  return events;
}

function delivered(events: ModelEvent[], fold: StreamFold): ModelEvent[] {
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

function eventsFromStreamRow(payload: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  if (payload.eventType === 'sse_unparsed') {
    // why: Every observed Interactions row is a JSON object; anything else is a wire change.
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
  const events = groundingFromDelta(payload);
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

function identityEvents(interaction: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  const identity = foldResponse(fold.response, interactionResponse(interaction));
  fold.response = identity.known;
  return identity.event ? [identity.event] : [];
}

export function foldPayload(payload: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  return delivered(eventsFromStreamRow(payload, fold), fold);
}

export function foldBody(body: Record<string, unknown>, fold: StreamFold): ModelEvent[] {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const fromSteps = steps.flatMap((value) => {
    const step = asRecord(value);
    return step ? eventsFromStep(step, fold) : [];
  });
  return delivered(
    [...identityEvents(body, fold), ...fromSteps, ...eventsFromInteractionEnd(body)],
    fold,
  );
}

export function* finalizeStructured(req: ModelRequest, fold: StreamFold): Generator<ModelEvent> {
  if (!req.structured || !fold.text) {
    return;
  }
  yield structuredEvent(fold.text);
}

function isVoiceProfile(req: ModelRequest): boolean {
  return Boolean(req.speech?.voice);
}

/** What the profile asked for and the model did not return; even an empty turn fails. */
export function missingMediaError(req: ModelRequest, fold: StreamFold): ModelEvent | undefined {
  if (fold.sawMedia) return undefined;
  if (isVoiceProfile(req)) {
    return toErrorEvent(
      new TheoremError('bad_response', 'speech audio was not returned by the model'),
    );
  }
  if (req.image) {
    return toErrorEvent(
      new TheoremError('bad_response', 'no image returned from image generation'),
    );
  }
  return undefined;
}
