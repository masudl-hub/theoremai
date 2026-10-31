/**
 * The browser side of a decision profile: what the host lets the page see of
 * it, and the one call that asks its questions about some state.
 *
 * @module
 */

import {
  type DecisionAnswer,
  type DecisionAsset,
  type DecisionEntry,
  type DecisionJson,
  type DecisionProfile,
  type DecisionQuestion,
  type DecisionResult,
  resolveObservabilityPolicy,
  TheoremError,
  type TraceRecord,
  traceRecordSchema,
  z,
} from '@theoremjs/agents';
import type { JsonSchema } from './schema-fields.ts';
import type { TraceFeed } from './trace-feed.ts';
import { fetchJson, type HttpOptions } from './transport.ts';
import { checkWire } from './wire-line.ts';

/** One question as the page sees it: its answer type and the names of its options or levels. Instructions stay on the host. */
export type DecisionQuestionView = {
  id: string;
  type: DecisionQuestion['type'];
  /** A choice's labels, a score's levels from 0 up; empty for a number. */
  labels: string[];
  /** A box's image, as its question gives it: a reference, or the state field that holds one. */
  image?: string;
};

/** What a decision profile shows the page. */
export type DecisionInterface = {
  type: 'decision';
  identity: { handle: string };
  contract: string;
  maxStateBytes?: number;
  /** The questions every decision asks. Empty when the host builds them for each decision. */
  questions: DecisionQuestionView[];
  /**
   * Set when the host builds the questions for each decision, from its state and, when `input`
   * is set, from what the page fills in by that JSON Schema. Each result names the questions it answers.
   */
  build?: { input?: JsonSchema };
  /** The host's own images, by the reference its questions write, sent with every decision. */
  images?: Record<string, DecisionAsset>;
  observability?: { record: boolean };
};

/** A decision's result: the answers and, when the host built its questions for it, those questions. */
export type DecisionReplyResult = DecisionResult & { questions?: DecisionQuestionView[] };

/** A score level's name: its text, or the first text inside a structured entry. */
function entryLabel(entry: DecisionEntry, fallback: string): string {
  if (typeof entry === 'string') return entry;
  const entries = Array.isArray(entry) ? entry : Object.keys(entry);
  return entries.length ? entryLabel(entries[0], fallback) : fallback;
}

/** Questions as the page sees them: their answer types and labels, never their instructions. */
export function questionViews(questions: Record<string, DecisionQuestion>): DecisionQuestionView[] {
  return Object.entries(questions).map(([id, question]) => ({
    id,
    type: question.type,
    labels:
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.type === 'score'
          ? question.criteria.map((entry, level) => entryLabel(entry, String(level)))
          : [],
    ...(question.type === 'box' && question.image !== undefined ? { image: question.image } : {}),
  }));
}

/** The page's view of a decision profile, the questions its host asks, and the host's own images. */
export function decisionInterface(
  profile: Pick<DecisionProfile, 'identity' | 'decision' | 'inputs' | 'observability'>,
  questions: Record<string, DecisionQuestion>,
  images?: Record<string, DecisionAsset>,
): DecisionInterface {
  return {
    type: 'decision',
    identity: { handle: profile.identity.handle },
    contract: profile.decision.contract,
    ...(profile.inputs.maxStateBytes === undefined
      ? {}
      : { maxStateBytes: profile.inputs.maxStateBytes }),
    questions: questionViews(questions),
    ...(images && Object.keys(images).length > 0 ? { images } : {}),
    ...(profile.observability
      ? { observability: { record: resolveObservabilityPolicy(profile.observability).record } }
      : {}),
  };
}

/**
 * The images a decision sends: the host's own and the page's. A page image may not take a name
 * the host's use, so the questions always read the host's picture.
 */
export function decisionAssets(
  host: Record<string, DecisionAsset> | undefined,
  page: Record<string, DecisionAsset> | undefined,
): Record<string, DecisionAsset> | undefined {
  const clash = Object.keys(page ?? {}).find((name) => host && Object.hasOwn(host, name));
  if (clash !== undefined)
    // labels-exempt: internal diagnostic; the user reads error.request
    throw new TheoremError(
      'request',
      `the image ${clash} is the host's, so the page's needs another name`,
    );
  const all = { ...host, ...page };
  return Object.keys(all).length > 0 ? all : undefined;
}

