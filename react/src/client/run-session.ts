import {
	abandonGatedToolSession,
	appendToolDenialToHistory,
	appendToolExchangeToHistory,
	applyTurnEventsToSession,
	type ComposerProfileInterface,
	gatedToolFromEvents,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';
import type { ToolCredential } from 'theorum/kernel';
import { lexiconText } from 'theorum';
import { attachPreviewData, encodeFiles } from './encode-files';
import { continueAfterTool, finalizeTurnStream, streamFoldedTurn, toTurnMedia } from './run-commit';
import type { PlaygroundRunPayload } from './run-payload';
import {
	applyToolDecisionToSessionPermissions,
	buildInvokeToolResume,
	type ToolDecisionAction,
} from './tool-resume';
import {
	buildInvokeRequestBody,
	buildTurnRequestBody,
	foldAssistantTurn,
	isAbortError,
	playgroundFailureFromError,
	prepareComposerTurn,
	projectUserTurn,
	streamPlaygroundInvoke,
	streamPlaygroundTurn,
	turnInputFromSession,
} from './turn-client';

export type TurnFailure = {
	ok: false;
	error: string;
	errorInternal?: string;
	issues?: string[];
	aborted?: boolean;
};

function turnFailureFromCaught(err: unknown, signal?: AbortSignal): TurnFailure {
	if (isAbortError(err) || signal?.aborted) {
		return { ok: false, error: 'Cancelled', aborted: true };
	}
	return playgroundFailureFromError(err);
}

function sessionHasGatedTool(session: InterfaceTurnSession): boolean {
	return session.gatedTool !== null;
}

export type StreamTurnSuccess = {
	ok: true;
	session: InterfaceTurnSession;
	userBlocks: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
};

type PreparedUserTurn = {
	ok: true;
	draft: import('../../../src/interface/mod.ts').UserTurnDraft;
	blocks: TranscriptBlock[];
};

async function streamPreparedInterfaceTurn(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	prepared: PreparedUserTurn;
	encodedAttachments?: Awaited<ReturnType<typeof encodeFiles>>;
	encodedVoice?: Awaited<ReturnType<typeof encodeFiles>>;
	onStream: (blocks: TranscriptBlock[]) => void;
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
}): Promise<StreamTurnSuccess | TurnFailure> {
	const media = toTurnMedia(args.encodedAttachments, args.encodedVoice);
	const userBlocks = attachPreviewData(
		args.prepared.blocks,
		args.encodedAttachments,
		args.encodedVoice,
	);
	args.onUserBlocks?.(userBlocks);

	const input = turnInputFromSession(args.session, {
		...(args.prepared.draft.text ? { text: args.prepared.draft.text } : {}),
		...(args.encodedAttachments?.length ? { attachments: args.encodedAttachments } : {}),
		...(args.encodedVoice?.length ? { voice: args.encodedVoice } : {}),
	});

	let session: InterfaceTurnSession = {
		...args.session,
		pendingUserDraft: args.prepared.draft,
		assistantEvents: [],
	};

	const events = await streamFoldedTurn({
		iface: args.iface,
		onStream: args.onStream,
		seedEvents: [],
		stream: (onEvent) =>
			streamPlaygroundTurn(
				buildTurnRequestBody(args.payload, session, input, { turnId: args.turnId }),
				onEvent,
				args.signal,
			),
	});

	session = finalizeTurnStream({
		session,
		events,
		media,
	});

	return {
		ok: true,
		session,
		userBlocks,
		assistantBlocks: foldAssistantTurn(args.iface, events),
	};
}

