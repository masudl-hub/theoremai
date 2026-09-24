import { TheoremError } from '../../../guardrails/error.ts';
import { historyMessageParts, wireInteractionPart } from '../../../kernel/interaction-parts.ts';
import { getStructured } from '../../../kernel/registry/schemas.ts';
import { requireBuiltinWire } from '../../../kernel/tools/registry.ts';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { historyToolArguments, historyToolIdentity } from '../../shared/tool-args.ts';

export function camelToSnake(key: string): string {
  return key.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

export function toGoogleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toGoogleValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      // JSON Schema property names must stay as authored (e.g. correctAnswer in
      // both properties and required). Snake-casing breaks Gemini validation.
      if (key === 'schema' || key === 'parameters') {
        out[camelToSnake(key)] = nested;
        continue;
      }
      out[camelToSnake(key)] = toGoogleValue(nested);
    }
    return out;
  }
  return value;
}

export function wirePart(part: InteractionPart): Record<string, string> {
  return wireInteractionPart(part);
}

const USER_INPUT = 'user_input';

export function userInputStep(parts: InteractionPart[]): Record<string, unknown> {
  return { type: USER_INPUT, content: parts.map(wirePart) };
}

/** Wire content for a history message; an empty message is one empty text part. */
function historyContent(msg: TurnHistoryMessage): Record<string, string>[] {
  const parts = historyMessageParts(msg);
  return parts.length > 0 ? parts.map(wirePart) : [{ type: 'text', text: '' }];
}

function functionResultStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const result = historyContent(msg);
  return {
    type: 'function_result',
    ...historyToolIdentity({ name: msg.name, call_id: msg.tool_call_id }),
    result,
  };
}

function functionCallStep(call: {
  id: string;
  function: { name: string; arguments: string };
  thoughtSignature?: string;
}): Record<string, unknown> {
  const step: Record<string, unknown> = {
    type: 'function_call',
    id: call.id,
    name: call.function.name,
    arguments: historyToolArguments(call.function.arguments),
  };
  if (call.thoughtSignature) {
    step.thoughtSignature = call.thoughtSignature;
  }
  return step;
}

function textOrPartsStep(
  role: 'assistant' | 'user',
  msg: TurnHistoryMessage,
): Record<string, unknown> {
  // Google Interactions input steps: assistant history is `model_output` (not `model_turn`).
  const type = role === 'assistant' ? 'model_output' : 'user_input';
  return { type, content: historyContent(msg) };
}

/**
 * Map one host history message to Interactions input step(s).
 *
 * OpenAI-shaped assistant `tool_calls` (often with no `content`) become
 * `function_call` steps — never empty `model_output` text.
 */
export function historySteps(msg: TurnHistoryMessage): Record<string, unknown>[] {
  if (msg.role === 'tool') {
    return [functionResultStep(msg)];
  }

  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    const steps: Record<string, unknown>[] = [];
    if (historyMessageParts(msg).length > 0) {
      steps.push(textOrPartsStep('assistant', msg));
    }
    for (const call of msg.tool_calls) {
      steps.push(functionCallStep(call));
    }
    return steps;
  }

  if (msg.role === 'assistant') {
    return [textOrPartsStep('assistant', msg)];
  }

  return [textOrPartsStep('user', msg)];
}

/** Single-step helper for simple messages (first of {@link historySteps}). */
export function historyStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const steps = historySteps(msg);
  return steps[0] ?? { type: 'user_input', content: [{ type: 'text', text: '' }] };
}

export function jsonResponseFormat(schema: Record<string, unknown>): unknown[] {
  return [{ type: 'text', mimeType: 'application/json', schema }];
}

