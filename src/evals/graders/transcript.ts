/**
 * The judged record as text: what a rubric's variables are filled from. Every
 * reading comes from the trace alone.
 *
 * @module
 */

import type { TraceAttributeValue } from '../../observability/trace-span.ts';
import type { Trial } from '../types.ts';
import { deliveredJson, deliveredText } from './shared.ts';

/** The names a rubric may use without the host supplying a reading. */
const TRIAL_VARIABLES = [
  'input',
  'output',
  'context',
  'conversation',
  'availableTools',
  'toolSelection',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of a message's parts once inlined: text parts joined, media named. */
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (!isObject(part)) return '';
      if (typeof part.content === 'string') return part.content;
      if (part.type === 'structured') return JSON.stringify(part.content);
      if (typeof part.type === 'string') return `[${part.type}]`;
      return '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** The turn's input messages, inlined, as `{ role, text }`. */
function inputMessages(trial: Trial): { role: string; text: string }[] {
  const messages = trial.content(trial.root.attributes['gen_ai.input.messages']);
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!isObject(message) || typeof message.role !== 'string') return [];
    return [{ role: message.role, text: partsText(message.parts) }];
  });
}

function stringOf(trial: Trial, value: TraceAttributeValue | undefined): string {
  if (typeof value === 'string') return value;
  return trial.text(value) ?? '';
}

interface ToolStep {
  name: string;
  arguments: string;
  result: string;
  outcome: string;
}

function toolSteps(trial: Trial): ToolStep[] {
  return trial.spans('execute_tool').map((span) => ({
    name: stringOf(trial, span.attributes['gen_ai.tool.name']),
    arguments: stringOf(trial, span.attributes['gen_ai.tool.call.arguments']),
    result: stringOf(trial, span.attributes['gen_ai.tool.call.result']),
    outcome: stringOf(trial, span.attributes['theorem.tool.outcome']),
  }));
}

/** The tools the model was offered, as the last model call declared them; `none` when it was offered none. */
function availableTools(trial: Trial): string {
  const calls = [...trial.spans('chat'), ...trial.spans('generate_content')];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const definitions = calls[i]?.attributes['gen_ai.tool.definitions'];
    const text = stringOf(trial, definitions);
    if (text !== '') return text;
  }
  return 'none';
}

/** What the model delivered: its text, or its structured JSON when that is all it delivered. */
function outputText(trial: Trial): string {
  const text = deliveredText(trial, undefined);
  if (text !== '') return text;
  const json = deliveredJson(trial);
  return json === undefined ? '' : JSON.stringify(json);
}

function toolLines(steps: ToolStep[]): string {
  if (steps.length === 0) return 'none';
  return steps
    .map(
      (step) => `${step.name}(${step.arguments || ''})${step.outcome ? ` → ${step.outcome}` : ''}`,
    )
    .join('\n');
}

/**
 * Every standard variable, read from the trial:
 *
 * - `input`: the last user message of the turn's input.
 * - `output`: what the model delivered.
 * - `context`: every tool result, in order.
 * - `toolSelection`: every tool called, with its arguments and outcome.
 * - `availableTools`: the tool definitions the model was offered.
 * - `conversation`: the whole record as a transcript, step by step.
 */
function trialVariables(trial: Trial): Record<(typeof TRIAL_VARIABLES)[number], string> {
  const messages = inputMessages(trial);
  const input = messages.findLast((message) => message.role === 'user')?.text ?? '';
  const output = outputText(trial);
  const steps = toolSteps(trial);
  const context = steps
    .map((step) => step.result)
    .filter((text) => text !== '')
    .join('\n\n');
  const conversation = [
    ...messages.map((message) => `[${message.role}]\n${message.text}`),
    ...steps.flatMap((step) => [
      `[tool call ${step.name}]\n${step.arguments}`,
      `[tool result ${step.name}]${step.outcome ? ` (${step.outcome})` : ''}\n${step.result}`,
    ]),
    `[assistant]\n${output}`,
  ].join('\n\n');
  return {
    input,
    output,
    context,
    toolSelection: toolLines(steps),
    availableTools: availableTools(trial),
    conversation,
  };
}

export { TRIAL_VARIABLES, trialVariables };
