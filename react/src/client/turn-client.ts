import { labelText, TheoremError, type TurnEvent } from '@theoremjs/agents';
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
import type { PagePart } from './tool-resume.ts';
import type {
  TheoremInvokeRequest,
  TheoremReplay,
  TheoremTurnInput,
  TheoremTurnRequest,
} from './transport.ts';

export function issuedOperationId(call: { operationId?: string }): string {
  if (!call.operationId) throw new TheoremError('request', labelText('session.gate_expired'));
  return call.operationId;
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

/** A gated call as the client holds it, for a host without a session (the studio). */
export type HeldCall = {
  name: string;
  /** The model's input to the call. */
  input: unknown;
  gateKind?: TheoremReplay['gateKind'];
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
    ...(call.gateKind ? { gateKind: call.gateKind } : {}),
    sessionPermissions: call.sessionPermissions ?? session.sessionPermissions,
    ...(session.toolSnapshot ? { snapshot: session.toolSnapshot } : {}),
    ...(session.promotedToolIds.length ? { promoted: [...session.promotedToolIds] } : {}),
    ...generationFields(iface, session),
  };
}

/** The calls a paused reply waits on that a message walks away from. */
export type WalkAway = { calls: readonly GatedToolContext[] };

/** Where a request goes on from: the ref of the conversation the host keeps, and the run's id for steers. */
export type RunScope = { conversation?: string; turnId?: string };

function scopeFields(scope: RunScope): RunScope {
  return {
    ...(scope.conversation ? { conversation: scope.conversation } : {}),
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
  };
}

export function buildTurnRequest(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  input: TheoremTurnInput,
  options: RunScope & { walkAway?: WalkAway } = {},
): TheoremTurnRequest {
  const abandon = (options.walkAway?.calls ?? []).map((call) => ({
    callId: call.callId,
    operationId: issuedOperationId(call),
  }));
  return {
    ...scopeFields(options),
    ...generationFields(iface, session),
    input,
    ...(abandon.length ? { abandon } : {}),
    replay: { sessionPermissions: session.sessionPermissions },
  };
}

export function buildInvokeRequest(
  iface: ComposerProfileInterface,
  session: InterfaceTurnSession,
  args: HeldCall & {
    gateId: string;
    operationId: string;
    decision: TheoremInvokeRequest['decision'];
    secret?: string;
    page?: PagePart;
  },
  scope: RunScope = {},
): TheoremInvokeRequest {
  return {
    ...scopeFields(scope),
    gateId: args.gateId,
    operationId: args.operationId,
    decision: args.decision,
    ...(args.secret === undefined ? {} : { secret: args.secret }),
    ...(args.page === undefined ? {} : { page: args.page }),
    replay: gateReplay(iface, session, {
      ...args,
      gateKind:
        args.gateKind ??
        (session.gatedTool?.callId === args.gateId ? session.gatedTool.gateKind : undefined),
    }),
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
