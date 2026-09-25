/**
 * Host turn session state for multi-turn runs and tool gate / awaiting.
 *
 * @module
 */

import { withPublicWording } from '../guardrails/error.ts';
import { type LexiconOverrides, lexiconText } from '../guardrails/lexicon.ts';
import type { ToolAuthType } from '../kernel/schema.ts';
import { isAwaitingUserInput } from '../kernel/stages.ts';
import type { ToolGate, TurnToolSnapshot } from '../kernel/tools/types.ts';
import type { ModelId, ToolId, TurnEvent, TurnHistoryMessage } from '../kernel/types.ts';
import { findLast } from '../kernel/util/find-last.ts';
import {
  appendAssistantEventsToHistory,
  appendToolDenialToHistory,
  historyFromTranscriptBlocks,
} from './history.ts';
import { promotedToolIdsFromEvents, toolSnapshotFromEvents } from './tool-invoke.ts';
import type { TranscriptBlock, UserTurnDraft } from './types.ts';

/** The credential a sign-in gate waits for: its slot and kind. */
export type ToolGateAuth = { slot: string; authType: ToolAuthType };

export type GatedToolContext = {
  name: string;
  input: unknown;
  callId?: string;
  arguments?: Record<string, unknown>;
  gateKind: ToolGate['kind'];
  permission?: ToolGate['permission'];
  summary?: string;
  /** Set on a sign-in gate. */
  auth?: ToolGateAuth;
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
    awaitingTool: null,
    assistantEvents: [],
    pendingUserDraft: null,
    promotedToolIds: [],
  };
}

function gatedToolFromEvents(events: readonly TurnEvent[]): GatedToolContext | null {
  const done = findLast(events, (event) => event.type === 'done');
  if (done?.stop?.kind !== 'gate' && done?.stop?.kind !== 'tool') {
    return null;
  }
  const gateEvent = findLast(
    events,
    (event) => event.type === 'tool' && event.tool?.phase === 'gate' && !!event.tool.gate,
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
      ...(tool.gate.authChallenge
        ? {
            auth: {
              slot: tool.gate.authChallenge.slot,
              authType: tool.gate.authChallenge.authType,
            },
          }
        : {}),
    };
  }
  return null;
}

function awaitingFromEvents(events: readonly TurnEvent[]): AwaitingToolContext | null {
  const complete = findLast(
    events,
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
  lexicon: LexiconOverrides | undefined,
): InterfaceTurnSession {
  return {
    ...emptyInterfaceTurnSession(),
    history: historyFromTranscriptBlocks(blocks, lexicon),
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
  lexicon: LexiconOverrides | undefined,
): TurnEvent[] {
  return events.map((event): TurnEvent => {
    if (event.type !== 'tool') return event;
    if (event.tool?.phase !== 'gate') return event;
    return withPublicWording(
      {
        type: 'tool',
        tool: {
          name: gated.name,
          callId: gated.callId ?? event.tool.callId,
          arguments: gated.arguments ?? event.tool.arguments,
          phase: 'error',
          failure: {
            code: 'cancelled',
            kind: 'cancelled',
            message: lexiconText('session.abandon_gated', { tool: gated.name }, lexicon),
          },
        },
      },
      lexicon,
    );
  });
}

/**
 * Abandon a tool gate without continuing the agent turn.
 *
 * Records the cancelled tool in history, finalizes any streamed assistant text,
 * and clears gate state. Used by send-now while gated (leave the wait, then
 * start a new user turn).
 */
function abandonGatedToolSession(
  session: InterfaceTurnSession,
  lexicon: LexiconOverrides | undefined,
): {
  session: InterfaceTurnSession;
  finalizedEvents: TurnEvent[];
} {
  const gated = session.gatedTool;
  if (!gated) {
    return { session, finalizedEvents: [...session.assistantEvents] };
  }

  const finalizedEvents = markGatedToolCancelled(session.assistantEvents, gated, lexicon);
  const history = appendToolDenialToHistory(
    appendAssistantEventsToHistory(session.history, finalizedEvents, lexicon),
    {
      name: gated.name,
      callId: gated.callId,
      arguments: gated.arguments,
      failure: {
        code: 'cancelled',
        message: lexiconText('session.abandon_gated', { tool: gated.name }, lexicon),
      },
    },
    lexicon,
  );

  return {
    finalizedEvents,
    session: {
      ...session,
      history,
      gatedTool: null,
      awaitingTool: null,
      assistantEvents: [],
      pendingUserDraft: null,
      toolSnapshot: undefined,
      promotedToolIds: [],
    },
  };
}

export {
  abandonGatedToolSession,
  applyTurnEventsToSession,
  awaitingFromEvents,
  branchInterfaceTurnSession,
  emptyInterfaceTurnSession,
  gatedToolFromEvents,
};
