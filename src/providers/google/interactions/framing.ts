import { z } from 'zod';
import { TheoremError } from '../../../guardrails/error.ts';
import { historyMessageParts, wireInteractionPart } from '../../../kernel/interaction-parts.ts';
import type {
  InteractionPart,
  ModelRequest,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { withCarriedToolFiles } from '../../shared/carried-tool-files.ts';
import { historyToolArguments, historyToolIdentity } from '../../shared/tool-args.ts';
import { interactionsBuiltinTool } from '../builtins.ts';
import { GOOGLE_SPEECH_FORMATS } from '../limits.ts';
import { assertGoogleThinkingLevel } from '../thinking.ts';

/** A turn as Interactions frames it: the request, plus whether Google keeps it and what it continues. */
export type InteractionsRequest = ModelRequest & {
  store?: boolean;
  previousInteractionId?: string;
  /** What came after the stored interaction, sent in place of the whole history. */
  continuation?: TurnHistoryMessage[];
};

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
      // why: A schema's property names and a call's argument names are the builder's own; snake-casing them breaks Gemini validation and shows the model a call it did not make.
      if (key === 'schema' || key === 'parameters' || key === 'arguments') {
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

// why: Google refuses any other part inside a `function_result`: "The value 'document' is not supported for 'type' at 'input[8].result[2]'. Supported values: 'function', 'image', 'text', 'video'." (live, 13/10/2026, gemini-3.5-flash-lite).
const FUNCTION_RESULT_PART_TYPES: ReadonlySet<InteractionPart['type']> = new Set([
  'text',
  'image',
  'video',
]);

function functionResultStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const parts = historyMessageParts(msg);
  return {
    type: 'function_result',
    ...historyToolIdentity({ name: msg.name, call_id: msg.tool_call_id }),
    result: parts.length > 0 ? parts.map(wirePart) : [{ type: 'text', text: '' }],
  };
}

/**
 * A history call as input steps: the thought that led to it when it carries
 * that thought's signature, then the call. Google rejects a current-turn call
 * replayed without its signature, and rejects a `thought_signature` field on
 * the call; a `thought` step with the signature ahead of it is accepted (probe
 * 25/09/2026, gemini-3.1-flash-lite, `store: false`).
 */
function functionCallSteps(
  call: { id: string; function: { name: string; arguments: string } },
  signature: string | undefined,
): Record<string, unknown>[] {
  const step = {
    type: 'function_call',
    id: call.id,
    name: call.function.name,
    arguments: historyToolArguments(call.function.arguments),
  };
  return signature ? [{ type: 'thought', signature }, step] : [step];
}

/** A thought's signature, for the tool call at `call` in the same assistant message. */
export const thoughtSignature: z.ZodType<{ call: number; signature: string }> = z.strictObject({
  call: z.number().int().min(0),
  signature: z.string().min(1),
});

/** The signature written with the message's call at `index`, if its reasoning holds one. */
function signatureAt(msg: TurnHistoryMessage, index: number): string | undefined {
  for (const part of msg.reasoning ?? []) {
    const parsed = thoughtSignature.safeParse(part.data);
    if (parsed.success && parsed.data.call === index) return parsed.data.signature;
  }
  return undefined;
}

function textOrPartsStep(
  role: 'assistant' | 'user',
  msg: TurnHistoryMessage,
): Record<string, unknown> {
  // why: Assistant history is `model_output`, not `model_turn`.
  const type = role === 'assistant' ? 'model_output' : 'user_input';
  return { type, content: historyContent(msg) };
}

/** Assistant `tool_calls` (often with no `content`) become `function_call` steps, never empty `model_output`. */
function nonToolSteps(msg: TurnHistoryMessage): Record<string, unknown>[] {
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    const steps: Record<string, unknown>[] = [];
    if (historyMessageParts(msg).length > 0) {
      steps.push(textOrPartsStep('assistant', msg));
    }
    for (const [index, call] of msg.tool_calls.entries()) {
      steps.push(...functionCallSteps(call, signatureAt(msg, index)));
    }
    return steps;
  }

  if (msg.role === 'assistant') {
    return [textOrPartsStep('assistant', msg)];
  }

  return [textOrPartsStep('user', msg)];
}

/**
 * History as input steps. A file a `function_result` cannot hold follows its run
 * of tool results in a `user_input` step (`withCarriedToolFiles`).
 */
function historyStepsOf(messages: readonly TurnHistoryMessage[]): Record<string, unknown>[] {
  return withCarriedToolFiles(messages, FUNCTION_RESULT_PART_TYPES).flatMap((msg) =>
    msg.role === 'tool' ? [functionResultStep(msg)] : nonToolSteps(msg),
  );
}

