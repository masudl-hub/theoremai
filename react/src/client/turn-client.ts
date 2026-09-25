import type { TurnEvent } from '../../../mod.ts';
import {
	type AttachmentValidationIssue,
	type ComposerProfileInterface,
	foldTurnEvents,
	type InterfaceTurnSession,
	prepareUserTurn,
	streamThoughtsEnabled,
	type TranscriptBlock,
	type UserTurnDraft,
} from '../../../src/interface/mod.ts';
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

export function buildTurnRequest(
	iface: ComposerProfileInterface,
	session: InterfaceTurnSession,
	input: TheoremTurnInput,
	options: { turnId?: string } = {},
): TheoremTurnRequest {
	return {
		previousInteractionId: session.previousInteractionId,
		...(options.turnId ? { turnId: options.turnId } : {}),
		...generationFields(iface, session),
		input,
		replay: { sessionPermissions: session.sessionPermissions },
	};
}

export function buildInvokeRequest(
	iface: ComposerProfileInterface,
	session: InterfaceTurnSession,
	args: {
		gateId: string;
		name: string;
		input: unknown;
		resume?: TheoremReplay['resume'];
		sessionPermissions?: string[];
		secret?: string;
	},
): TheoremInvokeRequest {
	return {
		gateId: args.gateId,
		...(args.secret === undefined ? {} : { secret: args.secret }),
		replay: {
			name: args.name,
			input: args.input,
			resume: args.resume,
			sessionPermissions: args.sessionPermissions ?? session.sessionPermissions,
			turnInput: turnInputFromSession(session),
			...(session.toolSnapshot ? { snapshot: session.toolSnapshot } : {}),
			...(session.promotedToolIds.length ? { promoted: [...session.promotedToolIds] } : {}),
			...generationFields(iface, session),
		},
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
	return foldTurnEvents(events, {
		showThoughts: streamThoughtsEnabled(iface.outputs),
	}).filter((block) => block.kind !== 'turn-done');
}
