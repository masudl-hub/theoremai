/**
 * Shared helpers for building OpenAI-compatible chat completion payloads.
 *
 * Used by local.ts (raw fetch), openrouter/image.ts (image payload), and
 * openrouter/chat.ts (headers + response format). Message bodies for the AI SDK
 * path are built by `openai/sdk-messages.ts`.
 * Single source of truth for message wire format, tool declarations,
 * structured response format, and gateway headers.
 *
 * @module
 */

import { TheoremError, toErrorEvent } from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import { historyMessageParts, isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import { getStructured } from '../../../kernel/registry/schemas.ts';
import type {
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  ProviderCompleteRequest,
  StructuredSchemaId,
  TurnEvent,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import { historyToolIdentity } from '../../shared/tool-args.ts';

// ── gateway http errors ─────────────────────────────

/**
 * A non-OK gateway response as an error event. The internal detail carries the
 * body's `error.message` (or its raw text), so the upstream reason reaches traces.
 */
async function httpErrorEvent(res: Response, label: string): Promise<TurnEvent> {
  const text = (await res.text()).trim();
  let detail = text;
  try {
    const message = asRecord(asRecord(JSON.parse(text))?.error)?.message;
    if (typeof message === 'string' && message) detail = message;
  } catch {
    // Not JSON: the raw body is the detail.
  }
  const head = `${label} HTTP ${String(res.status)}`;
  return toErrorEvent(detail ? `${head}: ${detail}` : head);
}

// ── gateway header config ───────────────────────────

/** Subset of provider config used for OpenAI-gateway HTTP headers. */
interface GatewayHeaderConfig {
  siteUrl?: string;
  siteName?: string;
}

// ── content wire format ─────────────────────────────

function rejectMediaRef(
  part: InteractionPart,
): asserts part is Exclude<InteractionPart, InteractionMediaRefPart> {
  if (isMediaRefPart(part)) {
    throw new TheoremError('media references are not supported on openAi');
  }
}

function wireAudioPart(part: InteractionMediaPart): Record<string, unknown> {
  let format = 'mp3';
  if (part.mimeType.includes('wav')) {
    format = 'wav';
  }
  return {
    type: 'input_audio',
    input_audio: {
      data: part.data,
      format,
    },
  };
}

/**
 * Map InteractionPart[] to OpenAI-compat message content.
 * Text-only inputs are joined as a plain string; mixed inputs produce a
 * content-part array (text, image_url, input_audio, file).
 */
export function wireMessageContent(parts: InteractionPart[]): unknown {
  const isAllText = parts.every((p) => p.type === 'text');
  if (isAllText) {
    return parts
      .map((p) => {
        if (p.type === 'text') {
          return p.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    rejectMediaRef(part);
    if (part.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.mimeType};base64,${part.data}` },
      };
    }
    if (part.type === 'audio') {
      return wireAudioPart(part);
    }
    // video + document — file part (OpenAI-compat / OpenRouter)
    return {
      type: 'file',
      file: {
        filename: part.type === 'video' ? 'clip.bin' : 'document.bin',
        file_data: `data:${part.mimeType};base64,${part.data}`,
      },
    };
  });
}

// ── history message wire format ─────────────────────

/**
 * Map a single TurnHistoryMessage to an OpenAI-compat wire message.
 * Tool messages carry `tool_call_id` / `name` only where history has them.
 * Assistant tool_calls are mapped to strip non-standard fields.
 */
function wireHistoryMessage(msg: TurnHistoryMessage): Record<string, unknown> {
  // Text-only messages collapse to one string (see wireMessageContent).
  const content = wireMessageContent(historyMessageParts(msg));
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      ...historyToolIdentity({ tool_call_id: msg.tool_call_id, name: msg.name }),
      content,
    };
  }

  const wired: Record<string, unknown> = {
    role: msg.role,
    content,
  };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    wired.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  if (msg.name) {
    wired.name = msg.name;
  }
  return wired;
}

// ── full message array builder ──────────────────────

/**
 * Build the complete `messages` array for an OpenAI chat completion request.
 * Assembles: system → history → user input.
 *
 * Set `includeSystem: false` when the caller passes system text separately
 * (e.g. AI SDK `instructions`).
 */
function buildChatMessages(
  req: ProviderCompleteRequest,
  options?: { includeSystem?: boolean },
): Record<string, unknown>[] {
  const includeSystem = options?.includeSystem !== false;
  const messages: Record<string, unknown>[] = [];
  if (includeSystem && req.system) {
    messages.push({ role: 'system', content: req.system });
  }
  if (req.history && req.history.length > 0) {
    for (const h of req.history) {
      messages.push(wireHistoryMessage(h));
    }
  }
  if (req.input.length > 0) {
    messages.push({
      role: 'user',
      content: wireMessageContent(req.input),
    });
  }
  return messages;
}

// ── tool declarations ───────────────────────────────

/**
 * Map wire function tools to OpenAI-compat function tool format.
 * Returns undefined when there are no tools.
 */
function wireTools(wireTools?: WireFunctionTool[]): Record<string, unknown>[] | undefined {
  if (!wireTools || wireTools.length === 0) {
    return undefined;
  }
  return wireTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ── structured response format ──────────────────────

/** Resolve a StructuredSchemaId to an OpenAI `response_format` object; undefined without one. */
function resolveResponseFormat(
  structured: StructuredSchemaId | null,
): Record<string, unknown> | undefined {
  if (!structured) {
    return undefined;
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: String(structured),
      strict: true,
      schema: getStructured(structured).jsonSchema,
    },
  };
}

// ── gateway headers ─────────────────────────────────

/**
 * Build optional HTTP-Referer / X-Title headers for OpenAI-compat gateways.
 * Used by OpenRouter (chat + speech) and local providers.
 */
function openAiGatewayHeaders(config: GatewayHeaderConfig): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (config.siteUrl) {
    headers['HTTP-Referer'] = config.siteUrl;
  }
  if (config.siteName) {
    headers['X-Title'] = config.siteName;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// ── exports ─────────────────────────────────────────

export type { GatewayHeaderConfig };
export {
  buildChatMessages,
  httpErrorEvent,
  openAiGatewayHeaders,
  resolveResponseFormat,
  wireTools,
};
