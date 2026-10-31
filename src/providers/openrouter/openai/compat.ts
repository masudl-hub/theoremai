import {
  kindOfHttpStatus,
  type ProducedError,
  TheoremError,
  toErrorEvent,
} from '../../../guardrails/error.ts';
import { asRecord } from '../../../kernel/engine/record.ts';
import { historyMessageParts, isMediaRefPart } from '../../../kernel/interaction-parts.ts';
import type {
  InteractionMediaPart,
  InteractionMediaRefPart,
  InteractionPart,
  ModelRequest,
  ResolvedStructured,
  TurnHistoryMessage,
  WireFunctionTool,
} from '../../../kernel/types.ts';
import {
  withCarriedAssistantFiles,
  withCarriedToolFiles,
} from '../../shared/carried-tool-files.ts';
import { historyToolIdentity } from '../../shared/tool-args.ts';

/** The fields Chat Completions gives every error; any other field is the provider's own detail. */
const STANDARD_ERROR_FIELDS: ReadonlySet<string> = new Set(['message', 'type', 'param', 'code']);

/**
 * Why a Chat Completions body says the call failed: its `error.message`, then the provider's own
 * fields (OpenRouter's `metadata.raw` names the upstream reason), else the raw body.
 */
function statedError(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  const error = asRecord(asRecord(body)?.error);
  if (!error) return body === undefined || body === null ? undefined : JSON.stringify(body);
  const own = Object.fromEntries(
    Object.entries(error).filter(([key]) => !STANDARD_ERROR_FIELDS.has(key)),
  );
  const said = typeof error.message === 'string' && error.message ? [error.message] : [];
  const more = Object.keys(own).length > 0 ? [JSON.stringify(own)] : [];
  return [...said, ...more].join(' ') || JSON.stringify(error);
}

/** A refused Chat Completions call, its kind from the status and its stated reason in the message. */
function httpError(failure: { status: number; body: unknown }, label: string): TheoremError {
  const detail = statedError(failure.body);
  const head = `${label} HTTP ${String(failure.status)}`;
  return new TheoremError(kindOfHttpStatus(failure.status), detail ? `${head}: ${detail}` : head);
}

async function httpErrorEvent(res: Response, label: string): Promise<ProducedError> {
  const text = (await res.text()).trim();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // why: Not JSON: the raw body is the detail.
  }
  return toErrorEvent(httpError({ status: res.status, body }, label));
}

interface GatewayHeaderConfig {
  siteUrl?: string;
  siteName?: string;
}

function rejectMediaRef(
  part: InteractionPart,
): asserts part is Exclude<InteractionPart, InteractionMediaRefPart> {
  if (isMediaRefPart(part)) {
    throw new TheoremError('unsupported', 'media references are not supported on openAi');
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

/** Text-only input collapses to one string; mixed input is a content-part array. */
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
    return {
      type: 'file',
      file: {
        filename: part.type === 'video' ? 'clip.bin' : 'document.bin',
        file_data: `data:${part.mimeType};base64,${part.data}`,
      },
    };
  });
}

/** Assistant `tool_calls` are rebuilt to strip non-standard fields. */
function wireHistoryMessage(msg: TurnHistoryMessage): Record<string, unknown> {
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

// why: A PDF inside a `role: 'tool'` message was accepted and never read, and was read from the user message after it; a photo inside one was read (live, 13/10/2026, google/gemini-3.5-flash-lite).
const TOOL_MESSAGE_PART_TYPES: ReadonlySet<InteractionPart['type']> = new Set(['text', 'image']);

/** `includeSystem: false` when the caller passes system text separately (AI SDK `instructions`). */
function buildChatMessages(
  req: Pick<ModelRequest, 'system' | 'history' | 'input'>,
  options?: { includeSystem?: boolean },
): Record<string, unknown>[] {
  const includeSystem = options?.includeSystem !== false;
  const messages: Record<string, unknown>[] = [];
  if (includeSystem && req.system) {
    messages.push({ role: 'system', content: req.system });
  }
  // why: Chat Completions takes only text and refusals in assistant content, and endpoints that enforce it refuse the call.
  const history = withCarriedAssistantFiles(req.history ?? []);
  for (const h of withCarriedToolFiles(history, TOOL_MESSAGE_PART_TYPES)) {
    messages.push(wireHistoryMessage(h));
  }
  if (req.input.length > 0) {
    messages.push({
      role: 'user',
      content: wireMessageContent(req.input),
    });
  }
  return messages;
}

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

/** OpenAI takes a schema name of at most 64 of `[A-Za-z0-9_-]` and refuses the call otherwise. */
function schemaName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function resolveResponseFormat(
  structured: ResolvedStructured | null,
): Record<string, unknown> | undefined {
  if (!structured) {
    return undefined;
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: schemaName(structured.id),
      strict: true,
      schema: structured.jsonSchema,
    },
  };
}

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

export type { GatewayHeaderConfig };
export {
  buildChatMessages,
  httpError,
  httpErrorEvent,
  openAiGatewayHeaders,
  resolveResponseFormat,
  statedError,
  wireTools,
};
