import {
	abandonGatedToolSession,
	appendToolDenialToHistory,
	appendToolExchangeToHistory,
	applyTurnEventsToSession,
	type ComposerProfileInterface,
	gatedToolFromEvents,
	type InterfaceTurnSession,
	type TranscriptBlock,
} from 'theorum/interface';
import type { ToolCredential } from 'theorum/kernel';
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
	isPlaygroundStreamError,
	prepareComposerTurn,
	projectUserTurn,
	streamPlaygroundInvoke,
	streamPlaygroundTurn,
	turnInputFromSession,
} from './turn-client';

type TurnFailure = { ok: false; error: string; errorInternal?: string; issues?: string[]; aborted?: boolean };

function turnFailureFromCaught(err: unknown, signal?: AbortSignal): TurnFailure {
	if (isAbortError(err) || signal?.aborted) {
		return { ok: false, error: 'Cancelled', aborted: true };
	}
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

function sessionHasGatedTool(session: InterfaceTurnSession): boolean {
	return (session.gatedTool ?? session.pausedTool) !== null;
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
}): Promise<
	| {
			ok: true;
			session: InterfaceTurnSession;
			userBlocks: TranscriptBlock[];
			assistantBlocks: TranscriptBlock[];
	  }
	| { ok: false; error: string; errorInternal?: string; issues?: string[]; aborted?: boolean }
> {
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

		const encodedAttachments = args.pendingFiles.length
			? await encodeFiles(args.pendingFiles)
			: undefined;
		const encodedVoice = args.pendingVoice.length
			? await encodeFiles(args.pendingVoice)
			: undefined;
		const media = toTurnMedia(encodedAttachments, encodedVoice);
		const userBlocks = attachPreviewData(prepared.blocks, encodedAttachments, encodedVoice);
		args.onUserBlocks?.(userBlocks);

		const input = turnInputFromSession(args.session, {
			...(prepared.draft.text ? { text: prepared.draft.text } : {}),
			...(encodedAttachments ? { attachments: encodedAttachments } : {}),
			...(encodedVoice ? { voice: encodedVoice } : {}),
		});

		let session: InterfaceTurnSession = {
			...args.session,
			pendingUserDraft: prepared.draft,
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
	} catch (err) {
		return turnFailureFromCaught(err, args.signal);
	}
}

/** Send a turn from an already-encoded pending draft (queue drain / send now). */
export async function streamInterfaceDraftTurn(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	draft: import('theorum/interface').UserTurnDraft;
	onStream: (blocks: TranscriptBlock[]) => void;
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
}): Promise<
	| {
			ok: true;
			session: InterfaceTurnSession;
			userBlocks: TranscriptBlock[];
			assistantBlocks: TranscriptBlock[];
	  }
	| { ok: false; error: string; errorInternal?: string; issues?: string[]; aborted?: boolean }
> {
	if (sessionHasGatedTool(args.session)) {
		return { ok: false, error: 'Resolve the gated tool before sending a new message.' };
	}

	try {
		const prepared = projectUserTurn(args.iface, args.draft);
		if (!prepared.ok) {
			return { ok: false, error: prepared.issues.join(' '), issues: prepared.issues };
		}

		const encodedAttachments = prepared.draft.attachments
			?.filter((a): a is typeof a & { data: string } => typeof a.data === 'string')
			.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
		const encodedVoice = prepared.draft.voice
			?.filter((a): a is typeof a & { data: string } => typeof a.data === 'string')
			.map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
		const media = toTurnMedia(encodedAttachments, encodedVoice);
		const userBlocks = attachPreviewData(prepared.blocks, encodedAttachments, encodedVoice);
		args.onUserBlocks?.(userBlocks);

		const input = turnInputFromSession(args.session, {
			...(prepared.draft.text ? { text: prepared.draft.text } : {}),
			...(encodedAttachments?.length ? { attachments: encodedAttachments } : {}),
			...(encodedVoice?.length ? { voice: encodedVoice } : {}),
		});

		let session: InterfaceTurnSession = {
			...args.session,
			pendingUserDraft: prepared.draft,
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
	} catch (err) {
		return turnFailureFromCaught(err, args.signal);
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
	const gated = args.session.gatedTool ?? args.session.pausedTool;
	if (!gated) {
		return { ok: false, error: 'No gated tool to resume.' };
	}

	let session: InterfaceTurnSession = { ...args.session };

	if (args.action === 'deny') {
		const history = appendToolDenialToHistory(session.history, {
			name: gated.name,
			callId: gated.callId,
			arguments: gated.arguments,
		});
		const seedEvents = session.assistantEvents.map((event) => {
			const isGate =
				(event.tool?.phase === 'gate' && event.tool.gate) ||
				(event.tool?.phase === 'pause' && event.tool.pause);
			if (event.type !== 'tool' || !isGate) {
				return event;
			}
			return {
				type: 'tool' as const,
				tool: {
					...event.tool,
					phase: 'error' as const,
					gate: undefined,
					pause: undefined,
					failure: {
						code: 'denied',
						message: `User denied execution of '${gated.name}'.`,
					},
				},
			};
		});
		session = {
			...session,
			history,
			gatedTool: null,
			pausedTool: null,
			assistantEvents: seedEvents,
		};
		return await continueAfterTool({ ...args, session, seedEvents });
	}

	const invokePermissions = applyToolDecisionToSessionPermissions(
		session.sessionPermissions,
		gated.name,
		args.action,
		gated.permission,
	);
	let sessionPermissions = session.sessionPermissions;
	if (args.action === 'allow_session') {
		sessionPermissions = invokePermissions;
	}

	let resume: ReturnType<typeof buildInvokeToolResume>;
	try {
		resume = buildInvokeToolResume(gated.gateKind);
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
						name: gated.name,
						input: gated.input,
						resume,
						sessionPermissions: invokePermissions,
						credentials: args.credentials,
					}),
					onEvent,
				),
		});

		const nextGated = gatedToolFromEvents(invokeEvents);
		session = {
			...applyTurnEventsToSession(session, invokeEvents),
			sessionPermissions,
			assistantEvents: invokeEvents,
			gatedTool: nextGated,
			pausedTool: nextGated,
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
				event.tool?.name === gated.name &&
				event.tool.phase === 'complete' &&
				event.tool.output !== undefined,
		);
		if (completedTool?.tool?.output !== undefined) {
			session = {
				...session,
				history: appendToolExchangeToHistory(session.history, {
					name: gated.name,
					callId: gated.callId,
					arguments: gated.arguments,
					output: completedTool.tool.output,
				}),
			};
		}

		return await continueAfterTool({ ...args, session, seedEvents: invokeEvents });
	} catch (err) {
		return turnFailureFromCaught(err);
	}
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

/** @deprecated Use `abandonGatedInterfaceTool`. */
export function abandonPausedInterfaceTool(args: {
	iface: ComposerProfileInterface;
	session: InterfaceTurnSession;
}): {
	session: InterfaceTurnSession;
	assistantBlocks: TranscriptBlock[];
} {
	return abandonGatedInterfaceTool(args);
}
