import {
	applyTurnEventsToSession,
	type AttachmentValidationIssue,
	type ComposerProfileInterface,
	gatedToolFromEvents,
	type InterfaceTurnSession,
	type TranscriptBlock,
	type UserTurnDraft,
} from '../../../src/interface/mod.ts';
import { attachmentsRefused, TheoremError, type TurnEvent } from '../../../mod.ts';
import { attachPreviewData, encodeFiles } from './encode-files.ts';
import { type TurnFailure, turnFailure } from './failure.ts';
import {
	continueAfterTool,
	failTurnStream,
	finalizeTurnStream,
	stampWorked,
	streamFoldedTurn,
	toTurnMedia,
} from './run-commit.ts';
import type { EncodedBlob, TheoremTransport } from './transport.ts';
import { continueGatedToolInvocation, type ToolGateResolution } from './tool-resume.ts';
import { type WalkingAway, walkAwayFrom } from './walk-away.ts';
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
	walking?: WalkingAway;
}): Promise<StreamTurnSuccess | TurnFailure> {
	const media = toTurnMedia(args.encodedAttachments, args.encodedVoice);
	const userBlocks = attachPreviewData(
		args.prepared.blocks,
		args.encodedAttachments,
		args.encodedVoice,
	);
	const { walking } = args;
	const sent = walking ? { ...args.session, history: walking.history } : args.session;
	const input = turnInputFromSession(sent, {
		...(args.prepared.draft.text ? { text: args.prepared.draft.text } : {}),
		...(args.encodedAttachments?.length ? { attachments: args.encodedAttachments } : {}),
		...(args.encodedVoice?.length ? { voice: args.encodedVoice } : {}),
	});
	const request = buildTurnRequest(args.iface, args.session, input, {
		turnId: args.turnId,
		...(walking ? { walkAway: walking.request } : {}),
	});

	// The message's reply starts from the conversation as it stands when the message posts.
	const posted = (base: InterfaceTurnSession): InterfaceTurnSession => ({
		...base,
		pendingUserDraft: args.prepared.draft,
		assistantEvents: [],
	});
	let session = posted(args.session);
	// Walking away, the message posts once the paused reply has settled, after it.
	let posts = walking ? [] : userBlocks;
	if (!walking) args.onUserBlocks?.(userBlocks);

	const events: TurnEvent[] = [];
	try {
		await streamFoldedTurn({
			iface: args.iface,
			onStream: args.onStream,
			events,
			stream: (onEvent) =>
				args.transport.turn(
					request,
					walking
						? walking.sink(onEvent, (walked) => {
								session = posted(walked.session);
								posts = [...walked.blocks, ...userBlocks];
								args.onUserBlocks?.(posts);
							})
						: onEvent,
					args.signal,
				),
		});
	} catch (err) {
		const failure = turnFailure(err, args.iface.lexicon, args.signal);
		// A message that never posted leaves the paused reply waiting as it was.
		if (walking && !walking.settled()) return failure;
		return failTurnStream({ session, events, media, failure });
	}

	session = finalizeTurnStream({ session, events, media });

	return {
		ok: true,
		session,
		userBlocks: posts,
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


export type StreamInterfaceTurnBaseArgs = {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	/**
	 * Fires once the message posts, before its reply streams, with the blocks
	 * the transcript gains: a walked-away reply's settled blocks, then the
	 * message's own (with media preview data).
	 */
	onUserBlocks?: (blocks: TranscriptBlock[]) => void;
	signal?: AbortSignal;
	turnId?: string;
	/**
	 * Send while the reply waits on gates: the message walks away from every
	 * waiting call in its own request, and the host settles each one cancelled
	 * ahead of the reply. `workedMs` is the paused reply's work so far, which
	 * its settled blocks keep. Without it, a waiting session refuses the send
	 * (`session.gate_pending`).
	 */
	walkAway?: { workedMs: number };
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
	const gated = sessionHasGatedTool(args.session);
	if (gated && !args.walkAway) return sessionFailure('session.gate_pending', args.iface);
	const walking = gated && args.walkAway ? walkAwayFrom(args.iface, args.session, args.walkAway.workedMs) : undefined;

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
			...(walking ? { walking } : {}),
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

/**
 * Send the user's answer to the gate the session waits on. The host settles
 * the call either way (an approval runs it; a refusal records it declined),
 * so the model and the trace read what the user chose.
 */
export async function resumeInterfaceTool(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	resolution: ToolGateResolution;
	onStream: (blocks: TranscriptBlock[]) => void;
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const gated = args.session.gatedTool;
	if (!gated?.callId) return sessionFailure('session.gate_expired', args.iface);
	const reply = continueGatedToolInvocation({
		toolName: gated.name,
		gate: gated,
		sessionPermissions: args.session.sessionPermissions,
		resolution: args.resolution,
	});
	const sessionPermissions =
		reply.decision === 'approve' ? reply.sessionPermissions : args.session.sessionPermissions;
	try {
		const events = await streamFoldedTurn({
			iface: args.iface,
			onStream: args.onStream,
			events: [...args.session.assistantEvents],
			stream: (onEvent) =>
				args.transport.invoke(
					buildInvokeRequest(args.iface, args.session, {
						gateId: gated.callId,
						decision: reply.decision,
						name: gated.name,
						input: gated.arguments,
						sessionPermissions,
						...(reply.decision === 'approve' && reply.secret !== undefined ? { secret: reply.secret } : {}),
					}),
					onEvent,
				),
		});
		const session = { ...applyTurnEventsToSession(args.session, events), sessionPermissions };
		return await continueOnceSettled({ ...args, session, events });
	} catch (err) {
		return turnFailure(err, args.iface.lexicon);
	}
}

export function applyTurnResultToTranscript(args: {
	blocks: TranscriptBlock[];
	streamBlocks: TranscriptBlock[];
	session: InterfaceTurnSession;
	userBlocks?: TranscriptBlock[];
	assistantBlocks: TranscriptBlock[];
	/** The reply's work so far, stamped on its latest `turn-done` so the time stays with the blocks. */
	worked?: { workedMs: number; endedAt: number };
}): { blocks: TranscriptBlock[]; streamBlocks: TranscriptBlock[]; session: InterfaceTurnSession } {
	const session = args.session;
	const prefix = args.userBlocks?.length ? [...args.blocks, ...args.userBlocks] : args.blocks;
	const assistantBlocks = args.worked ? stampWorked(args.assistantBlocks, args.worked) : args.assistantBlocks;
	if (sessionHasGatedTool(session)) {
		return {
			blocks: prefix,
			streamBlocks: assistantBlocks,
			session,
		};
	}
	return {
		blocks: [...prefix, ...assistantBlocks],
		streamBlocks: [],
		session,
	};
}
