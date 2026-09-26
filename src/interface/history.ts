/**
 * Host conversation history — build `TurnHistoryMessage[]` from drafts, events, and transcript blocks.
 *
 * A settled tool call replays its `readBack`, the text the model read, so provider
 * continuation matches `runTurn` / `invokeTool`.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import { type LexiconOverrides, lexiconText } from '../guardrails/lexicon.ts';
import { mediaKindForMime } from '../kernel/registry/catalog.ts';
import { formatToolFailureForModel, formatToolResult } from '../kernel/tools/model-text.ts';
import type { ToolCallRequest } from '../kernel/turn-events.ts';
import type { InteractionPart, TurnBlob, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import { applyToolEvent, toolCallRanWith } from './tool-calls.ts';
import type { ToolCall, TranscriptBlock, UserTurnDraft } from './types.ts';

/**
 * The `readBack` of a settled tool call. The kernel sets it on every `complete` and `error`
 * event, so one without it did not come from a run and has no text the model read.
 */
function toolReadBack(call: ToolCall): string {
  const state = call.state;
  if ((state?.phase !== 'complete' && state?.phase !== 'error') || state.readBack === undefined) {
    throw new TheoremError(
      'request',
      `Tool call '${call.name}' has no readBack: only a settled call from a run carries one.`, // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return state.readBack;
}

/** The call as history records it: its name, id, and the arguments it ran with. */

function blobToPart(blob: TurnBlob): InteractionPart {
  const kind = mediaKindForMime(blob.mimeType) ?? 'document';
  return { type: kind, mimeType: blob.mimeType, data: blob.data };
}

export type UserTurnHistoryMedia = {
  attachments?: TurnBlob[];
  voice?: TurnBlob[];
};

function draftBlobsWithData(
  blobs: UserTurnDraft['attachments'] | UserTurnDraft['voice'],
): TurnBlob[] | undefined {
  const mapped = blobs
    ?.filter(
      (a): a is typeof a & { data: string } => typeof a.data === 'string' && a.data.length > 0,
    )
    .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
  return mapped?.length ? mapped : undefined;
}

/**
 * Project a pending/composer draft into history messages for `onStage` inject.
 * Uses base64 on `draft.attachments` / `draft.voice` when present.
 */
function userDraftToSteerInject(draft: UserTurnDraft): TurnHistoryMessage[] {
  const attachments = draftBlobsWithData(draft.attachments);
  const voice = draftBlobsWithData(draft.voice);
  return appendUserDraftToHistory(
    [],
    { text: draft.text },
    {
      ...(attachments ? { attachments } : {}),
      ...(voice ? { voice } : {}),
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

/** The call as an assistant message's `tool_calls` entry. */
function toolCallEntry(tool: ToolCallRequest) {
  return {
    id: tool.callId,
    type: 'function' as const,
    function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
    ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}),
  };
}

function toolResultMessage(tool: ToolCallRequest, content: string): TurnHistoryMessage {
  return { role: 'tool', tool_call_id: tool.callId, name: tool.name, content };
}

function appendToolCallPair(
  history: TurnHistoryMessage[],
  tool: ToolCallRequest,
  content: string,
): TurnHistoryMessage[] {
  return [
    ...history,
    { role: 'assistant', tool_calls: [toolCallEntry(tool)] },
    toolResultMessage(tool, content),
  ];
}

/** Record a completed call and its `readBack`: what the model read. */
function appendToolExchangeToHistory(
  history: TurnHistoryMessage[],
  call: ToolCall,
): TurnHistoryMessage[] {
  return appendToolCallPair(history, historyToolCall(call), toolReadBack(call));
}

function historyToolCall(call: ToolCall): ToolCallRequest {
  return {
    name: call.name,
    callId: call.callId,
    arguments: toolCallRanWith(call),
    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
  };
}

/** Record a host-side tool denial using kernel failure formatting. */
function appendToolDenialToHistory(
  history: TurnHistoryMessage[],
  tool: ToolCallRequest & {
    /** Override default deny copy (e.g. send-now cancel while gated). */
    failure?: { code: string; message: string };
  },
  lexicon: LexiconOverrides | undefined,
): TurnHistoryMessage[] {
  const failure = tool.failure ?? {
    code: 'denied',
    message: lexiconText('session.tool_denied', { tool: tool.name }, lexicon),
  };
  return appendToolCallPair(history, tool, formatToolResult(formatToolFailureForModel(failure)));
}

/** What the model reads for a settled call: its `readBack`. Undefined while it is open. */
function settledToolContent(call: ToolCall): string | undefined {
  const phase = call.state?.phase;
  return phase === 'complete' || phase === 'error' ? toolReadBack(call) : undefined;
}

/**
 * One model step's settled calls: a single assistant message holding every call
 * the step made, then each result. Google replays a step's calls only this way,
 * with the step's thought signature on its first call.
 */
function appendToolStepToHistory(
  history: TurnHistoryMessage[],
  calls: readonly ToolCall[],
): TurnHistoryMessage[] {
  const settled = calls.flatMap((call) => {
    const content = settledToolContent(call);
    return content === undefined ? [] : [{ tool: historyToolCall(call), content }];
  });
  if (settled.length === 0) return history;
  return [
    ...history,
    { role: 'assistant', tool_calls: settled.map(({ tool }) => toolCallEntry(tool)) },
    ...settled.map(({ tool, content }) => toolResultMessage(tool, content)),
  ];
}

/** Fold completed assistant turn events into provider-neutral history rows. */
function appendAssistantEventsToHistory(
  history: TurnHistoryMessage[],
  events: readonly TurnEvent[],
): TurnHistoryMessage[] {
  let next = history;
  let textBuf = '';
  // The calls of the step being read, in the order the model made them.
  let step: { stepId: string | undefined; callIds: string[] } | undefined;
  const calls = new Map<string, ToolCall>();

  const flushText = () => {
    if (!textBuf) {
      return;
    }
    next = [...next, { role: 'assistant', content: textBuf }];
    textBuf = '';
  };
  const flushStep = () => {
    if (!step) {
      return;
    }
    const stepCalls = step.callIds.flatMap((id) => calls.get(id) ?? []);
    next = appendToolStepToHistory(next, stepCalls);
    step = undefined;
  };

  for (const event of events) {
    if (event.type === 'text') {
      flushStep();
      textBuf += event.text;
      continue;
    }
    if (event.type === 'structured' && event.structured !== undefined) {
      flushStep();
      flushText();
      next = [...next, { role: 'assistant', content: JSON.stringify(event.structured) }];
      continue;
    }
    if (event.type !== 'tool') {
      continue;
    }
    const call = applyToolEvent(calls.get(event.tool.callId), event.tool);
    calls.set(call.callId, call);
    if (event.tool.phase !== undefined) {
      continue;
    }
    // A call opens its step, or joins the one it was made with.
    if (!step || call.stepId === undefined || step.stepId !== call.stepId) {
      flushStep();
      flushText();
      step = { stepId: call.stepId, callIds: [] };
    }
    step.callIds.push(call.callId);
  }

  flushStep();
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
  // Consecutive tool blocks from one model step replay together.
  let step: ToolCall[] = [];
  const flushStep = () => {
    history = appendToolStepToHistory(history, step);
    step = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      const open = step[0];
      if (open && (open.stepId === undefined || open.stepId !== block.tool.stepId)) flushStep();
      step.push(block.tool);
      continue;
    }
    flushStep();
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
    }
  }

  flushStep();
  return history;
}

export {
  appendAssistantEventsToHistory,
  appendToolDenialToHistory,
  appendToolExchangeToHistory,
  appendUserDraftToHistory,
  historyFromTranscriptBlocks,
  toolReadBack,
  userDraftToSteerInject,
};
