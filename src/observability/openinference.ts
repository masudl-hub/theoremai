/**
 * OpenInference attributes for viewers that read them (Phoenix).
 *
 * Phoenix maps the GenAI semconv span kinds, models and token counts on its
 * own, but its message views (the chat bubbles, Replay, the Input and Output
 * columns) read only OpenInference names, as do reasoning tokens and cost.
 * This module copies them onto each span, beside the semconv names, so the
 * kernel and `toOtlpJson` stay viewer-neutral. Hosts that don't use such a
 * viewer never load it.
 *
 * Names: https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * @module
 */

import { isRecord } from '../kernel/util/record.ts';
import { inlineContent, type TraceRecord } from './trace-record.ts';
import type { TraceAttributes, TraceAttributeValue, TraceSpan } from './trace-span.ts';

/** The operations that are one model call (semconv `gen_ai.operation.name`). */
const MODEL_CALLS: ReadonlySet<unknown> = new Set(['chat', 'generate_content']);

/** The operations that are one turn or session (semconv `gen_ai.operation.name`). */
const AGENT_CALLS: ReadonlySet<unknown> = new Set(['invoke_agent']);

/** A Jev decision (`theorem.decision.*`): one model call over JSON state, with no messages. */
const DECISION = 'decide';

/**
 * OpenInference names for one model call's usage. Only model calls carry them:
 * a viewer sums them across a trace, and an agent span's usage is already the
 * sum of its calls.
 */
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

/** One semconv message part, once its stored content is inlined. */
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

/** The semconv messages under a key, inlined; anything else is no message. */
function messagesOf(record: TraceRecord, value: TraceAttributeValue | undefined): Message[] {
  const inlined = inlineContent(record, value);
  if (!Array.isArray(inlined)) return [];
  return inlined.flatMap((message): Message[] => {
    if (!isRecord(message) || typeof message.role !== 'string') return [];
    const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
    return [{ role: message.role, parts: parts as Part[] }];
  });
}

/** A part's text as a reader would want it: its content, its JSON, or its modality named. */
function partText(part: Part): string | undefined {
  if (part.type === 'text' && typeof part.content === 'string') return part.content;
  if (part.type === 'structured' && part.content !== undefined) return JSON.stringify(part.content);
  if (part.type === 'tool_call' || part.type === 'tool_call_response') return undefined;
  if (typeof part.modality === 'string') return `[${part.modality}]`;
  return undefined;
}

/** Whether a text part is the structured part's JSON as the model typed it: shown once, as the JSON. */
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

/** The text of a message: its readable parts, one per line. */
function messageText(message: Message): string {
  const structured = message.parts.find((part) => part.type === 'structured');
  return message.parts
    .filter((part) => !repeatsStructured(part, structured))
    .flatMap((part) => partText(part) ?? [])
    .join('\n');
}

/** One message as OpenInference's flattened `message.*` attributes under a prefix. */
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

/** A model call's messages: system instructions first, then what it read; then what it wrote. */
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

/** A turn's input and output as the values a trace list shows. */
function openInferenceAgentValues(record: TraceRecord, span: TraceSpan): TraceAttributes {
  return {
    ...valueAttributes('input', messagesOf(record, span.attributes['gen_ai.input.messages'])),
    ...valueAttributes('output', messagesOf(record, span.attributes['gen_ai.output.messages'])),
  };
}

/** A stored JSON attribute as an OpenInference JSON value; nothing when it was not recorded. */
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
 * A decision as an LLM span: Phoenix derives no kind for an operation
 * semconv does not name, so the kind, model and token counts are stated; the
 * state is the input and the answers the output. It has no messages, so
 * Phoenix cannot replay it.
 */
function openInferenceDecision(record: TraceRecord, span: TraceSpan): TraceAttributes {
  const { attributes } = span;
  const input = attributes['gen_ai.usage.input_tokens'];
  const output = attributes['gen_ai.usage.output_tokens'];
  const model = attributes['gen_ai.response.model'] ?? attributes['gen_ai.request.model'];
  return {
    'openinference.span.kind': 'LLM',
    ...(typeof model === 'string' ? { 'llm.model_name': model } : {}),
    'llm.provider': 'typesafe',
    ...(typeof input === 'number' ? { 'llm.token_count.prompt': input } : {}),
    ...(typeof output === 'number' ? { 'llm.token_count.completion': output } : {}),
    ...(typeof input === 'number' && typeof output === 'number'
      ? { 'llm.token_count.total': input + output }
      : {}),
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
  return span;
}

/**
 * The records with OpenInference names added: usage and messages on every
 * model-call span, input and output values on every agent span, and a
 * decision's kind, model, tokens, state and answers. Pure: the
 * input records are not changed. Export with `toOtlpJson(withOpenInference(records))`.
 */
function withOpenInference(records: readonly TraceRecord[]): TraceRecord[] {
  return records.map((record) => ({
    ...record,
    spans: record.spans.map((span) => withSpanAttributes(record, span)),
  }));
}

export { withOpenInference };
