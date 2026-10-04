import { isAwaitingUserInput } from '../kernel/stages.ts';
import type { ToolGateAuth } from '../kernel/tools/gate-answer.ts';
import type { ToolGate, TurnToolSnapshot } from '../kernel/tools/types.ts';
import type { ModelId, ToolId, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';
import { historyFromTranscriptBlocks } from './history.ts';
import { toolCallsOf } from './tool-calls.ts';
import { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
import type { TranscriptBlock, UserTurnDraft } from './types.ts';

export type { ToolGateAuth };

/** A tool call held at a gate: the tool, its call id and arguments. */
export type GatedToolContext = {
  name: string;
  callId: string;
  arguments: Record<string, unknown>;
  /** The call's `ToolCallRequest.thoughtSignature`, for recording the call in history. */
  thoughtSignature?: string;
  gateKind: ToolGate['kind'];
  permission?: ToolGate['permission'];
  summary?: string;
  /** Set on a sign-in gate. */
  auth?: ToolGateAuth;
};

/** A tool call that paused the turn to ask the user: the tool, its call id and arguments. */
export type AwaitingToolContext = {
  name: string;
  callId: string;
  arguments: Record<string, unknown>;
  kind: string;
  prompt: string;
  options?: string[];
};

/** The state a client keeps between turns: history, interaction id and permissions. */
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

/** A session with no history and no permissions. */
function emptyInterfaceTurnSession(): InterfaceTurnSession {
  return {
    history: [],
    sessionPermissions: [],
    gatedTool: null,
    awaitingTool: null,
    assistantEvents: [],
    pendingUserDraft: null,
    promotedToolIds: [],
  };
}

/**
 * Every call still waiting on its gate, in the order the model made them. One
 * step can leave several: a gate holds only its own call.
 */
function gatedToolsFromEvents(events: readonly TurnEvent[]): GatedToolContext[] {
  const paused = events.some(
    (event) => event.type === 'done' && (event.stop.kind === 'gate' || event.stop.kind === 'tool'),
  );
  if (!paused) return [];
  return toolCallsOf(events).flatMap((call) => {
    if (call.state?.phase !== 'gate') return [];
    const { gate } = call.state;
    return [
      {
        name: call.name,
        callId: call.callId,
        arguments: call.arguments,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        gateKind: gate.kind,
        permission: gate.permission,
        summary: gate.summary,
        ...(gate.kind === 'auth'
          ? {
              auth: {
                slot: gate.authChallenge.slot,
                authType: gate.authChallenge.authType,
                service: gate.authChallenge.service,
              },
            }
          : {}),
      },
    ];
  });
}

/** The gate the user answers next: the first call still waiting. */
function gatedToolFromEvents(events: readonly TurnEvent[]): GatedToolContext | null {
  return gatedToolsFromEvents(events)[0] ?? null;
}

/** The tool call a turn paused on to ask the user, or `null`. */
function awaitingFromEvents(events: readonly TurnEvent[]): AwaitingToolContext | null {
  const call = findLast(toolCallsOf(events), (c) => c.state?.phase === 'complete');
  if (call?.state?.phase !== 'complete') return null;
  const { output } = call.state;
  if (!isAwaitingUserInput(output)) return null;
  return {
    name: call.name,
    callId: call.callId,
    arguments: call.arguments,
    kind: output.kind,
    prompt: output.prompt,
    options: output.options,
  };
}

/** The session after the turn events are applied to it. */
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
    if ((event.type === 'tokens' || event.type === 'done') && event.interactionId) {
      previousInteractionId = event.interactionId;
    }
    // A call's own input size, not the turn's sum (`done.tokens`).
    if (event.type === 'tokens' && event.tokens.input) {
      inputTokens = event.tokens.input;
    }
    if (event.type === 'done' && event.compaction?.tokens !== undefined) {
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
    awaitingTool: awaitingFromEvents(events),
    toolSnapshot,
    promotedToolIds,
  };
}

/** Drops `previousInteractionId` so the next turn sends the rebuilt history, not a stale handle. */
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
  awaitingFromEvents,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  gatedToolFromEvents,
  gatedToolsFromEvents,
};
