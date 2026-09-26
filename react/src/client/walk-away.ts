/**
 * A message sent while its reply waits on gates walks away from them in the
 * same request: `abandon` names the waiting calls, and the history carries the
 * paused reply with those calls open. The host settles each one cancelled and
 * streams those events ahead of the message's reply; once the last one
 * settles, the paused reply commits whole, and the message's reply begins.
 *
 * @module
 */

import { TheoremError, type TurnEvent, type TurnHistoryMessage } from '../../../mod.ts';
import {
	appendPausedTurnToHistory,
	type ComposerProfileInterface,
	gatedToolsFromEvents,
	type InterfaceTurnSession,
	settlesToolCall,
	type TranscriptBlock,
} from '../../../src/interface/mod.ts';
import { commitCompletedTurn, stampWorked } from './run-commit.ts';
import type { TurnEventSink } from './transport.ts';
import { foldAssistantTurn, type WalkAway } from './turn-client.ts';

/** The paused reply, committed with its settled calls, and its blocks as the transcript keeps them. */
export type WalkedAway = { session: InterfaceTurnSession; blocks: TranscriptBlock[] };

export type WalkingAway = {
	/** For `buildTurnRequest`: the paused session and the calls it waits on. */
	request: WalkAway;
	/** The paused reply as the model reads it, its waiting calls open. */
	history: TurnHistoryMessage[];
	/**
	 * The sink for the request's stream: each waiting call's events settle the
	 * paused reply, and `onSettled` fires once the last one has; every event
	 * after that is the message's reply, and goes on to `onEvent`.
	 */
	sink(onEvent: TurnEventSink, onSettled: (walked: WalkedAway) => void): TurnEventSink;
	/** Whether every waiting call has settled. */
	settled(): boolean;
};

/** Walk away from every call `paused` waits on; `workedMs` is the paused reply's work so far. */
export function walkAwayFrom(
	iface: ComposerProfileInterface,
	paused: InterfaceTurnSession,
	workedMs: number,
): WalkingAway {
	const calls = gatedToolsFromEvents(paused.assistantEvents);
	const waiting = new Set(calls.map((call) => call.callId));
	const events: TurnEvent[] = [...paused.assistantEvents];
	const settle = (event: TurnEvent): WalkedAway | undefined => {
		events.push(event);
		if (event.type === 'tool' && settlesToolCall(event, event.tool.callId)) waiting.delete(event.tool.callId);
		if (waiting.size) return undefined;
		return {
			session: commitCompletedTurn(paused, events),
			blocks: stampWorked(foldAssistantTurn(iface, events), { workedMs, endedAt: Date.now() }),
		};
	};
	return {
		request: { paused, calls },
		history: appendPausedTurnToHistory(paused.history, paused.assistantEvents),
		sink: (onEvent, onSettled) => (event) => {
			if (!waiting.size || event.type === 'unsupported') {
				onEvent(event);
				return;
			}
			if (event.type !== 'tool' || !waiting.has(event.tool.callId)) {
				// lexicon-exempt: internal diagnostic; the user reads the error kind's wording
				throw new TheoremError('bad_response', 'the reply began before the calls it walked away from settled');
			}
			const walked = settle(event);
			if (walked) onSettled(walked);
		},
		settled: () => waiting.size === 0,
	};
}
