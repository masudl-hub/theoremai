/**
 * The live wire between the browser and a host's relay: the messages the live
 * client sends (a relay reads them with `parseLiveClientMessage`) and the envelopes it reads
 * back, each checked against its schema.
 *
 * @module
 */

import { z } from '../../../mod.ts';
import {
	GATE_DECISIONS,
	type GateDecision,
	type ToolGate,
	type TraceRecord,
	toolGateSchema,
	traceRecordSchema,
	TURN_EVENT_SCHEMAS,
	type TurnEvent,
} from '../../../mod.ts';
import type { Equals } from '../../../src/kernel/util/exact-type.ts';
import { type HostErrorBody, hostErrorBodySchema } from './transport.ts';
import { parseWireLine, type UnsupportedEvent, type WireLines } from './wire-line.ts';

/** What the live client sends its relay, besides the host's own `openMessage`. */
export type LiveClientMessage =
	| { type: 'audio'; data: string }
	| { type: 'video'; data: string; mimeType: string }
	| { type: 'text'; text: string }
	/** Run a call the model made, by its id; the live session holds its name, input and gate. */
	| { type: 'executeTool'; callId: string; decision?: GateDecision; input?: unknown; secret?: string };
const liveClientMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('audio'), data: z.string() }),
	z.object({ type: z.literal('video'), data: z.string(), mimeType: z.string() }),
	z.object({ type: z.literal('text'), text: z.string() }),
	z.object({
		type: z.literal('executeTool'),
		callId: z.string().min(1),
		decision: z.enum(GATE_DECISIONS).optional(),
		input: z.unknown().optional(),
		secret: z.string().optional(),
	}),
]);
true satisfies Equals<z.infer<typeof liveClientMessage>, LiveClientMessage>;
/** The live client's messages, as `parseLiveClientMessage` checks them for a relay. */
export const liveClientMessageSchema: z.ZodType<LiveClientMessage> = liveClientMessage;

/** The envelopes a relay sends the live client. */
export type LiveServerEnvelope =
	| { type: 'ready'; profile?: string; sessionId?: string }
	/** The session's events; one of a kind this client does not know arrives as `unsupported`. */
	| { type: 'events'; events: (TurnEvent | UnsupportedEvent)[] }
	/** A trace record the session wrote, from a relay that delivers its traces (the playground). */
	| { type: 'trace'; record: TraceRecord }
	/** The relay's error body, read as a host error. */
	| ({ type: 'error' } & HostErrorBody)
	/**
	 * The relay's answer to the browser's `executeTool`: the session settled the
	 * call (its tool events carry what happened), holds it on a gate, or refused
	 * the message (the relay's error body, read as a host error).
	 */
	| { type: 'executeToolResult'; callId: string; status: 'settled' }
	| { type: 'executeToolResult'; callId: string; status: 'gated'; gate: ToolGate }
	| { type: 'executeToolResult'; callId: string; status: 'refused'; body: HostErrorBody };

/** Each envelope kind as it arrives: `events` holds values each checked as a turn event on its own. */
type LiveServerWireEnvelope = Exclude<LiveServerEnvelope, { type: 'events' }> | { type: 'events'; events: unknown[] };

const liveServerEnvelopeKinds = {
	ready: z.object({ type: z.literal('ready'), profile: z.string().optional(), sessionId: z.string().optional() }),
	events: z.object({ type: z.literal('events'), events: z.array(z.unknown()) }),
	trace: z.object({ type: z.literal('trace'), record: traceRecordSchema }),
	error: z.object({ type: z.literal('error') }).and(hostErrorBodySchema),
	executeToolResult: z.discriminatedUnion('status', [
		z.object({ type: z.literal('executeToolResult'), callId: z.string(), status: z.literal('settled') }),
		z.object({
			type: z.literal('executeToolResult'),
			callId: z.string(),
			status: z.literal('gated'),
			gate: toolGateSchema,
		}),
		z.object({
			type: z.literal('executeToolResult'),
			callId: z.string(),
			status: z.literal('refused'),
			body: hostErrorBodySchema,
		}),
	]),
};
true satisfies Equals<
	z.infer<(typeof liveServerEnvelopeKinds)[keyof typeof liveServerEnvelopeKinds]>,
	LiveServerWireEnvelope
>;
const liveServerEnvelopeLines: WireLines<LiveServerWireEnvelope> = liveServerEnvelopeKinds;

/**
 * One envelope from the relay, checked: an envelope or event of a kind this
 * client does not know is `unsupported`; a malformed one throws `bad_response`.
 */
export function parseLiveServerEnvelope(raw: unknown): LiveServerEnvelope | UnsupportedEvent {
	const envelope = parseWireLine(liveServerEnvelopeLines, raw);
	if (envelope.type !== 'events') return envelope;
	return { type: 'events', events: envelope.events.map((event) => parseWireLine(TURN_EVENT_SCHEMAS, event)) };
}

/** What the session did with an `executeTool`: settled the call, or holds it on a gate. */
export type LiveToolStep = { status: 'settled' } | { status: 'gated'; gate: ToolGate };

/**
 * Ask the relay to run `LiveSession.executeTool` for a call the model made.
 * `decision` answers its gate; `input` is the user's edit to an approval;
 * `secret` is the key the user typed at a sign-in gate, sent once: the
 * session makes it the credential for the gate's slot.
 */
export type ExecuteToolOnRelay = (
	args: Omit<Extract<LiveClientMessage, { type: 'executeTool' }>, 'type'>,
) => Promise<LiveToolStep>;
