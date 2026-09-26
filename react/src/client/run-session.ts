import {
	abandonGatedToolSession,
	applyTurnEventsToSession,
	type AttachmentValidationIssue,
	type ComposerProfileInterface,
	gatedToolFromEvents,
	type InterfaceTurnSession,
	type TranscriptBlock,
	type UserTurnDraft,
} from '../../../src/interface/mod.ts';
import { attachmentsRefused, lexiconText, TheoremError, type TurnEvent } from '../../../mod.ts';
import { attachPreviewData, encodeFiles } from './encode-files.ts';
import { type TurnFailure, turnFailure } from './failure.ts';
import {
	continueAfterTool,
	failTurnStream,
	finalizeTurnStream,
	streamFoldedTurn,
	toTurnMedia,
} from './run-commit.ts';
import type { EncodedBlob, TheoremTransport } from './transport.ts';
import { failureEvent } from '../../../src/kernel/tools/events.ts';
import { sessionPermissionsAfterApproval } from '../../../src/kernel/tools/gate-answer.ts';
import { buildInvokeToolResume, type ToolDecisionAction } from './tool-resume.ts';
import {
	buildInvokeRequest,
	buildTurnRequest,
	foldAssistantTurn,
	prepareComposerTurn,
	projectUserTurn,
	turnInputFromSession,
} from './turn-client.ts';

export type { TurnFailure } from './failure.ts';

/**
 * A session state the user can't act from (no gate waiting, a gate without a
 * call id): the lexicon's line for it, as a turn failure.
 */
function sessionFailure(
	key: 'session.gate_pending' | 'session.gate_expired',
	iface: ComposerProfileInterface,
): TurnFailure {
	return turnFailure(new TheoremError('request', `session state: ${key}`, { copy: { key } }), iface.lexicon);
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
	draft: UserTurnDraft;
	blocks: TranscriptBlock[];
};

async function streamPreparedInterfaceTurn(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
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

	const events: TurnEvent[] = [];
	try {
		await streamFoldedTurn({
			iface: args.iface,
			onStream: args.onStream,
			events,
			stream: (onEvent) =>
				args.transport.turn(
					buildTurnRequest(args.iface, session, input, { turnId: args.turnId }),
					onEvent,
					args.signal,
				),
		});
	} catch (err) {
		const failure = turnFailure(err, args.iface.lexicon, args.signal);
		return failTurnStream({ session, events, media, failure });
	}

	session = finalizeTurnStream({ session, events, media });

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

function assertNotGated(
	session: InterfaceTurnSession,
	iface: ComposerProfileInterface,
): TurnFailure | null {
	return sessionHasGatedTool(session) ? sessionFailure('session.gate_pending', iface) : null;
}

export type StreamInterfaceTurnBaseArgs = {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
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
	draft: UserTurnDraft;
};

type PreparedTurnOutcome =
	| { ok: false; issues: AttachmentValidationIssue[] }
	| {
			ok: true;
			prepared: PreparedUserTurn;
			encodedAttachments?: EncodedBlob[];
			encodedVoice?: EncodedBlob[];
	  };

async function runPreparedTurnStream(
	args: StreamInterfaceTurnBaseArgs & {
		prepare: () => PreparedTurnOutcome | Promise<PreparedTurnOutcome>;
	},
): Promise<StreamTurnSuccess | TurnFailure> {
	const blocked = assertNotGated(args.session, args.iface);
	if (blocked) return blocked;

	try {
		const outcome = await args.prepare();
		if (!outcome.ok) {
			return { ...turnFailure(attachmentsRefused(outcome.issues), args.iface.lexicon), issues: outcome.issues };
		}
		return await streamPreparedInterfaceTurn({
			iface: args.iface,
			transport: args.transport,
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
		return turnFailure(err, args.iface.lexicon, args.signal);
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
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	gated: NonNullable<InterfaceTurnSession['gatedTool']>;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	// Browser-made refusal: deleted when web refusals settle through `/invoke` (turn-event schema, step 4).
	const seedEvents = args.session.assistantEvents.map((event): TurnEvent => {
		if (event.type !== 'tool' || event.tool.phase !== 'gate' || event.tool.callId !== args.gated.callId) {
			return event;
		}
		const { name, callId } = event.tool;
		return failureEvent(
			{ name, callId },
			{
				code: 'denied',
				kind: 'declined',
				message: lexiconText('session.tool_denied', { tool: name }, args.iface.lexicon),
			},
		);
	});
	return await continueOnceSettled({ ...args, session: args.session, events: seedEvents });
}

/**
 * After one gate settles: wait on the step's next gate if one is left, else
 * send the whole step back to the model.
 */
async function continueOnceSettled(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	events: TurnEvent[];
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const gatedTool = gatedToolFromEvents(args.events);
	const session = { ...args.session, gatedTool, assistantEvents: args.events };
	if (gatedTool) {
		return { ok: true, session, assistantBlocks: foldAssistantTurn(args.iface, args.events) };
	}
	return await continueAfterTool({ ...args, session, seedEvents: args.events });
}

async function resumeAllowedGatedTool(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	secret?: string;
	gated: NonNullable<InterfaceTurnSession['gatedTool']>;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const gateId = args.gated.callId;
	if (!gateId) return sessionFailure('session.gate_expired', args.iface);
	let session: InterfaceTurnSession = { ...args.session };
	const sessionPermissions = sessionPermissionsAfterApproval(
		session.sessionPermissions,
		args.gated.name,
		args.gated.permission,
	);

	let resume: ReturnType<typeof buildInvokeToolResume>;
	try {
		resume = buildInvokeToolResume(args.gated.gateKind);
	} catch (err) {
		return turnFailure(err, args.iface.lexicon);
	}

	try {
		const invokeEvents = await streamFoldedTurn({
			iface: args.iface,
			onStream: args.onStream,
			events: [...session.assistantEvents],
			stream: (onEvent) =>
				args.transport.invoke(
					buildInvokeRequest(args.iface, session, {
						gateId,
						name: args.gated.name,
						input: args.gated.arguments,
						resume,
						sessionPermissions,
						secret: args.secret,
					}),
					onEvent,
				),
		});

		session = { ...applyTurnEventsToSession(session, invokeEvents), sessionPermissions };
		return await continueOnceSettled({ ...args, session, events: invokeEvents });
	} catch (err) {
		return turnFailure(err, args.iface.lexicon);
	}
}

export async function resumeInterfaceTool(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	action: ToolDecisionAction;
	interactiveValue?: unknown;
	onStream: (blocks: TranscriptBlock[]) => void;
	secret?: string;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const gated = args.session.gatedTool;
	if (!gated) return sessionFailure('session.gate_expired', args.iface);
	if (args.action === 'deny') {
		return await resumeDeniedGatedTool({ ...args, gated });
	}
	return await resumeAllowedGatedTool({ ...args, gated });
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
	const { session, finalizedEvents } = abandonGatedToolSession(args.session, args.iface.lexicon);
	return {
		session,
		assistantBlocks: foldAssistantTurn(args.iface, finalizedEvents),
	};
}
