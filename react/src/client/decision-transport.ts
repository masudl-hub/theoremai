/**
 * The browser side of a decision profile: what the host lets the page see of
 * it, and the one call that asks its questions about some state.
 *
 * @module
 */

import {
	type DecisionAnswer,
	type DecisionEntry,
	type DecisionJson,
	type DecisionProfile,
	type DecisionQuestion,
	type DecisionResult,
	resolveObservabilityPolicy,
	type TraceRecord,
	traceRecordSchema,
	z,
} from '@theoremjs/agents';
import type { TraceFeed } from './trace-feed.ts';
import { fetchJson, type HttpOptions } from './transport.ts';
import { checkWire } from './wire-line.ts';

/** One question as the page sees it: its answer type and the names of its options or levels. Instructions stay on the host. */
export type DecisionQuestionView = {
	id: string;
	type: DecisionQuestion['type'];
	/** A choice's labels, a score's levels from 0 up; empty for a number. */
	labels: string[];
};

/** What a decision profile shows the page. */
export type DecisionInterface = {
	type: 'decision';
	identity: { handle: string };
	contract: string;
	maxStateBytes?: number;
	questions: DecisionQuestionView[];
	observability?: { record: boolean };
};

/** A score level's name: its text, or the first text inside a structured entry. */
function entryLabel(entry: DecisionEntry, fallback: string): string {
	if (typeof entry === 'string') return entry;
	const entries = Array.isArray(entry) ? entry : Object.keys(entry);
	return entries.length ? entryLabel(entries[0], fallback) : fallback;
}

/** The page's view of a decision profile and the questions its host asks. */
export function decisionInterface(
	profile: Pick<DecisionProfile, 'identity' | 'decision' | 'inputs' | 'observability'>,
	questions: Record<string, DecisionQuestion>,
): DecisionInterface {
	return {
		type: 'decision',
		identity: { handle: profile.identity.handle },
		contract: profile.decision.contract,
		...(profile.inputs.maxStateBytes === undefined
			? {}
			: { maxStateBytes: profile.inputs.maxStateBytes }),
		questions: Object.entries(questions).map(([id, question]) => ({
			id,
			type: question.type,
			labels:
				question.type === 'choice'
					? Object.keys(question.criteria)
					: question.type === 'score'
						? question.criteria.map((entry, level) => entryLabel(entry, String(level)))
						: [],
		})),
		...(profile.observability
			? { observability: { record: resolveObservabilityPolicy(profile.observability).record } }
			: {}),
	};
}

/** A decision's reply: the answers, and the trace records a host that delivers them sent back. */
export type DecisionReply = { result: DecisionResult; traces?: TraceRecord[] };

export interface DecisionTransport {
	describe(signal?: AbortSignal): Promise<DecisionInterface>;
	decide(state: Exclude<DecisionJson, null>, signal?: AbortSignal): Promise<DecisionReply>;
	/** Where the host's trace records land, for the inspector. */
	traces?: TraceFeed;
}

const probability = z.number().min(0).max(1);
const probabilities = z
	.record(z.string(), probability)
	.refine(
		(record) => Math.abs(Object.values(record).reduce((sum, value) => sum + value, 0) - 1) <= 0.001,
	);
const answerSchema: z.ZodType<DecisionAnswer> = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('choice'),
		choice: z.string(),
		confidence: probability,
		probabilities,
	}),
	z.object({ type: z.literal('noul'), noul: probability }),
	z.object({
		type: z.literal('score'),
		score: z.number().nonnegative(),
		confidence: probability,
		legend: z.record(z.string(), z.string().min(1)),
		probabilities,
	}),
]);
const replySchema = z.object({
	result: z.object({
		model: z.string().min(1),
		answers: z.record(z.string(), answerSchema),
		usage: z
			.object({
				inputTokens: z.number().int().nonnegative(),
				outputTokens: z.number().int().nonnegative(),
				costUsd: z.number().nonnegative().optional(),
			})
			.optional(),
	}),
	traces: z.array(traceRecordSchema).optional(),
});

/** A host's decide reply, checked: the answers, and any trace records it delivers. */
export function readDecisionReply(raw: unknown): DecisionReply {
	// lexicon-exempt: internal diagnostic; the user reads error.bad_response
	return checkWire(replySchema, raw, 'the decision');
}
const describedSchema = z.object({
	interface: z.object({
		type: z.literal('decision'),
		identity: z.object({ handle: z.string() }),
		contract: z.string(),
		maxStateBytes: z.number().optional(),
		questions: z.array(
			z.object({
				id: z.string(),
				type: z.enum(['choice', 'noul', 'score']),
				labels: z.array(z.string()),
			}),
		),
		observability: z.object({ record: z.boolean() }).optional(),
	}),
});

/** Transport for a host mounted with `createTheoremDecisionHandler`. Default endpoint `/api/decision`. */
export function createDecisionTransport(
	options: HttpOptions & { endpoint?: string } = {},
): DecisionTransport {
	const base = (options.endpoint ?? '/api/decision').replace(/\/$/, '');
	return {
		async describe(signal) {
			return checkWire(
				describedSchema,
				await fetchJson(base, { signal }, options),
				'the decision description', // lexicon-exempt: internal diagnostic; the user reads error.bad_response
			).interface;
		},
		decide: async (state, signal) =>
			readDecisionReply(await fetchJson(`${base}/decide`, { body: { state }, signal }, options)),
	};
}
