import { asRecord, nonEmptyString } from '../../../kernel/engine/record.ts';
import { reportedTokens, usageCount } from '../../../kernel/engine/usage.ts';
import { turnStopFromInteractionStatus } from '../../../kernel/stop.ts';
import type {
  ProviderEvent,
  TurnEventOf,
  TurnResponse,
  TurnTokens,
} from '../../../kernel/types.ts';
import { groundingFromSteps } from '../grounding.ts';
import { byModality, groundingCounts, modalityCounts } from '../usage.ts';

/* probed 2026-09-23:
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

function interactionsMedia(rec: Record<string, unknown>): ProviderEvent[] {
  const mimeType = interactionsMime(rec);
  const { data } = rec;
  if (!mimeType || typeof data !== 'string' || !data) {
    return [];
  }
  return [{ type: 'media', media: { mimeType, data } }];
}

function textEvent(type: 'thought' | 'text', text: string): ProviderEvent[] {
  return text ? [{ type, text }] : [];
}

function isCodeExecutionType(type: string): boolean {
  return type === 'code_execution_call' || type === 'code_execution_result';
}

function isGoogleBuiltinStepType(type: string): boolean {
  return type.startsWith('google_') || type === 'url_context_call' || type === 'url_context_result';
}

function rawStepEvidence(raw: Record<string, unknown>): TurnEventOf<'evidence'> {
  return {
    type: 'evidence',
    evidence: { provider: 'google', kind: 'provider_step', step: String(raw.type ?? ''), raw },
  };
}

function codeExecutionEvidence(raw: Record<string, unknown>): TurnEventOf<'evidence'> {
  if (raw.type === 'code_execution_result') {
    const callId = nonEmptyString(raw.call_id);
    return {
      type: 'evidence',
      evidence: {
        provider: 'google',
        kind: 'code_execution_result',
        raw,
        ...(typeof raw.result === 'string' ? { result: raw.result } : {}),
        ...(typeof raw.is_error === 'boolean' ? { isError: raw.is_error } : {}),
        ...(callId ? { callId } : {}),
      },
    };
  }
  const args = asRecord(raw.arguments);
  const id = nonEmptyString(raw.id);
  if (raw.type !== 'code_execution_call' || !id || typeof args?.code !== 'string') {
    return rawStepEvidence(raw);
  }
  return {
    type: 'evidence',
    evidence: {
      provider: 'google',
      kind: 'code_execution_call',
      raw,
      code: args.code,
      ...(typeof args.language === 'string' ? { language: args.language } : {}),
      id,
    },
  };
}

function eventsFromDelta(deltaValue: unknown): ProviderEvent[] {
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

function eventsFromThoughtStep(step: Record<string, unknown>): ProviderEvent[] {
  const summary = Array.isArray(step.summary) ? step.summary : [];
  return summary.flatMap((block) => textEvent('thought', thoughtText(block)));
}

function eventsFromModelOutputStep(step: Record<string, unknown>): ProviderEvent[] {
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
 * Google reports thought and tool-use tokens beside input and output; the
 * OpenTelemetry meanings fold them in. Probes (gemini-3.8-flash, 22/09/2026):
 * `total_tokens` = input + output + thought + tool use, and cached sits inside input.
 * For inputs Google converts first (Markdown, Python, mono `audio/L16`, …) input
 * comes back 0 while `total_tokens` holds the full sum, so input is derived from it.
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

function extractTokenEvent(
  interaction: Record<string, unknown>,
): TurnEventOf<'tokens'> | undefined {
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

function eventsFromInteractionEnd(interaction: Record<string, unknown>): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  const tokenEvent = extractTokenEvent(interaction);
  if (tokenEvent) events.push(tokenEvent);
  // why: Only a buffered body carries `steps[]`; streamed grounding arrives on deltas.
  const { steps } = interaction;
  if (Array.isArray(steps)) events.push(...groundingFromSteps(steps));
  const done = doneFromInteractionStatus(interaction);
  if (done) events.push(done);
  return events;
}

function interactionResponse(interaction: Record<string, unknown>): TurnResponse | undefined {
  const id = nonEmptyString(interaction.id);
  const model = nonEmptyString(interaction.model);
  if (!id && !model) return undefined;
  return { ...(id ? { id } : {}), ...(model ? { model } : {}) };
}

function doneFromInteractionStatus(
  interaction: Record<string, unknown>,
): ProviderEvent | undefined {
  const { status } = interaction;
  if (typeof status !== 'string') return undefined;
  return {
    type: 'done',
    stop: turnStopFromInteractionStatus(status),
    ...(typeof interaction.id === 'string' ? { interactionId: interaction.id } : {}),
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
