// invariant: A settled tool call replays its `readBack`, the text the model read, so provider continuation
// matches `runTurn` / `invokeTool`.

import { TheoremError } from '../guardrails/error.ts';
import { type LabelOverrides, labelText } from '../guardrails/labels.ts';
import { lateResultsMessage } from '../guardrails/tool-fence.ts';
import { stepReplyMessages } from '../kernel/interaction-parts.ts';
import { mediaKindForMime } from '../kernel/registry/catalog.ts';
import { formatToolFailureForModel, formatToolResult } from '../kernel/tools/model-text.ts';
import { keptReply, type ToolCallRequest } from '../kernel/turn-events.ts';
import type { InteractionPart, TurnBlob, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import { applyToolEvent, toolCallRanWith } from './tool-calls.ts';
import type { ToolCall, TranscriptBlock, UserTurnDraft } from './types.ts';

/**
 * The kernel sets `readBack` on every `complete`, `error` and `background` event, so a call without
 * it did not come from a run and has no text the model read.
 */
function toolReadBack(call: ToolCall): string {
  const state = call.state;
  if (
    (state?.phase !== 'complete' && state?.phase !== 'error' && state?.phase !== 'background') ||
    state.readBack === undefined
  ) {
    throw new TheoremError(
      'request',
      `Tool call '${call.name}' has no readBack: only a settled call from a run carries one.`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  return state.readBack;
}

function blobToPart(blob: TurnBlob): InteractionPart {
  const kind = mediaKindForMime(blob.mimeType) ?? 'document';
  return { type: kind, mimeType: blob.mimeType, data: blob.data };
}

/** The files a user turn adds to the history beside its text. */
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

/** For `onStage` inject. Uses base64 on `draft.attachments` / `draft.voice` when present. */
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

/** The history with the user's draft added as a user message. */
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
    ...stepReplyMessages({ text: '', calls: [tool] }),
    toolResultMessage(tool, content),
  ];
}

/** The history with a tool call and its result added. */
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
    ...(call.reasoning ? { reasoning: call.reasoning } : {}),
  };
}

/** The history with a denied tool call and the reason added. */
function appendToolDenialToHistory(
  history: TurnHistoryMessage[],
  tool: ToolCallRequest & {
    /** Override the default deny copy. */
    failure?: { code: string; message: string };
  },
  labels: LabelOverrides | undefined,
): TurnHistoryMessage[] {
  const failure = tool.failure ?? {
    code: 'denied',
    message: labelText('session.tool_denied', { tool: tool.name }, labels),
  };
  return appendToolCallPair(history, tool, formatToolResult(formatToolFailureForModel(failure)));
}

/** `undefined` while the call is open. */
function settledToolContent(call: ToolCall): string | undefined {
  const phase = call.state?.phase;
  return phase === 'complete' || phase === 'error' || phase === 'background'
    ? toolReadBack(call)
    : undefined;
}

/**
 * One model step: a single assistant message holding what the step wrote and
 * every settled call it made, with the reasoning written before them, then
 * each result, as a provider reads a step back. With `gated: 'open'`, a call
 * waiting on its gate joins the message too, left without a result. A step
 * whose calls are all left out keeps its words.
 */
function appendToolStepToHistory(
  history: TurnHistoryMessage[],
  step: { text: string; calls: readonly ToolCall[] },
  gated: GatedCalls = 'omit',
): TurnHistoryMessage[] {
  const { text, calls } = step;
  const entries = calls.flatMap((call): { tool: ToolCallRequest; content?: string }[] => {
    const content = settledToolContent(call);
    if (content !== undefined) return [{ tool: historyToolCall(call), content }];
    return gated === 'open' && call.state?.phase === 'gate'
      ? [{ tool: historyToolCall(call) }]
      : [];
  });
  return [
    ...history,
    ...stepReplyMessages({ text, calls: entries.map(({ tool }) => tool) }),
    ...entries.flatMap(({ tool, content }) =>
      content === undefined ? [] : [toolResultMessage(tool, content)],
    ),
  ];
}

/** Whether a call waiting on its gate enters history: left out, or open without a result. */
type GatedCalls = 'omit' | 'open';

/** The history with the assistant's reply from the turn events added. */
function appendAssistantEventsToHistory(
  history: TurnHistoryMessage[],
  events: readonly TurnEvent[],
): TurnHistoryMessage[] {
  return foldAssistantEvents(history, events, 'omit');
}

/**
 * A reply paused on its gates, as the model reads it when the user walks away:
 * its gated calls stay open in their step for the host to answer
 * (`answerOpenToolCalls`) before the user's next message.
 */
function appendPausedTurnToHistory(
  history: TurnHistoryMessage[],
  events: readonly TurnEvent[],
): TurnHistoryMessage[] {
  return foldAssistantEvents(history, events, 'open');
}

