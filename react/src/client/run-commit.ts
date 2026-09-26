import type { TurnBlob, TurnEvent } from '../../../mod.ts';
import {
	appendAssistantEventsToHistory,
	appendUserDraftToHistory,
	applyTurnEventsToSession,
	type ComposerProfileInterface,
	type InterfaceTurnSession,
	gatedToolFromEvents,
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

/**
 * Streams into `events`, which the caller owns, so a stream that fails still
 * leaves what it delivered. An `unsupported` line is the host's to read on its
 * own transport: it never enters the turn, its history or its transcript.
 */
async function streamFoldedEvents(
	stream: (onEvent: TurnEventSink) => Promise<void>,
	onStream: (blocks: TranscriptBlock[]) => void,
	iface: ComposerProfileInterface,
	events: TurnEvent[],
): Promise<TurnEvent[]> {
	await stream((event) => {
		if (event.type === 'unsupported') return;
		events.push(event);
		onStream(foldAssistantTurn(iface, events));
	});
	return events;
}

export async function continueAfterTool(args: {
	iface: ComposerProfileInterface;
	transport: TheoremTransport;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
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
			args.onStream,
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
	onStream: (blocks: TranscriptBlock[]) => void;
	/** Seeded by the caller, and filled as the stream delivers. */
	events: TurnEvent[];
	stream: (onEvent: TurnEventSink) => Promise<void>;
}): Promise<TurnEvent[]> {
	return streamFoldedEvents(args.stream, args.onStream, args.iface, args.events);
}
