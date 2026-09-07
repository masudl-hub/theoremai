import { TheorumError } from '../../../guardrails/error.ts';
import { getStructured } from '../../../kernel/registry/schemas.ts';
import { getTool } from '../../../kernel/tools/registry.ts';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';

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
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return { type: part.type, mimeType: part.mimeType, data: part.data };
}

const USER_INPUT = 'user_input';

export function userInputStep(parts: InteractionPart[]): Record<string, unknown> {
  return { type: USER_INPUT, content: parts.map(wirePart) };
}

function functionResultStep(msg: TurnHistoryMessage): Record<string, unknown> {
  return {
    type: 'function_result',
    name: msg.name ?? '',
    call_id: msg.tool_call_id ?? '',
    result: [{ type: 'text', text: msg.content ?? '' }],
  };
}

export function historyStep(msg: TurnHistoryMessage): Record<string, unknown> {
  if (msg.role === 'tool') {
    return functionResultStep(msg);
  }
  const isAssistant = msg.role === 'assistant';
  // Google Interactions input steps: assistant history is `model_output` (not `model_turn`).
  const type = isAssistant ? 'model_output' : 'user_input';
  if (msg.parts && msg.parts.length > 0) {
    return { type, content: msg.parts.map(wirePart) };
  }
  return { type, content: [{ type: 'text', text: msg.content ?? '' }] };
}

export function systemHoldsUserInput(system: string, parts: InteractionPart[]): boolean {
  for (const part of parts) {
    if (part.type === 'text' && part.text && system.includes(part.text)) {
      return true;
    }
  }
  return false;
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
      throw new TheorumError('cannot mix speech and image response formats');
    }
    if (req.structured) {
      throw new TheorumError('cannot mix speech and structured response formats');
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
  const spec = getStructured(req.structured);
  if (spec.enforced !== 'responseFormat' || !spec.jsonSchema) {
    return;
  }
  camel.responseFormat = jsonResponseFormat(spec.jsonSchema);
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
    const entry = getTool(id);
    const type = entry?.type === 'builtin' ? entry.wire.interactions : undefined;
    if (!type) {
      throw new TheorumError(`Builtin '${id}' has no Interactions wire type`);
    }
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
  if (req.interactionOnlyInput && req.interactionOnlyInput.length > 0) {
    return req.interactionOnlyInput;
  }
  const inputSteps: Record<string, unknown>[] = [];
  for (const h of req.history ?? []) {
    inputSteps.push(historyStep(h));
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
    if (systemHoldsUserInput(req.system, req.input)) {
      throw new TheorumError('User payload must not be copied into system instructions');
    }
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
    generationConfig.thinkingLevel = req.thinking;
    generationConfig.thinkingSummaries = req.summaries;
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
