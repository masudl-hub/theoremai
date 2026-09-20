/**
 * Convert THEOREM turn input into Vercel AI SDK `ModelMessage[]`.
 *
 * Semantic twin of `openai/compat.ts` (REST wire format). OpenRouter's AI SDK
 * adapter uses this module; local and payload paths use `buildChatMessages`.
 *
 * @module
 */

import type { ModelMessage } from 'ai';
import { TheoremError } from '../../../guardrails/error.ts';
import { isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import type {
  InteractionMediaPart,
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
} from '../../../kernel/types.ts';
import { fallbackToolCallId, parseToolInput } from './compat.ts';

function inlineMediaPart(part: Exclude<InteractionPart, { type: 'text' }>): InteractionMediaPart {
  if (isMediaRefPart(part)) {
    throw new TheoremError('media references are not supported on openAi');
  }
  return part;
}

function stringDefault(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : value;
}

export function sdkPart(input: InteractionPart): Record<string, unknown> {
  if (input.type === 'text') {
    return { type: 'text', text: input.text };
  }
  const part = inlineMediaPart(input);
  if (part.type === 'image') {
    return {
      type: 'image',
      image: `data:${part.mimeType};base64,${part.data}`,
    };
  }
  return { type: 'file', mediaType: part.mimeType, data: part.data };
}

export function sdkContentFromParts(
  parts: InteractionPart[],
): string | Array<Record<string, unknown>> {
  if (parts.every((part) => part.type === 'text')) {
    return parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return parts.map(sdkPart);
}

export function sdkContentFromOptionalParts(
  parts: InteractionPart[] | undefined,
  text: string | undefined,
): string | Array<Record<string, unknown>> {
  if (!parts || parts.length === 0) {
    return stringDefault(text, '');
  }
  return sdkContentFromParts(parts);
}

export function toolResultMessage(msg: TurnHistoryMessage): ModelMessage {
  const toolName = stringDefault(msg.name, 'tool');
  const toolCallId = stringDefault(msg.tool_call_id, fallbackToolCallId(msg.name));
  const output =
    msg.parts && msg.parts.length > 0
      ? {
          type: 'content' as const,
          value: msg.parts.map((input) => {
            if (input.type === 'text') {
              return { type: 'text' as const, text: input.text };
            }
            // image / audio / video / document — AI SDK tool-result file parts
            const part = inlineMediaPart(input);
            return {
              type: 'file' as const,
              mediaType: part.mimeType,
              data: { type: 'data' as const, data: part.data },
            };
          }),
        }
      : { type: 'text' as const, value: stringDefault(msg.content, '') };

  // AI SDK ToolModelMessage is a branded union; structural tool-result is correct at runtime.
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output,
      },
    ],
  } as ModelMessage;
}

export function assistantToolCallMessage(msg: TurnHistoryMessage): ModelMessage | null {
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return null;
  }
  return {
    role: 'assistant',
    content: msg.tool_calls.map((call) => ({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseToolInput(call.function.arguments),
    })),
  } as ModelMessage;
}

export function contentHistoryMessage(msg: TurnHistoryMessage): ModelMessage {
  const content = sdkContentFromOptionalParts(msg.parts, msg.content);
  return { role: msg.role, content } as ModelMessage;
}

export function historyToSdk(msg: TurnHistoryMessage): ModelMessage | null {
  if (msg.role === 'tool') {
    return toolResultMessage(msg);
  }
  return assistantToolCallMessage(msg) || contentHistoryMessage(msg);
}

/**
 * Build AI SDK messages for history + user input.
 * Caller supplies `req.system` via `streamText({ instructions })`.
 */
export function buildAiSdkMessages(req: ProviderCompleteRequest): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const msg of req.history ?? []) {
    const wired = historyToSdk(msg);
    if (wired) {
      messages.push(wired);
    }
  }
  if (req.input.length > 0) {
    messages.push({ role: 'user', content: sdkContentFromParts(req.input) } as ModelMessage);
  }
  return messages;
}
