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
import type { TraceFeed } from './trace-feed.ts';
import { fetchJson, type HttpOptions } from './transport.ts';
import { checkWire } from './wire-line.ts';

/** One question as the page sees it: its answer type and the names of its options or levels. Instructions stay on the host. */
export type DecisionQuestionView = {
  id: string;
  type: DecisionQuestion['type'];
  /** A choice's labels, a score's levels from 0 up; empty for a number. */
  labels: string[];
  /**
   * A box's image: the one its question gives, a reference or a state field, else the field its
   * instructions first name in backticks.
   */
  field?: string;
};

/** What a decision profile shows the page. */
export type DecisionInterface = {
  type: 'decision';
  identity: { handle: string };
  contract: string;
  maxStateBytes?: number;
  questions: DecisionQuestionView[];
  /** The host's own images, by the reference its questions write, sent with every decision. */
  images?: Record<string, DecisionAsset>;
  observability?: { record: boolean };
};

/** A score level's name: its text, or the first text inside a structured entry. */
function entryLabel(entry: DecisionEntry, fallback: string): string {
  if (typeof entry === 'string') return entry;
  const entries = Array.isArray(entry) ? entry : Object.keys(entry);
  return entries.length ? entryLabel(entries[0], fallback) : fallback;
}

function withField(field: string | undefined): { field?: string } {
  return field === undefined ? {} : { field };
}

/** The first field an entry names in backticks, as in "the mug in `photo`". */
function namedField(entry: DecisionEntry): string | undefined {
  if (typeof entry === 'string') return /\x60([^\x60\s]+)\x60/.exec(entry)?.[1];
  const entries = Array.isArray(entry) ? entry : Object.values(entry);
  for (const each of entries) {
    const field = namedField(each);
    if (field !== undefined) return field;
  }
  return undefined;
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
    questions: Object.entries(questions).map(([id, question]) => ({
      id,
      type: question.type,
      labels:
        question.type === 'choice'
          ? Object.keys(question.criteria)
          : question.type === 'score'
            ? question.criteria.map((entry, level) => entryLabel(entry, String(level)))
            : [],
      ...(question.type === 'box'
        ? withField(question.image ?? namedField(question.instructions))
        : {}),
    })),
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
export type DecisionReply = { result: DecisionResult; traces?: TraceRecord[] };

export interface DecisionTransport {
  describe(signal?: AbortSignal): Promise<DecisionInterface>;
  /** `assets` are the images the state names, by reference. */
  decide(
    state: Exclude<DecisionJson, null>,
    signal?: AbortSignal,
    assets?: Record<string, DecisionAsset>,
  ): Promise<DecisionReply>;
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

export const failedDecisionTraces = failedTraces;

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
    questions: z.array(
      z.object({
        id: z.string(),
        type: z.enum(['choice', 'noul', 'score', 'box']),
        labels: z.array(z.string()),
        field: z.string().optional(),
      }),
    ),
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
    decide: (state, signal, assets) =>
      postDecision(`${base}/decide`, { state, ...(assets ? { assets } : {}) }, signal, options),
  };
}
