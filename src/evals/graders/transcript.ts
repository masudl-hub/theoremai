/**
 * The judged record as a rubric reads it: Phoenix's variable names, each
 * filled from the trace alone.
 *
 * @module
 */

import type { DecisionJson } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import type { TraceAttributeValue, TraceSpan } from '../../observability/trace-span.ts';
import { templatePaths } from '../rubrics/mustache.ts';
import type { EvalRubric } from '../rubrics/types.ts';
import type { Trial } from '../types.ts';
import { mediaLabeler, trialMedia } from './media.ts';
import { deliveredJson, deliveredText, modelCalls, startOf } from './shared.ts';

/** The names a rubric may use without the host supplying a reading. */
const TRIAL_VARIABLES = [
  'input',
  'output',
  'context',
  'conversation',
  'user_message',
  'tool_call',
  'tool_result',
  'text',
] as const;

/** One message of the turn's output, as a rubric's `output.messages` lists it. */
type JudgedMessage = {
  role: string;
  content: string;
  /** Each tool call the message made, as JSON (`name`, `arguments`). */
  tool_calls: string[];
};

/** Whether a text part already says what a structured part holds (the model's JSON, parsed). */
function sameAsText(content: unknown, texts: readonly string[]): boolean {
  const json = JSON.stringify(content);
  return texts.some((text) => {
    try {
      return JSON.stringify(JSON.parse(text)) === json;
    } catch {
      return false;
    }
  });
}

/**
 * The text of a message's parts once inlined: text parts joined, media by
 * the label the judge sees it under, tool calls left out, and a structured
 * part only where no text part already carries the same JSON.
 */
function partsText(parts: unknown, media: (part: Record<string, unknown>) => string): string {
  if (!Array.isArray(parts)) return '';
  const texts = parts.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.content === 'string'
      ? [part.content]
      : [],
  );
  return parts
    .map((part) => {
      if (!isRecord(part) || part.type === 'tool_call') return '';
      if (typeof part.content === 'string') return part.content;
      if (part.type === 'structured') {
        return sameAsText(part.content, texts) ? '' : JSON.stringify(part.content);
      }
      if (part.type === 'blob' || part.type === 'uri') return media(part);
      if (typeof part.type === 'string') return `[${part.type}]`;
      return '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** A tool call as a rubric lists it: arguments as the JSON object they were, not a string of it. */
function toolCallText(part: Record<string, unknown>): string {
  let args: unknown = part.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      // Not JSON: the arguments stand as the model sent them.
    }
  }
  return JSON.stringify({ name: part.name, arguments: args });
}

/** The turn's input messages, inlined, as `{ role, text }`. */
function inputMessages(trial: Trial): { role: string; text: string }[] {
  const messages = trial.content(trial.root.attributes['gen_ai.input.messages']);
  if (!Array.isArray(messages)) return [];
  const media = mediaLabeler(trial);
  return messages.flatMap((message) => {
    if (!isRecord(message) || typeof message.role !== 'string') return [];
    return [{ role: message.role, text: partsText(message.parts, media) }];
  });
}

function stringOf(trial: Trial, value: TraceAttributeValue | undefined): string {
  if (typeof value === 'string') return value;
  return trial.text(value) ?? '';
}

interface ToolStep {
  span: TraceSpan;
  name: string;
  arguments: string;
  result: string;
  outcome: string;
}

function toolSteps(trial: Trial): ToolStep[] {
  return trial.spans('execute_tool').map((span) => ({
    span,
    name: stringOf(trial, span.attributes['gen_ai.tool.name']),
    arguments: stringOf(trial, span.attributes['gen_ai.tool.call.arguments']),
    result: stringOf(trial, span.attributes['gen_ai.tool.call.result']),
    outcome: stringOf(trial, span.attributes['theorem.tool.outcome']),
  }));
}

/** The tools the model was offered, as the last model call declared them, one JSON definition each. */
function availableTools(trial: Trial): string[] {
  const calls = modelCalls(trial);
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const text = stringOf(trial, calls[i]?.attributes['gen_ai.tool.definitions']);
    if (text === '') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((tool) => JSON.stringify(tool));
    } catch {
      // Not JSON: the definitions stand as one entry, as sent.
    }
    return [text];
  }
  return [];
}

