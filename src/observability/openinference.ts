/**
 * OpenInference attributes for Phoenix, whose message views, reasoning tokens and cost read only
 * OpenInference names; they are copied beside the semconv names so `toOtlpJson` stays neutral.
 *
 * @module
 */

import { isRecord } from '../kernel/util/record.ts';
import { inlineContent, type TraceRecord } from './trace-record.ts';
import type { TraceAttributes, TraceAttributeValue, TraceSpan } from './trace-span.ts';

const MODEL_CALLS: ReadonlySet<unknown> = new Set(['chat', 'generate_content']);

const AGENT_CALLS: ReadonlySet<unknown> = new Set(['invoke_agent']);

/** A decision (`theorem.decision.*`): one model call over JSON state, with no messages. */
const DECISION = 'decide';

/** Eval spans carry no semconv operation: a trial grades one turn, a run chains the trials. */
const EVAL_KINDS: Readonly<Record<string, string>> = {
  'theorem.eval.trial': 'EVALUATOR',
  'theorem.eval.run': 'CHAIN',
};

/** Model calls only: a viewer sums usage across a trace, and an agent span's is already a sum. */
function openInferenceUsage(attributes: TraceAttributes): TraceAttributes {
  const reasoning = attributes['gen_ai.usage.reasoning.output_tokens'];
  const cost = attributes['theorem.usage.cost_usd'];
  return {
    ...(typeof reasoning === 'number'
      ? { 'llm.token_count.completion_details.reasoning': reasoning }
      : {}),
    // A partial cost would read as the call's total; it keeps only its theorem.* name.
    ...(typeof cost === 'number' && attributes['theorem.usage.cost_partial'] !== true
      ? { 'llm.cost.total': cost }
      : {}),
  };
}

interface Part {
  type?: unknown;
  content?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  response?: unknown;
  modality?: unknown;
}

interface Message {
  role: string;
  parts: Part[];
}

function messagesOf(record: TraceRecord, value: TraceAttributeValue | undefined): Message[] {
  const inlined = inlineContent(record, value);
  if (!Array.isArray(inlined)) return [];
  return inlined.flatMap((message): Message[] => {
    if (!isRecord(message) || typeof message.role !== 'string') return [];
    const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
    return [{ role: message.role, parts: parts as Part[] }];
  });
}

function partText(part: Part): string | undefined {
  if (part.type === 'text' && typeof part.content === 'string') return part.content;
  if (part.type === 'structured' && part.content !== undefined) return JSON.stringify(part.content);
  if (part.type === 'tool_call' || part.type === 'tool_call_response') return undefined;
  if (typeof part.modality === 'string') return `[${part.modality}]`;
  return undefined;
}

/** A text part that repeats the structured part's JSON is shown once, as the JSON. */
function repeatsStructured(part: Part, structured: Part | undefined): boolean {
  if (structured === undefined || part.type !== 'text' || typeof part.content !== 'string') {
    return false;
  }
  try {
    return JSON.stringify(JSON.parse(part.content)) === JSON.stringify(structured.content);
  } catch {
    return false;
  }
}

function messageText(message: Message): string {
  const structured = message.parts.find((part) => part.type === 'structured');
  return message.parts
    .filter((part) => !repeatsStructured(part, structured))
    .flatMap((part) => partText(part) ?? [])
    .join('\n');
}

function messageAttributes(prefix: string, message: Message): TraceAttributes {
  const out: TraceAttributes = { [`${prefix}.message.role`]: message.role };
  const text = messageText(message);
  if (text !== '') out[`${prefix}.message.content`] = text;
  let calls = 0;
  for (const part of message.parts) {
    if (part.type === 'tool_call') {
      const call = `${prefix}.message.tool_calls.${calls}.tool_call`;
      calls += 1;
      if (typeof part.id === 'string') out[`${call}.id`] = part.id;
      if (typeof part.name === 'string') out[`${call}.function.name`] = part.name;
      if (typeof part.arguments === 'string') out[`${call}.function.arguments`] = part.arguments;
    } else if (part.type === 'tool_call_response') {
      if (typeof part.id === 'string') out[`${prefix}.message.tool_call_id`] = part.id;
      if (typeof part.response === 'string') out[`${prefix}.message.content`] = part.response;
    }
  }
  return out;
}

function messagesAttributes(key: string, messages: readonly Message[]): TraceAttributes {
  return Object.assign(
    {},
    ...messages.map((message, index) => messageAttributes(`${key}.${index}`, message)),
  );
}

