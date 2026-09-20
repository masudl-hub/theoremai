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
import type { ToolCredential } from '../../../src/kernel/mod.ts';
import { lexiconText, type TurnEvent } from '../../../mod.ts';
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

function extractInlineEncodedAttachments(
	attachments?: readonly { name: string; mimeType: string; data?: unknown }[],
): Array<{ name: string; mimeType: string; data: string }> | undefined {
	const filtered = attachments
		?.filter(
			(a): a is { name: string; mimeType: string; data: string } => typeof a.data === 'string',
		)
		.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
	return filtered && filtered.length > 0 ? filtered : undefined;
}

function assertNotGated(session: InterfaceTurnSession): TurnFailure | null {
	if (sessionHasGatedTool(session)) {
		return { ok: false, error: 'Resolve the gated tool before sending a new message.' };
	}
	return null;
}

export type StreamInterfaceTurnBaseArgs = {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	/** Fires once user blocks are ready (with media preview data) before the assistant stream. */
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
};

export type StreamInterfaceTurnArgs = StreamInterfaceTurnBaseArgs & {
	text: string;
	pendingFiles: readonly File[];
	pendingVoice: readonly File[];
};

export type StreamInterfaceDraftTurnArgs = StreamInterfaceTurnBaseArgs & {
	draft: import('../../../src/interface/mod.ts').UserTurnDraft;
};

async function runPreparedTurnStream(
	args: StreamInterfaceTurnBaseArgs & {
		prepare: () =>
			| Promise<
					| { ok: false; issues: readonly string[] }
					| {
							ok: true;
							prepared: PreparedUserTurn;
							encodedAttachments?: Array<{ name: string; mimeType: string; data: string }>;
							encodedVoice?: Array<{ name: string; mimeType: string; data: string }>;
					  }
			  >
			| { ok: false; issues: readonly string[] }
			| {
					ok: true;
					prepared: PreparedUserTurn;
					encodedAttachments?: Array<{ name: string; mimeType: string; data: string }>;
					encodedVoice?: Array<{ name: string; mimeType: string; data: string }>;
			  };
	},
): Promise<StreamTurnSuccess | TurnFailure> {
	const blocked = assertNotGated(args.session);
	if (blocked) return blocked;

	try {
		const outcome = await args.prepare();
		if (!outcome.ok) {
			return { ok: false, error: outcome.issues.join(' '), issues: [...outcome.issues] };
		}
		return await streamPreparedInterfaceTurn({
			iface: args.iface,
			payload: args.payload,
			session: args.session,
			prepared: outcome.prepared,
			encodedAttachments: outcome.encodedAttachments,
			encodedVoice: outcome.encodedVoice,
			onStream: args.onStream,
			onUserBlocks: args.onUserBlocks,
			signal: args.signal,
			turnId: args.turnId,
		});
	} catch (err) {
		return turnFailureFromCaught(err, args.signal);
	}
}

export async function streamInterfaceTurn(
	args: StreamInterfaceTurnArgs,
): Promise<StreamTurnSuccess | TurnFailure> {
	return await runPreparedTurnStream({
		...args,
		prepare: async () => {
			const prepared = prepareComposerTurn(
				args.iface,
				args.text,
				args.pendingFiles,
				args.pendingVoice,
			);
			if (!prepared.ok) return prepared;
			return {
				ok: true,
				prepared,
				encodedAttachments: args.pendingFiles.length
					? await encodeFiles(args.pendingFiles)
					: undefined,
				encodedVoice: args.pendingVoice.length ? await encodeFiles(args.pendingVoice) : undefined,
			};
		},
	});
}

/** Send a turn from an already-encoded pending draft (queue drain / send now). */
export async function streamInterfaceDraftTurn(
	args: StreamInterfaceDraftTurnArgs,
): Promise<StreamTurnSuccess | TurnFailure> {
	return await runPreparedTurnStream({
		...args,
		prepare: () => {
			const prepared = projectUserTurn(args.iface, args.draft);
			if (!prepared.ok) return prepared;
			return {
				ok: true,
				prepared,
				encodedAttachments: extractInlineEncodedAttachments(prepared.draft.attachments),
				encodedVoice: extractInlineEncodedAttachments(prepared.draft.voice),
			};
		},
	});
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
		} as TurnEvent;
	});
	const session = {
		...args.session,
		history,
		gatedTool: null,
		assistantEvents: seedEvents,
	};
	return await continueAfterTool({ ...args, session, seedEvents });
}

function appendTerminalToolToHistory(
	history: InterfaceHistoryMessage[],
	gated: NonNullable<InterfaceTurnSession['gatedTool']>,
	invokeEvents: readonly TurnEvent[],
): InterfaceHistoryMessage[] {
	const completedTool = invokeEvents.findLast(
		(event) =>
			event.type === 'tool' &&
			event.tool?.name === gated.name &&
			event.tool.phase === 'complete' &&
			event.tool.output !== undefined,
	);
	if (completedTool?.tool?.output !== undefined) {
		return appendToolExchangeToHistory(history, {
			name: gated.name,
			callId: gated.callId,
			arguments: gated.arguments,
			output: completedTool.tool.output,
		});
	}
	const failedTool = invokeEvents.findLast(
		(event) =>
			event.type === 'tool' &&
			event.tool?.name === gated.name &&
			event.tool.phase === 'error' &&
			event.tool.failure !== undefined,
	);
	if (failedTool?.tool?.failure) {
		return appendToolDenialToHistory(history, {
			name: gated.name,
			callId: gated.callId,
			arguments: gated.arguments,
			failure: failedTool.tool.failure,
		});
	}
	return history;
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

		session = {
			...session,
			history: appendTerminalToolToHistory(session.history, args.gated, invokeEvents),
		};

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
