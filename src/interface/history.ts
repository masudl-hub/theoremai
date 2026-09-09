/**
 * Host conversation history — build `TurnHistoryMessage[]` from drafts, events, and transcript blocks.
 *
 * Uses kernel tool formatting so provider continuation matches `runTurn` / `invokeTool`.
 *
 * @module
 */

import { mediaKindForMime } from '../kernel/registry/catalog.ts';
import {
  formatToolFailureForModel,
  formatToolResult,
  projectForModel,
} from '../kernel/tools/execute.ts';
import { getTool } from '../kernel/tools/registry.ts';
import type { InteractionPart, TurnBlob, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import type { TranscriptBlock, UserTurnDraft } from './types.ts';

function toolCallId(tool: { name: string; callId?: string; id?: string }): string {
  return tool.id ?? tool.callId ?? `call_${tool.name}`;
}

function toolOutputForHistory(name: string, output: unknown): string {
  const registered = getTool(name);
  if (registered?.type === 'function') {
    return formatToolResult(projectForModel(registered, output));
  }
  if (typeof output === 'object' && output !== null && 'finding' in output) {
    return formatToolResult(output as { finding: string; data?: unknown });
  }
  return formatToolResult({ finding: JSON.stringify(output), data: output });
}

function blobToPart(blob: TurnBlob): InteractionPart {
  const kind = mediaKindForMime(blob.mimeType) ?? 'document';
  return { type: kind, mimeType: blob.mimeType, data: blob.data };
}

export type UserTurnHistoryMedia = {
  attachments?: TurnBlob[];
  voice?: TurnBlob[];
};

/**
 * Project a pending/composer draft into history messages for `onSteer` inject.
 * Uses base64 on `draft.attachments` / `draft.voice` when present.
 */
function userDraftToSteerInject(draft: UserTurnDraft): TurnHistoryMessage[] {
  const attachments = draft.attachments
    ?.filter(
      (a): a is typeof a & { data: string } => typeof a.data === 'string' && a.data.length > 0,
    )
    .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
  const voice = draft.voice
    ?.filter(
      (a): a is typeof a & { data: string } => typeof a.data === 'string' && a.data.length > 0,
    )
    .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
  return appendUserDraftToHistory(
    [],
    { text: draft.text },
    {
      ...(attachments?.length ? { attachments } : {}),
      ...(voice?.length ? { voice } : {}),
    },
  );
}

/** Append a user turn (text and optional encoded media) to host history. */
function appendUserDraftToHistory(
  history: TurnHistoryMessage[],
  draft: UserTurnDraft,
  media: UserTurnHistoryMedia = {},
): TurnHistoryMessage[] {
  const text = draft.text?.trim();
  const parts: InteractionPart[] = [];
  for (const blob of media.attachments ?? []) {
    parts.push(blobToPart(blob));
  }
  for (const blob of media.voice ?? []) {
    parts.push(blobToPart(blob));
  }
  if (text) {
    parts.push({ type: 'text', text });
  }
  if (parts.length === 0) {
    return history;
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return [...history, { role: 'user', content: text }];
  }
  return [...history, { role: 'user', parts }];
}

function appendToolExchangeToHistory(
  history: TurnHistoryMessage[],
  tool: {
    name: string;
    callId?: string;
    id?: string;
    arguments?: Record<string, unknown>;
    output: unknown;
  },
): TurnHistoryMessage[] {
  const callId = toolCallId(tool);
  return [
    ...history,
    {
      role: 'assistant',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.arguments ?? {}),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      name: tool.name,
      content: toolOutputForHistory(tool.name, tool.output),
    },
  ];
}

/** Record a host-side tool denial using kernel failure formatting. */
function appendToolDenialToHistory(
  history: TurnHistoryMessage[],
  tool: {
    name: string;
    callId?: string;
    id?: string;
    arguments?: Record<string, unknown>;
  },
): TurnHistoryMessage[] {
  const callId = toolCallId(tool);
  const failure = {
    code: 'denied',
    message: `User denied execution of '${tool.name}'.`,
  };
  return [
    ...history,
    {
      role: 'assistant',
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.arguments ?? {}),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      name: tool.name,
      content: formatToolResult(formatToolFailureForModel(failure)),
    },
  ];
}

/** Fold completed assistant turn events into provider-neutral history rows. */
function appendAssistantEventsToHistory(
  history: TurnHistoryMessage[],
  events: readonly TurnEvent[],
): TurnHistoryMessage[] {
  let next = history;
  let textBuf = '';

  const flushText = () => {
    if (!textBuf) {
      return;
    }
    next = [...next, { role: 'assistant', content: textBuf }];
    textBuf = '';
  };

  for (const event of events) {
    if (event.type === 'text') {
      textBuf += event.text ?? '';
      continue;
    }
    if (event.type === 'structured' && event.structured !== undefined) {
      flushText();
      next = [...next, { role: 'assistant', content: JSON.stringify(event.structured) }];
      continue;
    }
    if (
      event.type !== 'tool' ||
      event.tool?.phase !== 'complete' ||
      event.tool.output === undefined
    ) {
      continue;
    }
    flushText();
    next = appendToolExchangeToHistory(next, {
      name: event.tool.name,
      callId: event.tool.callId,
      id: event.tool.id,
      arguments: event.tool.arguments,
      output: event.tool.output,
    });
  }

  flushText();
  return next;
}

/**
 * Rebuild host history from committed transcript blocks (e.g. branch truncation).
 *
 * Text, structured, and completed tool blocks round-trip. Attachment/voice blocks
 * are omitted here — optional preview `data` on those blocks is UI-only and does
 * not rebuild into host history.
 */
function historyFromTranscriptBlocks(blocks: readonly TranscriptBlock[]): TurnHistoryMessage[] {
  let history: TurnHistoryMessage[] = [];

  for (const block of blocks) {
    if (block.kind === 'user-text') {
      history = appendUserDraftToHistory(history, { text: block.text });
      continue;
    }
    if (block.kind === 'text') {
      history = [...history, { role: 'assistant', content: block.text }];
      continue;
    }
    if (block.kind === 'structured') {
      history = [...history, { role: 'assistant', content: JSON.stringify(block.value) }];
      continue;
    }
    if (
      block.kind === 'tool' &&
      block.tool.phase === 'complete' &&
      block.tool.output !== undefined
    ) {
      history = appendToolExchangeToHistory(history, {
        name: block.tool.name,
        callId: block.tool.callId,
        id: block.tool.id,
        arguments: block.tool.arguments,
        output: block.tool.output,
      });
    }
  }

  return history;
}

export {
  appendAssistantEventsToHistory,
  appendToolDenialToHistory,
  appendToolExchangeToHistory,
  appendUserDraftToHistory,
  historyFromTranscriptBlocks,
  userDraftToSteerInject,
};