export async function streamInterfaceTurn(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	text: string;
	pendingFiles: readonly File[];
	pendingVoice: readonly File[];
	onStream: (blocks: TranscriptBlock[]) => void;
	/** Fires once user blocks are ready (with media preview data) before the assistant stream. */
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
}): Promise<StreamTurnSuccess | TurnFailure> {
	if (sessionHasGatedTool(args.session)) {
		return { ok: false, error: 'Resolve the gated tool before sending a new message.' };
	}

	try {
		const prepared = prepareComposerTurn(
			args.iface,
			args.text,
			args.pendingFiles,
			args.pendingVoice,
		);
		if (!prepared.ok) {
			return { ok: false, error: prepared.issues.join(' '), issues: prepared.issues };
		}

		return await streamPreparedInterfaceTurn({
			iface: args.iface,
			payload: args.payload,
			session: args.session,
			prepared,
			encodedAttachments: args.pendingFiles.length
				? await encodeFiles(args.pendingFiles)
				: undefined,
			encodedVoice: args.pendingVoice.length ? await encodeFiles(args.pendingVoice) : undefined,
			onStream: args.onStream,
			onUserBlocks: args.onUserBlocks,
			signal: args.signal,
			turnId: args.turnId,
		});
	} catch (err) {
		return turnFailureFromCaught(err, args.signal);
	}
}

/** Send a turn from an already-encoded pending draft (queue drain / send now). */
export async function streamInterfaceDraftTurn(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	draft: import('../../../src/interface/mod.ts').UserTurnDraft;
	onStream: (blocks: TranscriptBlock[]) => void;
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
}): Promise<StreamTurnSuccess | TurnFailure> {
	if (sessionHasGatedTool(args.session)) {
		return { ok: false, error: 'Resolve the gated tool before sending a new message.' };
	}

	try {
		const prepared = projectUserTurn(args.iface, args.draft);
		if (!prepared.ok) {
			return { ok: false, error: prepared.issues.join(' '), issues: prepared.issues };
		}

		const encodedAttachments = prepared.draft.attachments
			?.filter((attachment) => typeof attachment.data === 'string')
			.map((attachment) => ({
				name: attachment.name,
				mimeType: attachment.mimeType,
				data: attachment.data as string,
			}));
		const encodedVoice = prepared.draft.voice
			?.filter((attachment) => typeof attachment.data === 'string')
			.map((attachment) => ({
				name: attachment.name,
				mimeType: attachment.mimeType,
				data: attachment.data as string,
			}));

		return await streamPreparedInterfaceTurn({
			iface: args.iface,
			payload: args.payload,
			session: args.session,
			prepared,
			encodedAttachments,
			encodedVoice,
			onStream: args.onStream,
			onUserBlocks: args.onUserBlocks,
			signal: args.signal,
			turnId: args.turnId,
		});
	} catch (err) {
		return turnFailureFromCaught(err, args.signal);
	}
}

async function resumeDeniedGatedTool(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	gated: NonNullable<InterfaceTurnSession['gatedTool']>;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const history = appendToolDenialToHistory(args.session.history, {
		name: args.gated.name,
		callId: args.gated.callId,
		arguments: args.gated.arguments,
	});
	const seedEvents = args.session.assistantEvents.map((event) => {
		const tool = event.type === 'tool' ? event.tool : undefined;
		if (!tool?.name || tool.phase !== 'gate' || !tool.gate) return event;
		return {
			type: 'tool' as const,
			tool: {
				...tool,
				name: tool.name,
				phase: 'error' as const,
				gate: undefined,
				pause: undefined,
				failure: {
					code: 'denied',
					message: lexiconText('session.tool_denied', { tool: args.gated.name }),
				},
			},
		} as import('theorum').TurnEvent;
	});
	const session = {
		...args.session,
		history,
		gatedTool: null,
		assistantEvents: seedEvents,
	};
	return await continueAfterTool({ ...args, session, seedEvents });
}