/** A decision's reply: the answers, and the trace records a host that delivers them sent back. */
export type DecisionReply = { result: DecisionReplyResult; traces?: TraceRecord[] };

export interface DecisionTransport {
  describe(signal?: AbortSignal): Promise<DecisionInterface>;
  /** `assets` are the images the state names, by reference; `input` is what the host's question builder takes. */
  decide(
    state: Exclude<DecisionJson, null>,
    signal?: AbortSignal,
    assets?: Record<string, DecisionAsset>,
    input?: unknown,
  ): Promise<DecisionReply>;
  /** Where the host's trace records land, for the inspector. */
  traces?: TraceFeed;
}

// why: The host's kernel checks each answer against its question; the page checks only the shape it draws.
const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const answerSchema: z.ZodType<DecisionAnswer> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: probability,
    probabilities,
  }),
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('box'),
    box: z.object({ top: probability, bottom: probability, left: probability, right: probability }),
    confidence: probability,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number().nonnegative(),
    confidence: probability,
    legend: z.record(z.string(), z.string().min(1)),
    probabilities,
  }),
]);
const questionViewSchema = z.object({
  id: z.string(),
  type: z.enum(['choice', 'noul', 'score', 'box']),
  labels: z.array(z.string()),
  image: z.string().optional(),
});
const replySchema = z.object({
  result: z.object({
    model: z.string().min(1),
    questions: z.array(questionViewSchema).optional(),
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

/** The trace records a failed decision left, by the failure thrown for it. */
const traceFailures = new WeakMap<object, readonly TraceRecord[]>();

/** Marks a decision's failure with the trace records it left, for the page's inspector. */
export function withFailedTraces(err: unknown, traces: readonly TraceRecord[]): unknown {
  if (traces.length > 0 && typeof err === 'object' && err !== null) traceFailures.set(err, traces);
  return err;
}

/** The trace records a failed decision left; none when its host sent none. */
export function failedTraces(err: unknown): readonly TraceRecord[] {
  return (typeof err === 'object' && err !== null && traceFailures.get(err)) || [];
}

const failedBody = z.object({ traces: z.array(traceRecordSchema) });

/** POSTs `body` and reads its reply with `read`; a failure keeps the trace records its body carried. */
export async function postWithTraces<Reply>(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  options: HttpOptions,
  read: (raw: unknown) => Reply,
): Promise<Reply> {
  let traces: readonly TraceRecord[] = [];
  const failed = (raw: unknown) => {
    const parsed = failedBody.safeParse(raw);
    if (parsed.success) traces = parsed.data.traces;
  };
  try {
    return read(await fetchJson(url, { body, signal, failed }, options));
  } catch (err) {
    throw withFailedTraces(err, traces);
  }
}

/** POSTs a decision and reads its reply; a failure keeps the trace records its body carried. */
export function postDecision(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  options: HttpOptions = {},
): Promise<DecisionReply> {
  return postWithTraces(url, body, signal, options, readDecisionReply);
}

/** A host's decide reply, checked: the answers, and any trace records it delivers. */
export function readDecisionReply(raw: unknown): DecisionReply {
  // labels-exempt: internal diagnostic; the user reads error.bad_response
  return checkWire(replySchema, raw, 'the decision');
}
const describedSchema = z.object({
  interface: z.object({
    type: z.literal('decision'),
    identity: z.object({ handle: z.string() }),
    contract: z.string(),
    maxStateBytes: z.number().optional(),
    questions: z.array(questionViewSchema),
    build: z.object({ input: z.record(z.string(), z.unknown()).optional() }).optional(),
    images: z
      .record(
        z.string(),
        z.object({ mimeType: z.enum(['image/png', 'image/jpeg']), data: z.string() }),
      )
      .optional(),
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
        'the decision description', // labels-exempt: internal diagnostic; the user reads error.bad_response
      ).interface;
    },
    decide: (state, signal, assets, input) =>
      postDecision(
        `${base}/decide`,
        { state, ...(assets ? { assets } : {}), ...(input === undefined ? {} : { input }) },
        signal,
        options,
      ),
  };
}
