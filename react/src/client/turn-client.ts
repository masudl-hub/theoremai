import type { TurnEvent, TurnHistoryMessage } from 'theorum';
import {
	type ComposerProfileInterface,
	foldTurnEvents,
	type InterfaceTurnSession,
	prepareUserTurn,
	streamThoughtsEnabled,
	type TranscriptBlock,
	type UserTurnDraft,
} from '../../../src/interface/mod.ts';
import type { ToolCredential, TurnToolSnapshot } from 'theorum/kernel';
import { attachmentIssueText } from './attachment-issues';
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
	/** Host-generated id so the client can post mid-turn steers. */
	turnId?: string;
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

type ModelProfileDefinition = Extract<PlaygroundRunPayload['profile'], { models: unknown }>;

function modelProfile(
	profile: PlaygroundRunPayload['profile'],
): ModelProfileDefinition | null {
	return 'models' in profile ? profile : null;
}

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
	options: { turnId?: string } = {},
): TurnRequestBody {
	const profile = modelProfile(payload.profile);
	const modelId = resolveTurnModelId(payload, session);
	const model = profile?.allowModelSelect ? modelId : undefined;
	const effort = resolveTurnEffort(payload, session, modelId);
	return {
		profile: payload.profile,
		customTools: payload.customTools,
		structured: payload.structured,
		previousInteractionId: session.previousInteractionId,
		sessionPermissions: session.sessionPermissions,
		...(options.turnId ? { turnId: options.turnId } : {}),
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
	const profile = modelProfile(payload.profile);
	if (!profile) return undefined;
	const models = profile.models;
	if (!Object.hasOwn(models, modelId)) return undefined;
	const binding = models[modelId];
	if (!binding.allowEffortSelect) return undefined;
	return session.selectedEffort ?? binding.defaultEffort;
}

function resolveTurnModelId(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
): string | undefined {
	const profile = modelProfile(payload.profile);
	return profile
		? session.selectedModel ?? profile.defaultModel ?? Object.keys(profile.models)[0]
		: undefined;
}

function resolveTurnModel(
	payload: PlaygroundRunPayload,
	session: InterfaceTurnSession,
): string | undefined {
	const profile = modelProfile(payload.profile);
	if (!profile?.allowModelSelect) return undefined;
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
		return { ok: false, issues: prepared.issues.map(attachmentIssueText) };
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
	const event = JSON.parse(line) as TurnEvent | {
		type: 'error';
		error?: string;
		errorInternal?: string;
	};
	if (event.type === 'error') {
		throw playgroundStreamError(event);
	}
	return event;
}

/** Public-safe stream failure with optional internal detail for playground hover. */
export class PlaygroundStreamError extends Error {
	readonly publicMessage: string;
	readonly internalMessage?: string;

	constructor(publicMessage: string, internalMessage?: string) {
		super(publicMessage);
		this.name = 'PlaygroundStreamError';
		this.publicMessage = publicMessage;
		if (internalMessage) this.internalMessage = internalMessage;
	}
}

function playgroundStreamError(event: {
	error?: string;
	errorInternal?: string;
}): PlaygroundStreamError {
	const pub = typeof event.error === 'string' ? event.error.trim() : '';
	const internal = typeof event.errorInternal === 'string' ? event.errorInternal.trim() : '';
	const publicMessage = pub || 'Something went wrong. Try again.';
	const internalMessage =
		internal && internal !== publicMessage ? internal : undefined;
	return new PlaygroundStreamError(publicMessage, internalMessage);
}

export function isPlaygroundStreamError(err: unknown): err is PlaygroundStreamError {
	return err instanceof PlaygroundStreamError;
}

export function playgroundFailureFromError(err: unknown): {
	ok: false;
	error: string;
	errorInternal?: string;
} {
	if (isPlaygroundStreamError(err)) {
		return {
			ok: false,
			error: err.publicMessage,
			...(err.internalMessage ? { errorInternal: err.internalMessage } : {}),
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { ok: false, error: message };
}

export function isAbortError(err: unknown): boolean {
	return (
		(err instanceof DOMException && err.name === 'AbortError') ||
		(err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message)))
	);
}

async function readNdjsonStream(
	response: Response,
	onEvent: (event: TurnEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.body) {
		throw new Error('Stream missing body');
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const onAbort = () => {
		void reader.cancel();
	};
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		for (;;) {
			if (signal?.aborted) {
				throw new DOMException('The operation was aborted.', 'AbortError');
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer = flushNdjsonChunk(buffer + decoder.decode(value, { stream: true }), onEvent);
		}
		const tail = buffer.trim();
		if (tail) onEvent(parseStreamEvent(tail));
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

function flushNdjsonChunk(buffer: string, onEvent: (event: TurnEvent) => void): string {
	const lines = buffer.split('\n');
	const rest = lines.pop() ?? '';
	for (const line of lines) {
		if (!line.trim()) continue;
		onEvent(parseStreamEvent(line));
	}
	return rest;
}

async function postJsonNdjson(
	url: string,
	body: unknown,
	onEvent: (event: TurnEvent) => void,
	failureLabel: string,
	signal?: AbortSignal,
): Promise<void> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (isAbortError(err)) {
			throw new DOMException('The operation was aborted.', 'AbortError');
		}
		throw err;
	}
	if (!response.ok) {
		const payload = (await response.json()) as { error?: string };
		throw new Error(payload.error ?? `${failureLabel} (${String(response.status)})`);
	}
	await readNdjsonStream(response, onEvent, signal);
}

export async function streamPlaygroundTurn(
	body: TurnRequestBody,
	onEvent: (event: TurnEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	await postJsonNdjson('/api/playground/turn', body, onEvent, 'Turn failed', signal);
}

export async function streamPlaygroundInvoke(
	body: InvokeRequestBody,
	onEvent: (event: TurnEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	await postJsonNdjson('/api/playground/invoke', body, onEvent, 'Invoke failed', signal);
}

/** Push a steer inject into the active turn or live session inbox. */
export async function postPlaygroundSteer(args: {
	inject: TurnHistoryMessage[];
	turnId?: string;
	sessionId?: string;
}): Promise<void> {
	const turnId = args.turnId?.trim();
	const sessionId = args.sessionId?.trim();
	if (!turnId && !sessionId) {
		throw new Error('turnId or sessionId is required');
	}
	const response = await fetch('/api/playground/turn/steer', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			inject: args.inject,
			...(sessionId ? { sessionId } : { turnId }),
		}),
	});
	if (!response.ok) {
		const payload = (await response.json()) as { error?: string };
		throw new Error(payload.error ?? `Steer failed (${String(response.status)})`);
	}
}
