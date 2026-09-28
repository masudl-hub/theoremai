import type { TheoremError, TurnBlob, TurnEvent } from '../../../mod.ts';
import {
	appendAssistantEventsToHistory,
	appendUserDraftToHistory,
	applyTurnEventsToSession,
	type ComposerProfileInterface,
	type InterfaceTurnSession,
	gatedToolFromEvents,
	settlesToolCall,
	type TranscriptBlock,
	type UserTurnHistoryMedia,
} from '../../../src/interface/mod.ts';
import { type TurnFailure, turnFailure } from './failure.ts';
import type { TheoremTransport, TurnEventSink } from './transport.ts';
import { buildTurnRequest, foldAssistantTurn, turnInputFromSession } from './turn-client.ts';

/** The turn's history before its reply: a turn not yet started adds the user's message. */
function turnBaseHistory(
	session: InterfaceTurnSession,
	media: UserTurnHistoryMedia,
): InterfaceTurnSession['history'] {
	return session.pendingUserDraft
		? appendUserDraftToHistory(session.history, session.pendingUserDraft, media)
		: session.history;
}

/** The turn is over: every event it streamed, gate resumes included, enters history once. */
export function commitCompletedTurn(
	session: InterfaceTurnSession,
	events: TurnEvent[],
	media: UserTurnHistoryMedia = {},
): InterfaceTurnSession {
	return {
		...applyTurnEventsToSession(session, events),
		history: appendAssistantEventsToHistory(turnBaseHistory(session, media), events),
		gatedTool: null,
		assistantEvents: [],
		pendingUserDraft: null,
		toolSnapshot: undefined,
		promotedToolIds: [],
	};
}

/**
 * The turn waits at a gate. History stops at the user's message and the events
 * wait in `assistantEvents`, so the gated step enters history whole once it settles.
 */
function pauseTurn(
	session: InterfaceTurnSession,
	events: TurnEvent[],
	media: UserTurnHistoryMedia = {},
): InterfaceTurnSession {
	return {
		...applyTurnEventsToSession(session, events),
		history: turnBaseHistory(session, media),
		gatedTool: gatedToolFromEvents(events),
		assistantEvents: [...events],
		pendingUserDraft: null,
	};
}

export function toTurnMedia(
	encodedAttachments?: TurnBlob[],
	encodedVoice?: TurnBlob[],
): UserTurnHistoryMedia {
	return {
		...(encodedAttachments?.length ? { attachments: encodedAttachments } : {}),
		...(encodedVoice?.length ? { voice: encodedVoice } : {}),
	};
}

/**
 * A failed turn with the conversation it leaves: the user's message and what the
 * reply got through (its text and the tool calls that settled), so the next turn
 * picks up from there. A stopped reply leaves the transcript, so only the message stays.
 */
function withFailedTurnSession(
	failure: TurnFailure,
	commit: (events: TurnEvent[]) => InterfaceTurnSession,
	events: TurnEvent[],
	seedEvents: TurnEvent[] = [],
): TurnFailure {
	return { ...failure, session: commit(failure.aborted ? seedEvents : events) };
}

/** Where a run shows itself as it streams: the reply so far, and each line the stream left out. */
export type StreamView = {
	blocks(blocks: TranscriptBlock[]): void;
	/** A `malformed` line: left out, and the reply goes on. */
	skipped(error: TheoremError): void;
};

/**
 * Streams into `events`, which the caller owns, so a stream that fails still
 * leaves what it delivered. An `unsupported` line is the host's to read on its
 * own transport, and a `malformed` one goes to `view.skipped`: neither enters
 * the turn, its history or its transcript.
 */
async function streamFoldedEvents(
	stream: (onEvent: TurnEventSink) => Promise<void>,
	view: StreamView,
	iface: ComposerProfileInterface,
	events: TurnEvent[],
): Promise<TurnEvent[]> {
	await stream((event) => {
		if (event.type === 'unsupported') return;
		if (event.type === 'malformed') {
			view.skipped(event.error);
			return;
		}
		events.push(event);
		view.blocks(foldAssistantTurn(iface, events));
	});
	return events;
}

export async function continueAfterTool(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	view: StreamView;
	seedEvents: TurnEvent[];
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| TurnFailure
> {
	const events = [...args.seedEvents];
	// The model reads the turn so far: the settled gate and everything before it.
	const sent = {
		...args.session,
		history: appendAssistantEventsToHistory(args.session.history, args.seedEvents),
	};
	try {
		await streamFoldedEvents(
			(onEvent) =>
				args.transport.turn(buildTurnRequest(args.iface, sent, turnInputFromSession(sent)), onEvent),
			args.view,
			args.iface,
			events,
		);

		if (gatedToolFromEvents(events)) {
			return {
				ok: true,
				session: pauseTurn(args.session, events),
				assistantBlocks: foldAssistantTurn(args.iface, events),
			};
		}

		return {
			ok: true,
			session: commitCompletedTurn(args.session, events),
			assistantBlocks: foldAssistantTurn(args.iface, events),
		};
	} catch (err) {
		return withFailedTurnSession(
			turnFailure(err, args.iface.lexicon),
			(kept) => commitCompletedTurn(args.session, kept),
			events,
			args.seedEvents,
		);
	}
}

/** A turn that failed partway, committed as far as it got. */
export function failTurnStream(args: {
	session: InterfaceTurnSession;
	events: TurnEvent[];
	media: UserTurnHistoryMedia;
	failure: TurnFailure;
}): TurnFailure {
	return withFailedTurnSession(
		args.failure,
		(kept) => commitCompletedTurn(args.session, kept, args.media),
		args.events,
	);
}

/**
 * An answer to `callId`'s gate that failed. Once the call settled, the reply
 * commits as far as it got, or waits on its next gate; before, the reply waits
 * on the gate as it did (the host puts the call back), and the answer can go again.
 */
export function failGateAnswer(args: {
	/** The paused session the answer went out from. */
	session: InterfaceTurnSession;
	callId: string;
	/** The paused reply's events, then the answer's as far as they came. */
	events: TurnEvent[];
	failure: TurnFailure;
}): TurnFailure {
	const answered = args.events.slice(args.session.assistantEvents.length);
	if (!answered.some((event) => settlesToolCall(event, args.callId))) return args.failure;
	return { ...args.failure, session: finalizeTurnStream({ session: args.session, events: args.events, media: {} }) };
}

export function finalizeTurnStream(args: {
	session: InterfaceTurnSession;
	events: TurnEvent[];
	media: UserTurnHistoryMedia;
}): InterfaceTurnSession {
	if (gatedToolFromEvents(args.events)) {
		return pauseTurn(args.session, args.events, args.media);
	}
	return commitCompletedTurn(args.session, args.events, args.media);
}

export function streamFoldedTurn(args: {
	iface: ComposerProfileInterface;
	view: StreamView;
	/** Seeded by the caller, and filled as the stream delivers. */
	events: TurnEvent[];
	stream: (onEvent: TurnEventSink) => Promise<void>;
}): Promise<TurnEvent[]> {
	return streamFoldedEvents(args.stream, args.view, args.iface, args.events);
}

/** `blocks` with its last `turn-done` carrying the reply's work. */
export function stampWorked(
	blocks: TranscriptBlock[],
	worked: { workedMs: number; endedAt: number },
): TranscriptBlock[] {
	const last = blocks.findLastIndex((block) => block.kind === 'turn-done');
	if (last < 0) return blocks;
	return blocks.map((block, index) => (index === last ? { ...block, ...worked } : block));
}