/** `input.value` / `output.value`: the text a person would read, else the messages as JSON. */
function valueAttributes(side: 'input' | 'output', messages: readonly Message[]): TraceAttributes {
  if (messages.length === 0) return {};
  const texts = messages.map(messageText).filter((text) => text !== '');
  if (texts.length === messages.length && texts.length === 1 && texts[0] !== undefined) {
    return { [`${side}.value`]: texts[0], [`${side}.mime_type`]: 'text/plain' };
  }
  return {
    [`${side}.value`]: JSON.stringify(
      messages.map((message) => ({ role: message.role, content: messageText(message) })),
    ),
    [`${side}.mime_type`]: 'application/json',
  };
}

function openInferenceModelMessages(record: TraceRecord, span: TraceSpan): TraceAttributes {
  const system = messagesOf(
    record,
    span.attributes['gen_ai.system_instructions'] === undefined
      ? undefined
      : [{ role: 'system', parts: span.attributes['gen_ai.system_instructions'] }],
  );
  const input = [...system, ...messagesOf(record, span.attributes['gen_ai.input.messages'])];
  const output = messagesOf(
    record,
    span.attributes['gen_ai.output.messages'] ?? span.attributes['theorem.output.delivered'],
  );
  return {
    ...messagesAttributes('llm.input_messages', input),
    ...messagesAttributes('llm.output_messages', output),
    ...valueAttributes(
      'input',
      input.filter((message) => message.role !== 'system'),
    ),
    ...valueAttributes('output', output),
  };
}

function openInferenceAgentValues(record: TraceRecord, span: TraceSpan): TraceAttributes {
  return {
    ...valueAttributes('input', messagesOf(record, span.attributes['gen_ai.input.messages'])),
    ...valueAttributes('output', messagesOf(record, span.attributes['gen_ai.output.messages'])),
  };
}

function jsonValue(
  record: TraceRecord,
  side: 'input' | 'output',
  value: TraceAttributeValue | undefined,
): TraceAttributes {
  if (value === undefined) return {};
  return {
    [`${side}.value`]: JSON.stringify(inlineContent(record, value)),
    [`${side}.mime_type`]: 'application/json',
  };
}

/**
 * Phoenix derives no kind for an operation semconv does not name, and has no price for Jev, so
 * the kind, model, tokens and cost are stated. It has no messages, so Phoenix cannot replay it.
 */
function openInferenceDecision(record: TraceRecord, span: TraceSpan): TraceAttributes {
  const { attributes } = span;
  const input = attributes['gen_ai.usage.input_tokens'];
  const output = attributes['gen_ai.usage.output_tokens'];
  const model = attributes['gen_ai.response.model'] ?? attributes['gen_ai.request.model'];
  return {
    'openinference.span.kind': 'LLM',
    ...(typeof model === 'string' ? { 'llm.model_name': model } : {}),
    ...(typeof attributes['gen_ai.provider.name'] === 'string'
      ? { 'llm.provider': attributes['gen_ai.provider.name'] }
      : {}),
    ...(typeof input === 'number' ? { 'llm.token_count.prompt': input } : {}),
    ...(typeof output === 'number' ? { 'llm.token_count.completion': output } : {}),
    ...(typeof input === 'number' && typeof output === 'number'
      ? { 'llm.token_count.total': input + output }
      : {}),
    ...openInferenceUsage(attributes),
    ...jsonValue(record, 'input', attributes['theorem.decision.state']),
    ...jsonValue(record, 'output', attributes['theorem.decision.answers']),
  };
}

function withSpanAttributes(record: TraceRecord, span: TraceSpan): TraceSpan {
  const operation = span.attributes['gen_ai.operation.name'];
  if (MODEL_CALLS.has(operation)) {
    return {
      ...span,
      attributes: {
        ...span.attributes,
        ...openInferenceUsage(span.attributes),
        ...openInferenceModelMessages(record, span),
      },
    };
  }
  if (AGENT_CALLS.has(operation)) {
    return {
      ...span,
      attributes: { ...span.attributes, ...openInferenceAgentValues(record, span) },
    };
  }
  if (operation === DECISION) {
    return {
      ...span,
      attributes: { ...span.attributes, ...openInferenceDecision(record, span) },
    };
  }
  const evalKind = EVAL_KINDS[span.name];
  if (evalKind !== undefined) {
    return { ...span, attributes: { ...span.attributes, 'openinference.span.kind': evalKind } };
  }
  return span;
}

/** Pure: input records are not changed. Export with `toOtlpJson(withOpenInference(records))`. */
function withOpenInference(records: readonly TraceRecord[]): TraceRecord[] {
  return records.map((record) => ({
    ...record,
    spans: record.spans.map((span) => withSpanAttributes(record, span)),
  }));
}

export { withOpenInference };
