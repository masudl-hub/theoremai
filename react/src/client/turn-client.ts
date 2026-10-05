import type { TurnEvent } from '@theoremjs/agents';
import {
  type AttachmentValidationIssue,
  type ComposerProfileInterface,
  foldTurnEvents,
  type GatedToolContext,
  type InterfaceTurnSession,
  prepareUserTurn,
  streamThoughtsEnabled,
  type TranscriptBlock,
  type UserTurnDraft,
} from '@theoremjs/agents/interface';
import { filesToPending } from './encode-files.ts';
import { defaultModel } from './generation-selection.ts';
import type {
  TheoremInvokeRequest,
  TheoremReplay,
  TheoremTurnInput,
  TheoremTurnRequest,
} from './transport.ts';

export function turnInputFromSession(
  session: InterfaceTurnSession,
  overrides: TheoremTurnInput = {},
): TheoremTurnInput {
  return {
    ...overrides,
    history: session.history,
    ...(session.inputTokens !== undefined ? { inputTokens: session.inputTokens } : {}),
    ...(session.historyTokens !== undefined ? { historyTokens: session.historyTokens } : {}),
  };
}

function resolveModelId(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
): string | undefined {
  return session.selectedModel ?? defaultModel(iface);
}

function resolveEffort(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  modelId: string | undefined,
): string | undefined {
  if (!modelId || !Object.hasOwn(iface.models, modelId)) return undefined;
  const binding = iface.models[modelId];
  if (!binding.allowEffortSelect) return undefined;
  return session.selectedEffort ?? binding.defaultEffort;
}

/** Model / effort selection the host should honour for this session. */
function generationFields(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
): { model?: string; effort?: string } {
  const modelId = resolveModelId(iface, session);
  const model = iface.allowModelSelect ? modelId : undefined;
  const effort = resolveEffort(iface, session, modelId);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** A gated call as the client holds it, for a host without a session (the playground). */
export type HeldCall = {
  name: string;
  /** The model's input to the call. */
  input: unknown;
  sessionPermissions?: string[];
};

function gateReplay(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  call: HeldCall,
): TheoremReplay {
  return {
    name: call.name,
    input: call.input,
    sessionPermissions: call.sessionPermissions ?? session.sessionPermissions,
    turnInput: turnInputFromSession(session),
    ...(session.toolSnapshot ? { snapshot: session.toolSnapshot } : {}),
    ...(session.promotedToolIds.length ? { promoted: [...session.promotedToolIds] } : {}),
    ...generationFields(iface, session),
  };
}

/**
 * The paused calls a message walks away from: their ids, and each call as a
 * host without a session replays it, from the session as it paused.
 */
function abandonFields(
  iface: ComposerProfileInterface,
  walkAway: WalkAway,
): { abandon: string[]; replays: Record<string, TheoremReplay> } | undefined {
  if (!walkAway.calls.length) return undefined;
  return {
    abandon: walkAway.calls.map((call) => call.callId),
    replays: Object.fromEntries(
      walkAway.calls.map((call) => [
        call.callId,
        gateReplay(iface, walkAway.paused, { name: call.name, input: call.arguments }),
      ]),
    ),
  };
}

/** A paused session, and the calls it waits on that a message walks away from. */
export type WalkAway = { paused: InterfaceTurnSession; calls: readonly GatedToolContext[] };

export function buildTurnRequest(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  input: TheoremTurnInput,
  options: { turnId?: string; walkAway?: WalkAway } = {},
): TheoremTurnRequest {
  const walked = options.walkAway ? abandonFields(iface, options.walkAway) : undefined;
  return {
    previousInteractionId: session.previousInteractionId,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...generationFields(iface, session),
    input,
    ...(walked ? { abandon: walked.abandon } : {}),
    replay: {
      sessionPermissions: session.sessionPermissions,
      ...(walked ? { abandon: walked.replays } : {}),
    },
  };
}

export function buildInvokeRequest(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  args: HeldCall & {
    gateId: string;
    decision: TheoremInvokeRequest['decision'];
    secret?: string;
  },
): TheoremInvokeRequest {
  return {
    gateId: args.gateId,
    decision: args.decision,
    ...(args.secret === undefined ? {} : { secret: args.secret }),
    replay: gateReplay(iface, session, args),
  };
}

export function projectUserTurn(
  iface: ComposerProfileInterface,
  draft: UserTurnDraft,
):
  | { ok: true; blocks: TranscriptBlock[]; draft: UserTurnDraft }
  | { ok: false; issues: AttachmentValidationIssue[] } {
  return prepareUserTurn(iface.inputs, draft, iface.guardrails);
}

export function prepareComposerTurn(
  iface: ComposerProfileInterface,
  text: string,
  pendingFiles: readonly File[],
  pendingVoice: readonly File[] = [],
): ReturnType<typeof projectUserTurn> {
  return projectUserTurn(iface, {
    ...(text.trim() ? { text } : {}),
    ...(pendingFiles.length ? { attachments: filesToPending(pendingFiles) } : {}),
    ...(pendingVoice.length ? { voice: filesToPending(pendingVoice) } : {}),
  });
}

export function foldAssistantTurn(
  iface: ComposerProfileInterface,
  events: readonly TurnEvent[],
): TranscriptBlock[] {
  // why: Its `turn-done` blocks stay: hidden in the view, they carry the reply's worked time.
  return foldTurnEvents(events, {
    showThoughts: streamThoughtsEnabled(iface.outputs),
  });
}
