/**
 * Interactions steps and deltas → `TurnEvent`s: text, thoughts, media,
 * code execution and builtin evidence, usage, and the terminal status.
 *
 * @module
 */

import { asRecord, nonEmptyString } from '../../../kernel/engine/record.ts';
import { reportedTokens, usageCount } from '../../../kernel/engine/usage.ts';
import { turnStopFromInteractionStatus } from '../../../kernel/stop.ts';
import type {
  ProviderEvidenceEvent,
  TurnEvent,
  TurnResponse,
  TurnTokens,
} from '../../../kernel/types.ts';
import { groundingFromSteps } from '../grounding.ts';
import { byModality, groundingCounts, modalityCounts } from '../usage.ts';

/*
 * Interactions steps and deltas read only the shapes recorded from the wire
 * (probes 23/09/2026, gemini-3.8-flash, gemini-3.1-pro-preview, image and TTS
 * models, streamed and buffered):
 *
 * - `text` deltas carry `text`; `thought_summary` deltas carry
 *   `content: { type: 'text', text }`; buffered `thought` steps carry
 *   `summary[]` of the same text blocks.
 * - `image` / `audio` deltas and `model_output` content blocks carry
 *   `mime_type` + `data`. Audio also reports `sample_rate` / `channels`; the
 *   buffered mime already states them (`audio/l16; rate=24000; channels=1`),
 *   the streamed one does not (`audio/l16`), so they are folded into the mime.
 * - `code_execution_call` carries `id` and `arguments: { language, code }`;
 *   `code_execution_result` carries `call_id`, `result` and `is_error`. Each
 *   arrives whole, in one delta (5 577 characters of code in one probe).
 */

function thoughtText(content: unknown): string {
  const block = asRecord(content);
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/** `mime_type` with the reported `sample_rate` / `channels` stated when it lacks them. */
function interactionsMime(rec: Record<string, unknown>): string | undefined {
  const mime = rec.mime_type;
  if (typeof mime !== 'string' || !mime) {
    return undefined;
  }
  const params = mime.toLowerCase();
  const extra: string[] = [];
  if (typeof rec.sample_rate === 'number' && !/;\s*rate=/.test(params)) {
    extra.push(`rate=${String(rec.sample_rate)}`);
  }
  if (typeof rec.channels === 'number' && !/;\s*channels=/.test(params)) {
    extra.push(`channels=${String(rec.channels)}`);
  }
  return extra.length > 0 ? `${mime}; ${extra.join('; ')}` : mime;
}

function interactionsMedia(rec: Record<string, unknown>): TurnEvent[] {
  const mimeType = interactionsMime(rec);
  const { data } = rec;
  if (!mimeType || typeof data !== 'string' || !data) {
    return [];
  }
  return [{ type: 'media', media: { mimeType, data } }];
}

function textEvent(type: 'thought' | 'text', text: string): TurnEvent[] {
  return text ? [{ type, text }] : [];
}

function isCodeExecutionType(type: string): boolean {
  return type === 'code_execution_call' || type === 'code_execution_result';
}

function isGoogleBuiltinStepType(type: string): boolean {
  return type.startsWith('google_') || type === 'url_context_call' || type === 'url_context_result';
}

/** A step as `evidence`: its type as `kind`, the step itself as `raw`. */
function rawStepEvidence(raw: Record<string, unknown>): TurnEvent {
  const type = String(raw.type ?? '');
  return {
    type: 'evidence',
    evidence: {
      provider: 'google',
      raw,
      ...(type ? { kind: type } : {}),
    },
  };
}

/** Normalize a whole Google `code_execution_*` step into an `evidence` event. */
function codeExecutionEvidence(raw: Record<string, unknown>): TurnEvent {
  const evidence: ProviderEvidenceEvent = { provider: 'google', raw, kind: String(raw.type) };
  const args = asRecord(raw.arguments);
  if (typeof args?.code === 'string') {
    evidence.code = args.code;
  }
  if (typeof args?.language === 'string') {
    evidence.language = args.language;
  }
  if (typeof raw.result === 'string') {
    evidence.result = raw.result;
  }
  if (typeof raw.is_error === 'boolean') {
    evidence.isError = raw.is_error;
  }
  const id = nonEmptyString(raw.id);
  if (id) {
    evidence.id = id;
  }
  const callId = nonEmptyString(raw.call_id);
  if (callId) {
    evidence.callId = callId;
  }
  return { type: 'evidence', evidence };
}

/** A streamed `step.delta` payload that is text, a thought summary or media. */
function eventsFromDelta(deltaValue: unknown): TurnEvent[] {
  const delta = asRecord(deltaValue);
  if (!delta) {
    return [];
  }
  switch (delta.type) {
    case 'thought_summary':
      return textEvent('thought', thoughtText(delta.content));
    case 'text':
      return textEvent('text', typeof delta.text === 'string' ? delta.text : '');
    case 'image':
    case 'audio':
      return interactionsMedia(delta);
    default:
      return [];
  }
}

/** A buffered `thought` step: its `summary[]` text blocks. */
function eventsFromThoughtStep(step: Record<string, unknown>): TurnEvent[] {
  const summary = Array.isArray(step.summary) ? step.summary : [];
  return summary.flatMap((block) => textEvent('thought', thoughtText(block)));
}

/** A buffered `model_output` step: its `content[]` text, image and audio blocks. */
function eventsFromModelOutputStep(step: Record<string, unknown>): TurnEvent[] {
  const content = Array.isArray(step.content) ? step.content : [];
  return content.flatMap((block) => {
    const rec = asRecord(block);
    if (rec?.type === 'text') {
      return textEvent('text', typeof rec.text === 'string' ? rec.text : '');
    }
    if (rec?.type === 'image' || rec?.type === 'audio') {
      return interactionsMedia(rec);
    }
    return [];
  });
}
/**
 * Interactions `usage` → `TurnTokens`, from documented fields only
 * (ai.google.dev/api/interactions-api). Google reports thought and tool-use
 * tokens beside input and output; the OpenTelemetry meanings fold them in.
 *
 * Live probes (gemini-3.8-flash, 22/09/2026): `total_tokens` = input + output
 * + thought + tool use on every call, and cached tokens sit inside input. For
 * inputs Google converts first (Markdown, Python, mono `audio/L16`, …) input
 * comes back 0 while `total_tokens` still holds the full sum, so input is
 * derived from it. Per-modality lists and `grounding_tool_count` are read as
 * `google/usage.ts` describes.
 */
function interactionsUsageTokens(raw: unknown): TurnTokens | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const output = usageCount(usage.total_output_tokens);
  const thought = usageCount(usage.total_thought_tokens) ?? 0;
  const toolUse = usageCount(usage.total_tool_use_tokens) ?? 0;
  const total = usageCount(usage.total_tokens);
  const derived = total === undefined ? undefined : total - (output ?? 0) - thought - toolUse;
  const read = usageCount(usage.total_input_tokens) || (derived && derived > 0 ? derived : 0);
  return reportedTokens({
    input: read ? read + toolUse : undefined,
    output: output === undefined ? undefined : output + thought,
    thinking: thought,
    toolUse,
    cached: usageCount(usage.total_cached_tokens),
    byModality: byModality(
      modalityCounts(usage.input_tokens_by_modality, 'tokens'),
      modalityCounts(usage.output_tokens_by_modality, 'tokens'),
    ),
    grounding: groundingCounts(usage.grounding_tool_count),
  });
}