async function resumeAllowedGatedTool(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	action: Exclude<ToolDecisionAction, 'deny'>;
	onStream: (blocks: TranscriptBlock[]) => void;
	credentials?: Record<string, ToolCredential>;
	gated: NonNullable<InterfaceTurnSession['gatedTool']>;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	let session: InterfaceTurnSession = { ...args.session };
	const invokePermissions = applyToolDecisionToSessionPermissions(
		session.sessionPermissions,
		args.gated.name,
		args.action,
		args.gated.permission,
	);
	const sessionPermissions =
		args.action === 'allow_session' ? invokePermissions : session.sessionPermissions;

	let resume: ReturnType<typeof buildInvokeToolResume>;
	try {
		resume = buildInvokeToolResume(args.gated.gateKind);
	} catch (err) {
		return turnFailureFromCaught(err);
	}

	try {
		const invokeEvents = await streamFoldedTurn({
			iface: args.iface,
			onStream: args.onStream,
			seedEvents: session.assistantEvents,
			stream: (onEvent) =>
				streamPlaygroundInvoke(
					buildInvokeRequestBody(args.payload, session, {
						name: args.gated.name,
						input: args.gated.input,
						resume,
						sessionPermissions: invokePermissions,
						credentials: args.credentials,
					}),
					onEvent,
				),
		});

		session = {
			...applyTurnEventsToSession(session, invokeEvents),
			sessionPermissions,
			assistantEvents: invokeEvents,
			gatedTool: gatedToolFromEvents(invokeEvents),
		};

		if (sessionHasGatedTool(session)) {
			return {
				ok: true,
				session,
				assistantBlocks: foldAssistantTurn(args.iface, invokeEvents),
			};
		}

		const completedTool = invokeEvents.findLast(
			(event) =>
				event.type === 'tool' &&
				event.tool?.name === args.gated.name &&
				event.tool.phase === 'complete' &&
				event.tool.output !== undefined,
		);
		if (completedTool?.tool?.output !== undefined) {
			session = {
				...session,
				history: appendToolExchangeToHistory(session.history, {
					name: args.gated.name,
					callId: args.gated.callId,
					arguments: args.gated.arguments,
					output: completedTool.tool.output,
				}),
			};
		} else {
			// The kernel emits one terminal tool event: no completion means the call failed or was denied.
			const failedTool = invokeEvents.findLast(
				(event) =>
					event.type === 'tool' &&
					event.tool?.name === args.gated.name &&
					event.tool.phase === 'error' &&
					event.tool.failure !== undefined,
			);
			if (failedTool?.tool?.failure) {
				session = {
					...session,
					history: appendToolDenialToHistory(session.history, {
						name: args.gated.name,
						callId: args.gated.callId,
						arguments: args.gated.arguments,
						failure: failedTool.tool.failure,
					}),
				};
			}
		}

		return await continueAfterTool({ ...args, session, seedEvents: invokeEvents });
	} catch (err) {
		return turnFailureFromCaught(err);
	}
}

export async function resumeInterfaceTool(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	action: ToolDecisionAction;
	interactiveValue?: unknown;
	onStream: (blocks: TranscriptBlock[]) => void;
	credentials?: Record<string, ToolCredential>;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const gated = args.session.gatedTool;
	if (!gated) {
		return { ok: false, error: 'No gated tool to resume.' };
	}
	if (args.action === 'deny') {
		return await resumeDeniedGatedTool({ ...args, gated });
	}
	return await resumeAllowedGatedTool({ ...args, action: args.action, gated });
}

export function applyTurnResultToTranscript(args: {
	blocks: TranscriptBlock[];
	streamBlocks: TranscriptBlock[];
	session: InterfaceTurnSession;
	userBlocks?: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
}): { blocks: TranscriptBlock[]; streamBlocks: TranscriptBlock[]; session: InterfaceTurnSession } {
	const session = args.session;
	const prefix = args.userBlocks?.length ? [...args.blocks, ...args.userBlocks] : args.blocks;
	if (sessionHasGatedTool(session)) {
		return {
			blocks: prefix,
			streamBlocks: args.assistantBlocks,
			session,
		};
	}
	return {
		blocks: [...prefix, ...args.assistantBlocks],
		streamBlocks: [],
		session,
	};
}

/**
 * Leave a tool gate without continuing the model — for send-now while gated.
 * Commits cancelled tool state into session history + assistant transcript blocks.
 */
export function abandonGatedInterfaceTool(args: {
	iface: ComposerProfileInterface;
	session: InterfaceTurnSession;
}): {
	session: InterfaceTurnSession;
	assistantBlocks: TranscriptBlock[];
} {
	const { session, finalizedEvents } = abandonGatedToolSession(args.session);
	return {
		session,
		assistantBlocks: foldAssistantTurn(args.iface, finalizedEvents),
	};
}