export function attachResponseFormat(
  req: ProviderCompleteRequest,
  camel: Record<string, unknown>,
): void {
  if (req.speech) {
    if (req.image) {
      throw new TheoremError('config', 'cannot mix speech and image response formats');
    }
    if (req.structured) {
      throw new TheoremError('config', 'cannot mix speech and structured response formats');
    }
    camel.responseFormat = { type: 'audio' };
    camel.responseModalities = ['audio'];
    return;
  }
  if (req.image) {
    const imageEntry: Record<string, unknown> = {
      type: 'image',
      mimeType: req.image.mimeType,
    };
    if (req.image.aspectRatio) {
      imageEntry.aspectRatio = req.image.aspectRatio;
    }
    if (req.image.size) {
      imageEntry.imageSize = req.image.size;
    }
    // Post–May 2026 Interactions API: object = image-only; array = text + image.
    camel.responseFormat = req.image.includeText ? [{ type: 'text' }, imageEntry] : imageEntry;
    return;
  }
  if (!req.structured) {
    return;
  }
  camel.responseFormat = jsonResponseFormat(getStructured(req.structured).jsonSchema);
}

export function attachSpeechConfig(
  req: ProviderCompleteRequest,
  generationConfig: Record<string, unknown>,
): void {
  if (!req.speech) {
    return;
  }
  const voice = req.speech.voice;
  if (!voice) {
    return;
  }
  generationConfig.speechConfig = [{ voice }];
}

function wireInteractionsFunctionTool(decl: WireFunctionTool): Record<string, unknown> {
  return {
    type: 'function',
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
  };
}

function wireGoogleMapsTool(req: ProviderCompleteRequest): Record<string, unknown> {
  const loc = req.googleMapsLocation;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) {
    return {
      type: 'google_maps',
      latitude: loc.latitude,
      longitude: loc.longitude,
    };
  }
  return { type: 'google_maps' };
}

function wireInteractionsTools(req: ProviderCompleteRequest): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];
  for (const id of req.builtins) {
    const type = requireBuiltinWire(id, 'interactions');
    if (type === 'google_maps') {
      tools.push(wireGoogleMapsTool(req));
      continue;
    }
    tools.push({ type });
  }
  for (const decl of req.wireTools ?? []) {
    tools.push(wireInteractionsFunctionTool(decl));
  }
  return tools;
}

export function inputStepsFromRequest(req: ProviderCompleteRequest): Record<string, unknown>[] {
  if (req.continuation && req.continuation.length > 0) {
    return req.continuation.flatMap(historySteps);
  }
  const inputSteps: Record<string, unknown>[] = [];
  for (const h of req.history ?? []) {
    inputSteps.push(...historySteps(h));
  }
  if (req.input.length > 0 || inputSteps.length === 0) {
    inputSteps.push(userInputStep(req.input));
  }
  return inputSteps;
}

export function applyOptionalRequestFields(
  req: ProviderCompleteRequest,
  camel: Record<string, unknown>,
): void {
  if (req.store !== undefined) {
    camel.store = req.store;
  }
  if (req.previousInteractionId) {
    camel.previousInteractionId = req.previousInteractionId;
  }
  if (req.system) {
    camel.systemInstruction = req.system;
  }
  const tools = wireInteractionsTools(req);
  if (tools.length > 0) {
    camel.tools = tools;
  }
}

export function baseInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  };
  if (req.speech) {
    // TTS models reject chat thinking knobs; voice lives under speech_config.
    attachSpeechConfig(req, generationConfig);
  } else {
    if (req.thinking) {
      generationConfig.thinkingLevel = req.thinking;
    }
    if (req.summaries) {
      generationConfig.thinkingSummaries = req.summaries;
    }
  }
  return {
    model: req.apiId,
    stream: req.stream ?? true,
    input: inputStepsFromRequest(req),
    generationConfig,
  };
}

/** Compatibility wrapper for callers that need the complete wire body. */
export function toInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const body = baseInteractionsBody(req);
  attachResponseFormat(req, body);
  applyOptionalRequestFields(req, body);
  return toGoogleValue(body) as Record<string, unknown>;
}