/** The `tokens` event of a finished interaction (`interaction.completed`'s `interaction`, or a buffered body). */
function extractTokenEvent(interaction: Record<string, unknown>): TurnEvent | undefined {
  const usage = interactionsUsageTokens(interaction.usage);
  if (!usage) {
    return undefined;
  }
  const interactionId = typeof interaction.id === 'string' ? interaction.id : undefined;
  return {
    type: 'tokens',
    tokens: usage,
    ...(interactionId ? { interactionId } : {}),
  };
}

/**
 * The end of an interaction — `interaction.completed`'s `interaction`, or a
 * buffered body: its tokens, the grounding across its `steps[]` (buffered
 * only; streamed grounding arrives on deltas) and its terminal status.
 */
function eventsFromInteractionEnd(interaction: Record<string, unknown>): TurnEvent[] {
  const events: TurnEvent[] = [];
  const tokenEvent = extractTokenEvent(interaction);
  if (tokenEvent) events.push(tokenEvent);
  const { steps } = interaction;
  const groundingEvent = Array.isArray(steps) ? groundingFromSteps(steps) : undefined;
  if (groundingEvent) events.push(groundingEvent);
  const done = doneFromInteractionStatus(interaction);
  if (done) events.push(done);
  return events;
}

/** An interaction's identity (`id`, `model`), sent on `interaction.created` and at its end. */
function interactionResponse(interaction: Record<string, unknown>): TurnResponse | undefined {
  const id = nonEmptyString(interaction.id);
  const model = nonEmptyString(interaction.model);
  if (!id && !model) return undefined;
  return { ...(id ? { id } : {}), ...(model ? { model } : {}) };
}

/** Every status maps to a stop; a non-terminal one (`in_progress`, `queued`) is `stream_incomplete`. */
function doneFromInteractionStatus(interaction: Record<string, unknown>): TurnEvent | undefined {
  const { status } = interaction;
  if (typeof status !== 'string') return undefined;
  const response = interactionResponse(interaction);
  return {
    type: 'done',
    stop: turnStopFromInteractionStatus(status),
    ...(typeof interaction.id === 'string' ? { interactionId: interaction.id } : {}),
    ...(response ? { response } : {}),
  };
}

export {
  codeExecutionEvidence,
  eventsFromDelta,
  eventsFromInteractionEnd,
  eventsFromModelOutputStep,
  eventsFromThoughtStep,
  extractTokenEvent,
  interactionResponse,
  isCodeExecutionType,
  isGoogleBuiltinStepType,
  rawStepEvidence,
};
