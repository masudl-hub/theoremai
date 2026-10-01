import { TheoremError } from '../../../guardrails/error.ts';
import { historyMessageParts, wireInteractionPart } from '../../../kernel/interaction-parts.ts';
import type {
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { builtinWire } from '../../shared/builtin-wire.ts';
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
      // Schema property names stay as authored; snake-casing them breaks Gemini validation.
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

/**
 * A history call as input steps: the thought that led to it when it carries
 * that thought's signature, then the call. Google rejects a current-turn call
 * replayed without its signature, and rejects a `thought_signature` field on
 * the call; a `thought` step with the signature ahead of it is accepted (probe
 * 25/09/2026, gemini-3.1-flash-lite, `store: false`).
 */
function functionCallSteps(call: {
  id: string;
  function: { name: string; arguments: string };
  thoughtSignature?: string;
}): Record<string, unknown>[] {
  const step = {
    type: 'function_call',
    id: call.id,
    name: call.function.name,
    arguments: historyToolArguments(call.function.arguments),
  };
  return call.thoughtSignature
    ? [{ type: 'thought', signature: call.thoughtSignature }, step]
    : [step];
}

function textOrPartsStep(
  role: 'assistant' | 'user',
  msg: TurnHistoryMessage,
): Record<string, unknown> {
  // Assistant history is `model_output`, not `model_turn`.
  const type = role === 'assistant' ? 'model_output' : 'user_input';
  return { type, content: historyContent(msg) };
}

/** Assistant `tool_calls` (often with no `content`) become `function_call` steps, never empty `model_output`. */
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
      steps.push(...functionCallSteps(call));
    }
    return steps;
  }

  if (msg.role === 'assistant') {
    return [textOrPartsStep('assistant', msg)];
  }

  return [textOrPartsStep('user', msg)];
}

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
    if (req.image.resolution) {
      imageEntry.imageSize = req.image.resolution;
    }
    for (const [name, value] of [
      ['quality', req.image.quality],
      ['background', req.image.background],
      ['n', req.image.n],
      ['outputCompression', req.image.outputCompression],
    ] as const) {
      if (value !== undefined) {
        throw new TheoremError(
          'unsupported',
          `image.${name} is not supported on Google image models`,
        );
      }
    }
    // An object asks for image only; an array for text + image.
    camel.responseFormat = req.image.includeText ? [{ type: 'text' }, imageEntry] : imageEntry;
    return;
  }
  if (!req.structured) {
    return;
  }
  camel.responseFormat = jsonResponseFormat(req.structured.jsonSchema);
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
  for (const builtin of req.builtins) {
    const type = builtinWire(builtin, 'interactions');
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

/**
 * A `tool` message without `name` takes its call's name: Google rejects a
 * `function_result` without one as "Invalid input received" (live, 29/09/2026).
 */
function withToolNames(messages: readonly TurnHistoryMessage[]): TurnHistoryMessage[] {
  const names = new Map<string, string>();
  return messages.map((msg) => {
    for (const call of msg.tool_calls ?? []) names.set(call.id, call.function.name);
    if (msg.role !== 'tool' || msg.name || !msg.tool_call_id) return msg;
    const name = names.get(msg.tool_call_id);
    return name ? { ...msg, name } : msg;
  });
}

export function inputStepsFromRequest(req: ProviderCompleteRequest): Record<string, unknown>[] {
  if (req.continuation && req.continuation.length > 0) {
    return withToolNames(req.continuation).flatMap((msg) => historySteps(msg));
  }
  const inputSteps: Record<string, unknown>[] = [];
  for (const h of withToolNames(req.history ?? [])) {
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
    if (req.image?.seed !== undefined) {
      generationConfig.seed = req.image.seed;
    }
  }
  return {
    model: req.apiId,
    stream: req.stream ?? true,
    input: inputStepsFromRequest(req),
    generationConfig,
  };
}

export function toInteractionsBody(req: ProviderCompleteRequest): Record<string, unknown> {
  const body = baseInteractionsBody(req);
  attachResponseFormat(req, body);
  applyOptionalRequestFields(req, body);
  return toGoogleValue(body) as Record<string, unknown>;
}
