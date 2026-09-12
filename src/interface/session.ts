/**
 * Host turn session state for multi-turn runs and tool gate / awaiting.
 *
 * @module
 */

import { isAwaitingUserInput } from '../kernel/stages.ts';
import type { ToolGate, ToolPause, TurnToolSnapshot } from '../kernel/tools/types.ts';
import type { ModelId, ToolId, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import {
  appendAssistantEventsToHistory,
  appendToolDenialToHistory,
  historyFromTranscriptBlocks,
} from './history.ts';
import { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
import type { TranscriptBlock, UserTurnDraft } from './types.ts';

/** @deprecated Use `GatedToolContext`. */
export type PausedToolContext = GatedToolContext;

export type GatedToolContext = {
  name: string;
  input: unknown;
  callId?: string;
  arguments?: Record<string, unknown>;
  gateKind: ToolGate['kind'];
  permission?: ToolGate['permission'];
  summary?: string;
};

export type AwaitingToolContext = {
  name: string;
  callId?: string;
  arguments?: Record<string, unknown>;
  kind: string;
  prompt: string;
  options?: string[];
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
  /** Active pre_tool gate awaiting host resume. */
  gatedTool: GatedToolContext | null;
  /**
   * @deprecated Alias of `gatedTool` for Slice 3 react rename.
   */
  pausedTool: GatedToolContext | null;
  /** Completed ask_user (or similar) awaiting host UI — turn may already be done. */
  awaitingTool: AwaitingToolContext | null;
  /** Kernel events for the assistant segment still in flight (gate / resume / continue). */
  assistantEvents: TurnEvent[];
  /** User draft for the turn that produced `assistantEvents`. */
  pendingUserDraft: UserTurnDraft | null;
  /** Snapshot from the last gate `done` event — pass to `invokeTool({ snapshot })`. */
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
    gatedTool: null,
    pausedTool: null,
    awaitingTool: null,
    assistantEvents: [],
    pendingUserDraft: null,
    promotedToolIds: [],
  };
}

function gatedToolFromEvents(events: readonly TurnEvent[]): GatedToolContext | null {
  const done = events.findLast((event) => event.type === 'done');
  if (done?.stop?.kind !== 'gate' && done?.stop?.kind !== 'tool') {
    return null;
  }
  const gateEvent = events.findLast(
    (event) =>
      event.type === 'tool' &&
      ((event.tool?.phase === 'gate' && event.tool.gate) ||
        (event.tool?.phase === 'pause' && event.tool.pause)),
  );
  const tool = gateEvent?.tool;
  if (tool?.gate) {
    return {
      name: tool.name,
      input: tool.arguments ?? {},
      callId: tool.callId ?? tool.id,
      arguments: tool.arguments,
      gateKind: tool.gate.kind,
      permission: tool.gate.permission,
      summary: tool.gate.summary,
    };
  }
  if (tool?.pause) {
    const pause: ToolPause = tool.pause;
    const kind = pause.kind === 'interactive' ? 'confirmation' : (pause.kind as ToolGate['kind']);
    return {
      name: tool.name,
      input: pause.input,
      callId: tool.callId ?? tool.id,
      arguments: tool.arguments,
      gateKind: kind,
      permission: pause.permission,
      summary: pause.summary,
    };
  }
  return null;
}

/** @deprecated Use `gatedToolFromEvents`. */
function pausedToolFromEvents(events: readonly TurnEvent[]): GatedToolContext | null {
  return gatedToolFromEvents(events);
}

function awaitingFromEvents(events: readonly TurnEvent[]): AwaitingToolContext | null {
  const complete = events.findLast(
    (event) => event.type === 'tool' && event.tool?.phase === 'complete',
  );
  const output = complete?.tool?.output;
  if (!isAwaitingUserInput(output)) return null;
  return {
    name: complete?.tool?.name ?? '',
    callId: complete?.tool?.callId,
    arguments: complete?.tool?.arguments,
    kind: output.kind,
    prompt: output.prompt,
    options: output.options,
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

  const gated = gatedToolFromEvents(events);
  return {
    ...session,
    previousInteractionId,
    inputTokens,
    historyTokens,
    gatedTool: gated,
    pausedTool: gated,
    awaitingTool: awaitingFromEvents(events),
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

function markGatedToolCancelled(
  events: readonly TurnEvent[],
  gated: GatedToolContext,
): TurnEvent[] {
  return events.map((event) => {
    if (event.type !== 'tool') return event;
    if (event.tool?.phase !== 'gate' && event.tool?.phase !== 'pause') return event;
    return {
      type: 'tool' as const,
      tool: {
        ...event.tool,
        phase: 'error' as const,
        gate: undefined,
        pause: undefined,
        failure: {
          code: 'cancelled',
          message: `User cancelled gated tool '${gated.name}' to send a new message.`,
        },
      },
    };
  });
}

/**
 * Abandon a tool gate without continuing the agent turn.
 *
 * Records the cancelled tool in history, finalizes any streamed assistant text,
 * and clears gate state. Used by send-now while gated (leave the wait, then
 * start a new user turn).
 */
function abandonGatedToolSession(session: InterfaceTurnSession): {
  session: InterfaceTurnSession;
  finalizedEvents: TurnEvent[];
} {
  const gated = session.gatedTool ?? session.pausedTool;
  if (!gated) {
    return { session, finalizedEvents: [...session.assistantEvents] };
  }

  const finalizedEvents = markGatedToolCancelled(session.assistantEvents, gated);
  const history = appendToolDenialToHistory(
    appendAssistantEventsToHistory(session.history, finalizedEvents),
    {
      name: gated.name,
      callId: gated.callId,
      arguments: gated.arguments,
      failure: {
        code: 'cancelled',
        message: `User cancelled gated tool '${gated.name}' to send a new message.`,
      },
    },
  );

  return {
    finalizedEvents,
    session: {
      ...session,
      history,
      gatedTool: null,
      pausedTool: null,
      awaitingTool: null,
      assistantEvents: [],
      pendingUserDraft: null,
      toolSnapshot: undefined,
      promotedToolIds: [],
    },
  };
}

/** @deprecated Use `abandonGatedToolSession`. */
function abandonPausedToolSession(session: InterfaceTurnSession): {
  session: InterfaceTurnSession;
  finalizedEvents: TurnEvent[];
} {
  return abandonGatedToolSession(session);
}

export {
  abandonGatedToolSession,
  abandonPausedToolSession,
  applyTurnEventsToSession,
  awaitingFromEvents,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  gatedToolFromEvents,
  pausedToolFromEvents,
};