/** Every model message and tool result of the turn, in the order they happened. */
function outputMessages(trial: Trial, steps: readonly ToolStep[]): JudgedMessage[] {
  const media = mediaLabeler(trial);
  const fromCalls = modelCalls(trial).flatMap((span) => {
    const messages = trial.content(span.attributes['gen_ai.output.messages']);
    if (!Array.isArray(messages)) return [];
    return messages.filter(isRecord).map((message) => ({
      at: startOf(span),
      message: {
        role: typeof message.role === 'string' ? message.role : 'assistant',
        content: partsText(message.parts, media),
        tool_calls: (Array.isArray(message.parts) ? message.parts : [])
          .filter(
            (part): part is Record<string, unknown> => isRecord(part) && part.type === 'tool_call',
          )
          .map(toolCallText),
      },
    }));
  });
  const fromTools = steps.map((step) => ({
    at: startOf(step.span),
    message: { role: 'tool', content: `${step.name}: ${step.result}`, tool_calls: [] },
  }));
  return [...fromCalls, ...fromTools]
    .toSorted((a, b) => Number(a.at - b.at))
    .map((entry) => entry.message);
}

/** What the model delivered: its text, or its structured JSON when that is all it delivered. */
function outputText(trial: Trial): string {
  const text = deliveredText(trial, undefined);
  if (text !== '') return text;
  const json = deliveredJson(trial);
  return json === undefined ? '' : JSON.stringify(json);
}

/** A tool step as the transcript writes it: the call with its arguments, then its result. */
function stepText(step: ToolStep): string[] {
  return [
    `[tool call ${step.name}]\n${step.arguments}`,
    `[tool result ${step.name}]${step.outcome ? ` (${step.outcome})` : ''}\n${step.result}`,
  ];
}

function transcript(
  messages: readonly { role: string; text: string }[],
  steps: readonly ToolStep[],
  output: string,
): string {
  return [
    ...messages.map((message) => `[${message.role}]\n${message.text}`),
    ...steps.flatMap(stepText),
    `[assistant]\n${output}`,
  ].join('\n\n');
}

/**
 * Every standard variable, read from the trial:
 *
 * - `input`, `user_message`: the last user message of the turn's input.
 * - `output`, `text`: what the model delivered.
 * - `context`: what the model had to go on besides the question: the media
 *   the input carried, then every tool call with its arguments and result,
 *   in order.
 * - `tool_call`: every tool called, with its arguments and outcome, one a line.
 * - `tool_result`: every tool result, named, in order.
 * - `conversation`: the whole record as a transcript, step by step.
 */
function trialVariables(trial: Trial): Record<(typeof TRIAL_VARIABLES)[number], string> {
  const messages = inputMessages(trial);
  const input = messages.findLast((message) => message.role === 'user')?.text ?? '';
  const output = outputText(trial);
  const steps = toolSteps(trial);
  return {
    input,
    output,
    context: [
      ...trialMedia(trial)
        .filter((media) => media.from === 'input')
        .map((media) => `[attached]\n${media.label}`),
      ...steps.flatMap(stepText),
    ].join('\n\n'),
    conversation: transcript(messages, steps, output),
    user_message: input,
    tool_call: steps
      .map((step) => `${step.name}(${step.arguments})${step.outcome ? ` → ${step.outcome}` : ''}`)
      .join('\n'),
    tool_result: steps.map((step) => `${step.name}: ${step.result}`).join('\n\n'),
    text: output,
  };
}

/**
 * What one rubric reads, by its variables: the host's reading where it gives
 * one, else the trace's. Two readings depend on the rubric. One whose prompt
 * reads `output.messages` or `output.available_tools` gets `output` as those
 * lists (every model message and tool result, in order; each offered tool as
 * JSON). One that reads `user_message` gets `conversation` as what came
 * before that message, as Phoenix's user-friction prompt asks.
 */
function rubricView(
  rubric: EvalRubric,
  trial: Trial,
  host: Readonly<Record<string, string>>,
): Record<string, DecisionJson> {
  const values: Record<string, string> = { ...trialVariables(trial) };
  const paths = rubric.template === undefined ? [] : templatePaths(rubric.template);
  const view: Record<string, DecisionJson> = {};
  for (const variable of rubric.variables) {
    if (host[variable] !== undefined) view[variable] = host[variable];
    else if (variable === 'output' && paths.some((path) => path.startsWith('output.'))) {
      view.output = {
        messages: outputMessages(trial, toolSteps(trial)),
        available_tools: availableTools(trial),
      };
    } else if (variable === 'conversation' && rubric.variables.includes('user_message')) {
      const messages = inputMessages(trial);
      const last = messages.findLastIndex((message) => message.role === 'user');
      view.conversation = messages
        .slice(0, Math.max(last, 0))
        .map((message) => `[${message.role}]\n${message.text}`)
        .join('\n\n');
    } else if (values[variable] !== undefined) view[variable] = values[variable];
  }
  return view;
}

export type { ToolStep };
export { rubricView, TRIAL_VARIABLES, toolSteps, trialVariables };
