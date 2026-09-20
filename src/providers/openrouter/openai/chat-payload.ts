/**
 * OpenAI-compatible chat payload builder.
 *
 * Converts THEOREM provider requests into OpenAI-compatible chat completion
 * payloads for OpenRouter and compatible gateways.
 *
 * Wire-format helpers (messages, tools, response format) are delegated to the
 * shared `openai/compat` module. This file owns OpenRouter-specific concerns:
 * plugins, web search, and the top-level payload shape.
 *
 * @module
 */

import { getTool } from '../../../kernel/tools/registry.ts';
import type { ProviderCompleteRequest } from '../../../kernel/types.ts';
import { cacheControlFromSpec } from '../cache-control.ts';
import { buildChatMessages, resolveResponseFormat, wireTools } from './compat.ts';

/** Convert a provider-neutral request into an OpenAI chat completion payload. */
function toOpenAiChatPayload(req: ProviderCompleteRequest): Record<string, unknown> {
  const messages = buildChatMessages(req);

  if (req.cache?.mode === 'system' && req.system) {
    const directive = cacheControlFromSpec(req.cache);
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const text =
        typeof messages[systemIdx].content === 'string'
          ? (messages[systemIdx].content as string)
          : '';
      messages[systemIdx] = {
        role: 'system',
        content: [{ type: 'text', text, cache_control: directive }],
      };
    }
  }

  const payload: Record<string, unknown> = {
    model: req.apiId,
    stream: true,
    messages,
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };

  if (req.thinking && req.thinking !== 'none') {
    payload.reasoning = { effort: req.thinking };
  }

  if (req.cache?.mode === 'automatic') {
    payload.cache_control = cacheControlFromSpec(req.cache);
  }

  if (req.sessionId) {
    payload.session_id = req.sessionId;
  }

  const responseFormat = resolveResponseFormat(req.structured);
  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const tools = wireTools(req.wireTools);
  if (tools) {
    payload.tools = tools;
  }

  const resolved = resolveOpenRouterPlugins(req.builtins);
  if (resolved.webSearch) {
    payload.web_search_options = {};
  }
  if (resolved.plugins.length > 0) {
    payload.plugins = resolved.plugins;
  }

  return payload;
}

interface ResolvedPlugins {
  plugins: Array<{ id: string }>;
  webSearch: boolean;
}

function resolveOpenRouterPlugins(builtins: readonly string[]): ResolvedPlugins {
  let webSearch = false;
  const plugins: Array<{ id: string }> = [];
  for (const id of builtins) {
    const entry = getTool(id);
    const pluginId = entry?.type === 'builtin' ? entry.wire.openRouter : undefined;
    if (!pluginId) continue;
    if (pluginId === 'web') {
      webSearch = true;
    } else {
      plugins.push({ id: pluginId });
    }
  }
  return { plugins, webSearch };
}

export type { ResolvedPlugins };
export { resolveOpenRouterPlugins, toOpenAiChatPayload };
