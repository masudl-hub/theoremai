/**
 * Convert THEOREM turn input into Vercel AI SDK `ModelMessage[]`.
 *
 * Semantic twin of `openai/compat.ts` (REST wire format). OpenRouter's AI SDK
 * adapter uses this module; local and image paths use `buildChatMessages`.
 *
 * @module
 */

import type { ModelMessage } from 'ai';
import { TheoremError } from '../../../guardrails/error.ts';
import { historyMessageParts, isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import type {
  InteractionMediaPart,
  InteractionPart,
  ProviderCompleteRequest,
  TurnHistoryMessage,
} from '../../../kernel/types.ts';
import { historyToolArguments, historyToolIdentity } from '../../shared/tool-args.ts';

function inlineMediaPart(part: Exclude<InteractionPart, { type: 'text' }>): InteractionMediaPart {
  if (isMediaRefPart(part)) {
    throw new TheoremError('media references are not supported on openAi');
  }
  return part;
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

export function toolResultMessage(msg: TurnHistoryMessage): ModelMessage {
  const parts = historyMessageParts(msg);
  const content = sdkContentFromParts(parts);
  const output =
    typeof content === 'string'
      ? { type: 'text' as const, value: content }
      : {
          type: 'content' as const,
          value: parts.map((input) => {
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
        };

  // AI SDK ToolModelMessage is a branded union; structural tool-result is correct at runtime.
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        // The AI SDK rejects a missing id or name (`AI_InvalidPromptError`).
        ...historyToolIdentity({ toolCallId: msg.tool_call_id, toolName: msg.name }),
        output,
      },
    ],
  } as ModelMessage;
}

export function assistantToolCallMessage(msg: TurnHistoryMessage): ModelMessage | null {
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return null;
  }
  const said = sdkContentFromParts(historyMessageParts(msg));
  const lead = typeof said === 'string' ? (said ? [{ type: 'text', text: said }] : []) : said;
  return {
    role: 'assistant',
    content: [
      ...lead,
      ...msg.tool_calls.map((call) => ({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.function.name,
        input: historyToolArguments(call.function.arguments),
      })),
    ],
  } as ModelMessage;
}

export function contentHistoryMessage(msg: TurnHistoryMessage): ModelMessage {
  return { role: msg.role, content: sdkContentFromParts(historyMessageParts(msg)) } as ModelMessage;
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
