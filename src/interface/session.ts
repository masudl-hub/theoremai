/**
 * Host turn session state for multi-turn runs and tool pause/resume.
 *
 * @module
 */

import type { ToolPause, TurnToolSnapshot } from '../kernel/tools/types.ts';
import type { ModelId, ToolId, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import { historyFromTranscriptBlocks } from './history.ts';
import { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
import type { TranscriptBlock, UserTurnDraft } from './types.ts';

export type PausedToolContext = {
  name: string;
  input: unknown;
  callId?: string;
  arguments?: Record<string, unknown>;
  pauseKind: ToolPause['kind'];
  permission?: ToolPause['permission'];
  interactiveOptions?: string[];
};

/** Client-side conversation state for composer turn runs. */
export type InterfaceTurnSession = {
  history: TurnHistoryMessage[];
  /** Google Interactions id for server-side continuity; cleared on branch. */
  previousInteractionId?: string;
  sessionPermissions: string[];
  /** Last turn `tokens.input` for compaction meter `timing: 'before'`. */
  inputTokens?: number;
  /** Host override for compaction meter `history`. */
  historyTokens?: number;
  pausedTool: PausedToolContext | null;
  /** Kernel events for the assistant segment still in flight (pause / resume / continue). */
  assistantEvents: TurnEvent[];
  /** User draft for the turn that produced `assistantEvents`. */
  pendingUserDraft: UserTurnDraft | null;
  /** Snapshot from the last tool-pause `done` event — pass to `invokeTool({ snapshot })`. */
  toolSnapshot?: TurnToolSnapshot;
  /** T2 tool ids promoted during the current assistant segment (loader `loaded` outputs). */
  promotedToolIds: ToolId[];
  /** User-selected model id when `allowModelSelect` is enabled on the profile. */
  selectedModel?: ModelId;
  /** Selected effort alias when the active model has `allowEffortSelect`. */
  selectedEffort?: string;
};

function emptyInterfaceTurnSession(): InterfaceTurnSession {
  return {
    history: [],
    sessionPermissions: [],
    pausedTool: null,
    assistantEvents: [],
    pendingUserDraft: null,
    promotedToolIds: [],
  };
}

function pausedToolFromEvents(events: readonly TurnEvent[]): PausedToolContext | null {
  const done = events.findLast((event) => event.type === 'done');
  if (done?.stop?.kind !== 'tool') {
    return null;
  }
  const pauseEvent = events.findLast(
    (event) => event.type === 'tool' && event.tool?.phase === 'pause' && event.tool.pause,
  );
  const tool = pauseEvent?.tool;
  if (!tool?.pause) {
    return null;
  }
  return {
    name: tool.name,
    input: tool.pause.input,
    callId: tool.id ?? tool.callId,
    arguments: tool.arguments,
    pauseKind: tool.pause.kind,
    permission: tool.pause.permission,
    interactiveOptions: tool.pause.render?.options,
  };
}

function applyTurnEventsToSession(
  session: InterfaceTurnSession,
  events: readonly TurnEvent[],
): InterfaceTurnSession {
  let previousInteractionId = session.previousInteractionId;
  let inputTokens = session.inputTokens;
  let historyTokens = session.historyTokens;
  let toolSnapshot = session.toolSnapshot;
  let promotedToolIds = session.promotedToolIds;

  for (const event of events) {
    if (event.interactionId) {
      previousInteractionId = event.interactionId;
    }
    if (event.tokens?.input) {
      inputTokens = event.tokens.input;
    }
    if (event.compaction?.tokens !== undefined) {
      historyTokens = event.compaction.tokens;
    }
  }

  const snapshotFromDone = toolSnapshotFromEvents(events);
  if (snapshotFromDone) {
    toolSnapshot = snapshotFromDone;
  }
  const newPromoted = promotedToolIdsFromEvents(events);
  if (newPromoted.length > 0) {
    promotedToolIds = [...new Set([...promotedToolIds, ...newPromoted])];
  }

  return {
    ...session,
    previousInteractionId,
    inputTokens,
    historyTokens,
    pausedTool: pausedToolFromEvents(events),
    toolSnapshot,
    promotedToolIds,
  };
}

/**
 * Truncate session after transcript branch.
 *
 * Rebuilds `history` from visible blocks and drops `previousInteractionId` so the
 * next turn uses manual history rather than a stale Interactions handle.
 */
function branchInterfaceTurnSession(
  session: InterfaceTurnSession,
  blocks: readonly TranscriptBlock[],
): InterfaceTurnSession {
  return {
    ...emptyInterfaceTurnSession(),
    history: historyFromTranscriptBlocks(blocks),
    sessionPermissions: [...session.sessionPermissions],
    inputTokens: session.inputTokens,
    historyTokens: session.historyTokens,
    selectedModel: session.selectedModel,
    selectedEffort: session.selectedEffort,
  };
}

export {
  applyTurnEventsToSession,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  pausedToolFromEvents,
};
