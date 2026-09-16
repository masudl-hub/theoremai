import type { TurnBlob, TurnEvent } from 'theorum';
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
import type { PlaygroundRunPayload } from './run-payload';
import {
	buildTurnRequestBody,
	foldAssistantTurn,
	playgroundFailureFromError,
	streamPlaygroundTurn,
	turnInputFromSession,
} from './turn-client';

function commitCompletedTurn(
	session: InterfaceTurnSession,
	events: TurnEvent[],
	media: UserTurnHistoryMedia,
): InterfaceTurnSession {
	const history = session.pendingUserDraft
		? appendUserDraftToHistory(session.history, session.pendingUserDraft, media)
		: session.history;

	return {
		...applyTurnEventsToSession(session, events),
		history: appendAssistantEventsToHistory(history, events),
		gatedTool: null,
		assistantEvents: [],
		pendingUserDraft: null,
		toolSnapshot: undefined,
		promotedToolIds: [],
	};
}

function commitContinuationTurn(
	session: InterfaceTurnSession,
	seedLength: number,
	events: TurnEvent[],
): InterfaceTurnSession {
	return {
		...applyTurnEventsToSession(session, events),
		history: appendAssistantEventsToHistory(session.history, events.slice(seedLength)),
		gatedTool: null,
		assistantEvents: [],
		pendingUserDraft: null,
		toolSnapshot: undefined,
		promotedToolIds: [],
	};
}

function pauseTurn(
	session: InterfaceTurnSession,
	events: TurnEvent[],
	media: UserTurnHistoryMedia,
): InterfaceTurnSession {
	const history = session.pendingUserDraft
		? appendUserDraftToHistory(session.history, session.pendingUserDraft, media)
		: session.history;

	const gated = gatedToolFromEvents(events);
	return {
		...applyTurnEventsToSession(session, events),
		history,
		gatedTool: gated,
		assistantEvents: [...events],
		pendingUserDraft: null,
	};
}

function pauseContinuationTurn(
	session: InterfaceTurnSession,
	seedLength: number,
	events: TurnEvent[],
): InterfaceTurnSession {
	const gated = gatedToolFromEvents(events);
	return {
		...applyTurnEventsToSession(session, events),
		history: appendAssistantEventsToHistory(session.history, events.slice(seedLength)),
		gatedTool: gated,
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

async function streamFoldedEvents(
	stream: (onEvent: (event: TurnEvent) => void) => Promise<void>,
	onStream: (blocks: TranscriptBlock[]) => void,
	iface: ComposerProfileInterface,
	seedEvents: TurnEvent[],
): Promise<TurnEvent[]> {
	const events = [...seedEvents];
	await stream((event) => {
		events.push(event);
		onStream(foldAssistantTurn(iface, events));
	});
	return events;
}

export async function continueAfterTool(args: {
	iface: ComposerProfileInterface;
	payload: PlaygroundRunPayload;
	session: InterfaceTurnSession;
	onStream: (blocks: TranscriptBlock[]) => void;
	seedEvents: TurnEvent[];
}): Promise<
	| { ok: true; session: InterfaceTurnSession; assistantBlocks: TranscriptBlock[] }
	| { ok: false; error: string; errorInternal?: string }
> {
	const seedLength = args.seedEvents.length;
	try {
		const events = await streamFoldedEvents(
			(onEvent) =>
				streamPlaygroundTurn(
					buildTurnRequestBody(args.payload, args.session, turnInputFromSession(args.session)),
					onEvent,
				),
			args.onStream,
			args.iface,
			args.seedEvents,
		);

		if (gatedToolFromEvents(events)) {
			return {
				ok: true,
				session: pauseContinuationTurn(args.session, seedLength, events),
				assistantBlocks: foldAssistantTurn(args.iface, events),
			};
		}

		return {
			ok: true,
			session: commitContinuationTurn(args.session, seedLength, events),
			assistantBlocks: foldAssistantTurn(args.iface, events),
		};
	} catch (err) {
		return playgroundFailureFromError(err);
	}
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
	seedEvents: TurnEvent[];
	stream: (onEvent: (event: TurnEvent) => void) => Promise<void>;
}): Promise<TurnEvent[]> {
	return streamFoldedEvents(args.stream, args.onStream, args.iface, args.seedEvents);
}
