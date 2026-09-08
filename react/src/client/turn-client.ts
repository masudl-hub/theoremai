import type { TurnEvent, TurnHistoryMessage, UserTurnDraft } from 'theorum';
import {
	type ComposerProfileInterface,
	foldTurnEvents,
	type InterfaceTurnSession,
	prepareUserTurn,
	streamThoughtsEnabled,
	type TranscriptBlock,
} from 'theorum/interface';
import type { ToolCredential, TurnToolSnapshot } from 'theorum/kernel';
import { filesToPending } from './encode-files';
import type { PlaygroundRunPayload } from './run-payload';

export type TurnRequestBody = {
	profile: PlaygroundRunPayload['profile'];
	customTools: PlaygroundRunPayload['customTools'];
	structured?: PlaygroundRunPayload['structured'];
	previousInteractionId?: string;
	sessionPermissions?: string[];
	model?: string;
	effort?: string;
	input: {
		text?: string;
		attachments?: Array<{ name: string; mimeType: string; data: string }>;
		voice?: Array<{ name: string; mimeType: string; data: string }>;
		history?: TurnHistoryMessage[];
		historyTokens?: number;
		inputTokens?: number;
	};
};

export type InvokeRequestBody = {
	profile: PlaygroundRunPayload['profile'];
	customTools: PlaygroundRunPayload['customTools'];
	structured?: PlaygroundRunPayload['structured'];
	name: string;
	input: unknown;
	resume?: { value?: unknown; granted?: boolean };
	sessionPermissions?: string[];
	credentials?: Record<string, ToolCredential>;
	turnInput?: TurnRequestBody['input'];
	snapshot?: TurnToolSnapshot;
	promoted?: string[];
	model?: string;
	effort?: string;
	path?: string;
};

export function turnInputFromSession(
	session: InterfaceTurnSession,
	overrides: TurnRequestBody['input'] = {},
): TurnRequestBody['input'] {
	return {
		...overrides,
		history: session.history,
		...(session.inputTokens !== undefined ? { inputTokens: session.inputTokens } : {}),
		...(session.historyTokens !== undefined ? { historyTokens: session.historyTokens } : {}),
	};
}

export function buildTurnRequestBody(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
	input: TurnRequestBody['input'],
): TurnRequestBody {
	const modelId = resolveTurnModelId(payload, session);
	const model = payload.profile.allowModelSelect ? modelId : undefined;
	const effort = resolveTurnEffort(payload, session, modelId);
	return {
		profile: payload.profile,
		customTools: payload.customTools,
		structured: payload.structured,
		previousInteractionId: session.previousInteractionId,
		sessionPermissions: session.sessionPermissions,
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		input,
	};
}

function resolveTurnEffort(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
	modelId: string | undefined,
): string | undefined {
	if (!modelId) return undefined;
	const models = payload.profile.models;
	if (!Object.hasOwn(models, modelId)) return undefined;
	const binding = models[modelId];
	if (!binding.allowEffortSelect) return undefined;
	return session.selectedEffort ?? binding.defaultEffort;
}

function resolveTurnModelId(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
): string | undefined {
	return (
		session.selectedModel ?? payload.profile.defaultModel ?? Object.keys(payload.profile.models)[0]
	);
}

function resolveTurnModel(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
): string | undefined {
	if (!payload.profile.allowModelSelect) return undefined;
	return resolveTurnModelId(payload, session);
}

export function buildInvokeRequestBody(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
	args: {
		name: string;
		input: unknown;
		resume?: InvokeRequestBody['resume'];
		sessionPermissions?: string[];
		credentials?: Record<string, ToolCredential>;
	},
): InvokeRequestBody {
	const model = resolveTurnModel(payload, session);
	const modelId = resolveTurnModelId(payload, session);
	const effort = resolveTurnEffort(payload, session, modelId);
	return {
		profile: payload.profile,
		customTools: payload.customTools,
		structured: payload.structured,
		name: args.name,
		input: args.input,
		resume: args.resume,
		sessionPermissions: args.sessionPermissions ?? session.sessionPermissions,
		credentials: args.credentials,
		turnInput: turnInputFromSession(session),
		...(session.toolSnapshot ? { snapshot: session.toolSnapshot } : {}),
		...(session.promotedToolIds.length ? { promoted: [...session.promotedToolIds] } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
	};
}

export function projectUserTurn(
	iface: ComposerProfileInterface,
	draft: UserTurnDraft,
): { ok: true; blocks: TranscriptBlock[]; draft: UserTurnDraft } | { ok: false; issues: string[] } {
	const prepared = prepareUserTurn(iface.inputs, draft, iface.guardrails);
	if (!prepared.ok) {
		return { ok: false, issues: prepared.issues.map((issue) => issue.message) };
	}
	return { ok: true, blocks: prepared.blocks, draft: prepared.draft };
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

function parseStreamEvent(line: string): TurnEvent {
	const event = JSON.parse(line) as TurnEvent | { type: 'error'; error: string };
	if (event.type === 'error') {
		throw new Error(event.error);
	}
	return event;
}

async function readNdjsonStream(
	response: Response,
	onEvent: (event: TurnEvent) => void,
): Promise<void> {
	if (!response.body) {
		throw new Error('Stream missing body');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			onEvent(parseStreamEvent(line));
		}
	}

	const tail = buffer.trim();
	if (tail) {
		onEvent(parseStreamEvent(tail));
	}
}

async function postJsonNdjson(
	url: string,
	body: unknown,
	onEvent: (event: TurnEvent) => void,
	failureLabel: string,
): Promise<void> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const payload = (await response.json()) as { error?: string };
		throw new Error(payload.error ?? `${failureLabel} (${String(response.status)})`);
	}
	await readNdjsonStream(response, onEvent);
}

export async function streamPlaygroundTurn(
	body: TurnRequestBody,
	onEvent: (event: TurnEvent) => void,
): Promise<void> {
	await postJsonNdjson('/api/playground/turn', body, onEvent, 'Turn failed');
}

export async function streamPlaygroundInvoke(
	body: InvokeRequestBody,
	onEvent: (event: TurnEvent) => void,
): Promise<void> {
	await postJsonNdjson('/api/playground/invoke', body, onEvent, 'Invoke failed');
}