export function historySteps(msg: TurnHistoryMessage): Record<string, unknown>[] {
  return historyStepsOf([msg]);
}

export function historyStep(msg: TurnHistoryMessage): Record<string, unknown> {
  const steps = historySteps(msg);
  return steps[0] ?? { type: 'user_input', content: [{ type: 'text', text: '' }] };
}

export function jsonResponseFormat(schema: Record<string, unknown>): unknown[] {
  return [{ type: 'text', mimeType: 'application/json', schema }];
}

export function attachResponseFormat(
  req: InteractionsRequest,
  camel: Record<string, unknown>,
): void {
  if (req.speech) {
    if (req.image) {
      throw new TheoremError('config', 'cannot mix speech and image response formats');
    }
    if (req.structured) {
      throw new TheoremError('config', 'cannot mix speech and structured response formats');
    }
    const format = req.speech.format;
    if (format && !(GOOGLE_SPEECH_FORMATS as readonly string[]).includes(format)) {
      throw new TheoremError(
        'unsupported',
        `Gemini speech returns ${GOOGLE_SPEECH_FORMATS.join(', ')}, not '${format}'`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
      );
    }
    camel.responseFormat = { type: 'audio' };
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
    camel.responseFormat = req.image.includeText ? [{ type: 'text' }, imageEntry] : imageEntry;
    return;
  }
  if (!req.structured) {
    return;
  }
  camel.responseFormat = jsonResponseFormat(req.structured.jsonSchema);
}

export function attachSpeechConfig(
  req: InteractionsRequest,
  generationConfig: Record<string, unknown>,
): void {
  if (!req.speech) {
    return;
  }
  const { voice, speed } = req.speech;
  if (speed !== undefined) {
    // why: Interactions has no rate field, and a speed dropped here would be a setting the host believes it made.
    throw new TheoremError(
      'config',
      'Gemini Interactions speech has no speed field: set the pace in speech.style',
    );
  }
  if (!voice) {
    // why: Interactions has no default voice and refuses the request without one (live, 17/10/2026).
    throw new TheoremError('config', 'Gemini speech needs a voice: set speech.voice');
  }
  generationConfig.speechConfig = [{ voice }];
}

/**
 * The speech models that read a delivery note as a `speech_metadata` annotation. The others refuse
 * it ("Speech metadata is not supported for this model", gemini-3.1-flash-tts-preview, live
 * 17/10/2026) and take the note as a direction ahead of the script, as Google's guide shows.
 */
const SPEECH_METADATA_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
]);

/** The script with its delivery note, in the form the model reads it. */
function speechInputStep(
  parts: InteractionPart[],
  style: string,
  apiId: string,
): Record<string, unknown> {
  if (!SPEECH_METADATA_MODELS.has(apiId)) {
    return {
      type: USER_INPUT,
      content: [
        { type: 'text', text: `Read the following aloud. ${style.trim()}\n` },
        ...parts.map(wirePart),
      ],
    };
  }
  // why: Gemini reads `text` aloud and `speech_metadata` as direction.
  const annotations = [{ type: 'speech_metadata', style }];
  return {
    type: USER_INPUT,
    content: parts
      .map(wirePart)
      .map((part) => (part.type === 'text' ? { ...part, annotations } : part)),
  };
}

function wireInteractionsFunctionTool(decl: WireFunctionTool): Record<string, unknown> {
  return {
    type: 'function',
    name: decl.name,
    description: decl.description,
    parameters: decl.parameters,
  };
}

function wireInteractionsTools(req: InteractionsRequest): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];
  for (const builtin of req.builtins) {
    tools.push(interactionsBuiltinTool(builtin));
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

export function inputStepsFromRequest(req: InteractionsRequest): Record<string, unknown>[] {
  if (req.continuation && req.continuation.length > 0) {
    return historyStepsOf(withToolNames(req.continuation));
  }
  const inputSteps = historyStepsOf(withToolNames(req.history ?? []));
  if (req.input.length > 0 || inputSteps.length === 0) {
    const style = req.speech?.style;
    inputSteps.push(
      style ? speechInputStep(req.input, style, req.apiId) : userInputStep(req.input),
    );
  }
  return inputSteps;
}

export function applyOptionalRequestFields(
  req: InteractionsRequest,
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

export function baseInteractionsBody(req: InteractionsRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  };
  if (req.speech) {
    // why: TTS models reject chat thinking knobs; voice lives under speech_config.
    attachSpeechConfig(req, generationConfig);
  } else {
    assertGoogleThinkingLevel(req.thinking);
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

export function toInteractionsBody(req: InteractionsRequest): Record<string, unknown> {
  const body = baseInteractionsBody(req);
  attachResponseFormat(req, body);
  applyOptionalRequestFields(req, body);
  return toGoogleValue(body) as Record<string, unknown>;
}