function foldAssistantEvents(
  history: TurnHistoryMessage[],
  events: readonly TurnEvent[],
  gated: GatedCalls,
): TurnHistoryMessage[] {
  let next = history;
  let textBuf = '';
  let step: { stepId: string | undefined; text: string; callKeys: string[] } | undefined;
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
    const stepCalls = step.callKeys.flatMap((id) => calls.get(id) ?? []);
    next = appendToolStepToHistory(next, { text: step.text, calls: stepCalls }, gated);
    step = undefined;
  };

  for (const event of keptReply(events)) {
    if (event.type === 'text') {
      flushStep();
      textBuf += event.text;
      continue;
    }
    if (event.type === 'late_results') {
      flushStep();
      flushText();
      next = [...next, lateResultsMessage(event.text, event.operationIds, event.inReply)];
      continue;
    }
    if (event.type === 'stage' && event.injected) {
      // why: A steer is a message in the conversation, after what the reply said and did before it.
      flushStep();
      flushText();
      next = [...next, ...event.injected.flatMap((inject) => inject.messages)];
      continue;
    }
    if (event.type === 'structured' && event.structured !== undefined) {
      flushStep();
      // why: The streamed text is this reply's JSON as the model wrote it; the structured output is the reply as kept.
      textBuf = '';
      next = [...next, { role: 'assistant', content: JSON.stringify(event.structured) }];
      continue;
    }
    if (event.type !== 'tool') {
      continue;
    }
    const key = event.tool.operationId ?? event.tool.callId;
    const call = applyToolEvent(calls.get(key), event.tool);
    calls.set(key, call);
    if (event.tool.phase !== undefined) {
      continue;
    }
    if (!step || call.stepId === undefined || step.stepId !== call.stepId) {
      flushStep();
      // why: The words written just before a step's calls are that step's reply: one message.
      step = { stepId: call.stepId, text: textBuf, callKeys: [] };
      textBuf = '';
    }
    step.callKeys.push(key);
  }

  flushStep();
  flushText();
  return next;
}

/** Attachment and voice blocks are omitted: their preview `data` is UI-only. */
function historyFromTranscriptBlocks(blocks: readonly TranscriptBlock[]): TurnHistoryMessage[] {
  let history: TurnHistoryMessage[] = [];
  let text = '';
  let step: { text: string; calls: ToolCall[] } = { text: '', calls: [] };
  const flushText = () => {
    if (text) history = [...history, { role: 'assistant', content: text }];
    text = '';
  };
  const flushStep = () => {
    if (step.calls.length) history = appendToolStepToHistory(history, step);
    step = { text: '', calls: [] };
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      const open = step.calls[0];
      if (open && (open.stepId === undefined || open.stepId !== block.tool.stepId)) flushStep();
      if (step.calls.length === 0) {
        // why: The words written just before a step's calls are that step's reply: one message.
        step.text = text;
        text = '';
      }
      step.calls.push(block.tool);
      continue;
    }
    flushStep();
    flushText();
    if (block.kind === 'user-text') {
      history = appendUserDraftToHistory(history, { text: block.text });
      continue;
    }
    if (block.kind === 'text') {
      text = block.text;
      continue;
    }
    if (block.kind === 'late-results') {
      history = [...history, lateResultsMessage(block.text, block.operationIds, block.inReply)];
      continue;
    }
    if (block.kind === 'structured') {
      history = [...history, { role: 'assistant', content: JSON.stringify(block.value) }];
    }
  }

  flushStep();
  flushText();
  return history;
}

function lastToolStep(
  history: readonly TurnHistoryMessage[],
): { at: number; calls: NonNullable<TurnHistoryMessage['tool_calls']> } | undefined {
  const at = history.findLastIndex((message) => message.tool_calls !== undefined);
  const calls = history[at]?.tool_calls;
  return calls ? { at, calls } : undefined;
}

/**
 * The calls the history leaves open: those of its last step with no result
 * after it, when nothing but results follows that step. Empty otherwise.
 */
function openToolCallIds(history: readonly TurnHistoryMessage[]): string[] {
  const step = lastToolStep(history);
  if (!step) return [];
  const after = history.slice(step.at + 1);
  if (after.some((message) => message.role !== 'tool')) return [];
  const answered = new Set(after.map((message) => message.tool_call_id));
  return step.calls.flatMap((call) => (answered.has(call.id) ? [] : [call.id]));
}

function openCallsMismatch(
  history: readonly TurnHistoryMessage[],
  ids: readonly string[],
): TheoremError {
  return new TheoremError(
    'request',
    `the history leaves open [${openToolCallIds(history).join(', ')}], not [${ids.join(', ')}]`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  );
}

/** Throws unless the history's open tool calls are exactly these ids. */
function assertOpenToolCalls(history: readonly TurnHistoryMessage[], ids: readonly string[]): void {
  const open = openToolCallIds(history);
  if (open.length !== ids.length || open.some((id) => !ids.includes(id))) {
    throw openCallsMismatch(history, ids);
  }
}

/**
 * `answers` holds, by call id, the text the model reads for each open call. Results follow their
 * step in the order the model made the calls. Throws unless `answers` names exactly the open calls.
 */
function answerOpenToolCalls(
  history: readonly TurnHistoryMessage[],
  answers: ReadonlyMap<string, string>,
): TurnHistoryMessage[] {
  const ids = [...answers.keys()];
  assertOpenToolCalls(history, ids);
  const step = lastToolStep(history);
  if (!step) return [...history];
  const results = new Map(
    history.slice(step.at + 1).map((message) => [message.tool_call_id, message]),
  );
  const resultOf = (call: { id: string; function: { name: string } }): TurnHistoryMessage => {
    const result = results.get(call.id);
    if (result) return result;
    const content = answers.get(call.id);
    if (content === undefined) throw openCallsMismatch(history, ids);
    return { role: 'tool', tool_call_id: call.id, name: call.function.name, content };
  };
  return [...history.slice(0, step.at + 1), ...step.calls.map(resultOf)];
}

export {
  answerOpenToolCalls,
  appendAssistantEventsToHistory,
  appendPausedTurnToHistory,
  appendToolDenialToHistory,
  appendToolExchangeToHistory,
  appendUserDraftToHistory,
  assertOpenToolCalls,
  historyFromTranscriptBlocks,
  toolReadBack,
  userDraftToSteerInject,
};
