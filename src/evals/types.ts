/**
 * Eval shapes: the suite a host writes, the cases it keeps in JSONL,
 * and the result every grader returns. Each is a documented type and a zod
 * schema checked against it (`Equals`): the type is what graders read; the
 * schema is what the runner runs on a file.
 *
 * Vocabulary follows Anthropic's evals guide so a host can read both: a
 * **suite** of **cases**, each run as k **trials**; a **grader** reads a
 * trial's transcript (its trace) and returns a **result**; the suite's pass
 * rule turns k results into one **verdict**.
 *
 * @module
 */

import { z } from 'zod';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import type { TurnTokens } from '../kernel/turn-events.ts';
import type { ModelProvider } from '../kernel/types.ts';
import type { Equals } from '../kernel/util/exact-type.ts';
import { isRecord } from '../kernel/util/record.ts';
import type { TraceRecord } from '../observability/trace-record.ts';
import type { TraceAttributeValue, TraceSpan } from '../observability/trace-span.ts';

/** Anthropic's split: does the agent *do* the thing (capability), or *still* do it (regression)? */
export type EvalCaseKind = 'capability' | 'regression';
const evalCaseKind = z.enum(['capability', 'regression']);
true satisfies Equals<z.infer<typeof evalCaseKind>, EvalCaseKind>;

/** A file the case attaches to its turn, inline, as `TurnBlob` takes it. */
export interface EvalInlineAttachment {
  mimeType: string;
  /** Base64 bytes. */
  data: string;
  name?: string;
}
const evalInlineAttachment = z.object({
  mimeType: z.string(),
  data: z.string(),
  name: z.string().optional(),
});
true satisfies Equals<z.infer<typeof evalInlineAttachment>, EvalInlineAttachment>;

/**
 * A file the case attaches to its turn, kept beside the cases file and pinned
 * by the hex SHA-256 of its bytes; a file whose bytes hash otherwise is refused.
 */
export interface EvalFileAttachment {
  mimeType: string;
  /** Relative to the cases file, or absolute; the loaded case holds it absolute. */
  path: string;
  sha256: string;
  name?: string;
}
const evalFileAttachment = z.object({
  mimeType: z.string(),
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256'),
  name: z.string().optional(),
});
true satisfies Equals<z.infer<typeof evalFileAttachment>, EvalFileAttachment>;

/** A file the case attaches to its turn: its bytes inline, or a file beside the cases. */
export type EvalAttachment = EvalInlineAttachment | EvalFileAttachment;
const evalAttachment = z.union([evalInlineAttachment, evalFileAttachment]);
true satisfies Equals<z.infer<typeof evalAttachment>, EvalAttachment>;

/** One turn's input (`mode: 'turn'`). */
export interface EvalTurnInput {
  text?: string;
  attachments?: EvalAttachment[];
}
const evalTurnInput = z.object({
  text: z.string().optional(),
  attachments: z.array(evalAttachment).optional(),
});
true satisfies Equals<z.infer<typeof evalTurnInput>, EvalTurnInput>;

/** One scripted step of a Live session: send text, wait for the boundary it names. */
export interface EvalSessionStep {
  text: string;
  until: 'turn_complete';
}
const evalSessionStep = z.object({ text: z.string(), until: z.literal('turn_complete') });
true satisfies Equals<z.infer<typeof evalSessionStep>, EvalSessionStep>;

/** A scripted Live session (`mode: 'session'`): text steps in order. Audio steps are not in this slice. */
export interface EvalSessionInput {
  session: { steps: EvalSessionStep[] };
}
const evalSessionInput = z.object({ session: z.object({ steps: z.array(evalSessionStep) }) });
true satisfies Equals<z.infer<typeof evalSessionInput>, EvalSessionInput>;

/** What the case sends: a turn's input or a session script. */
export type EvalCaseInput = EvalTurnInput | EvalSessionInput;
const evalCaseInput = z.union([evalSessionInput, evalTurnInput]);
true satisfies Equals<z.infer<typeof evalCaseInput>, EvalCaseInput>;

/**
 * A dataset case's right answer. Only an `accepted` name passes; a `partial`
 * one is close but not enough (the genus, the broader condition); a `rejected`
 * one is a wrong answer the dataset records for the case (a confuser, an
 * identification it superseded).
 */
export interface EvalAnswer {
  /** Every name that counts: scientific name, synonyms, common names. */
  accepted: string[];
  partial?: string[];
  /** A reply that names one beside an accepted name hedged: `partial`, not a pass. */
  rejected?: string[];
  /** Grounding notes for the person reading a miss; no grader reads them. */
  reference?: string;
}
const evalAnswer = z.object({
  accepted: z.array(z.string().min(1)).min(1),
  partial: z.array(z.string().min(1)).optional(),
  rejected: z.array(z.string().min(1)).optional(),
  reference: z.string().optional(),
});
true satisfies Equals<z.infer<typeof evalAnswer>, EvalAnswer>;

/** What the transcript should contain; graders that need it are skipped when it is absent. */
export interface EvalExpect {
  /** Tools the agent should call, in order (`toolTrajectory` reads it). Empty = no tool. */
  tools?: string[];
  /** Fields the delivered JSON should carry, each compared whole (`delivered.json` reads it). */
  json?: Record<string, unknown>;
  /** What the Live reply's transcript should say (`transcription.*` read it). */
  transcription?: { includes?: string; regex?: string };
  /** The right answer to a dataset question (`answer` reads it). */
  answer?: EvalAnswer;
  /** For the human reading the case; no grader reads it. */
  notes?: string;
}
const evalExpect = z.object({
  tools: z.array(z.string()).optional(),
  json: z.record(z.string(), z.unknown()).optional(),
  transcription: z
    .object({ includes: z.string().optional(), regex: z.string().optional() })
    .optional(),
  answer: evalAnswer.optional(),
  notes: z.string().optional(),
});
true satisfies Equals<z.infer<typeof evalExpect>, EvalExpect>;

/** Perplexity's 1–5 difficulty; results are reported per bucket when set. */
export type EvalDifficulty = 1 | 2 | 3 | 4 | 5;
const evalDifficulty = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
true satisfies Equals<z.infer<typeof evalDifficulty>, EvalDifficulty>;

/** One line of `cases.jsonl`. */
export interface EvalCase {
  id: string;
  kind: EvalCaseKind;
  difficulty?: EvalDifficulty;
  input: EvalCaseInput;
  expect?: EvalExpect;
  tags?: string[];
}
const evalCase = z.object({
  id: z.string().min(1),
  kind: evalCaseKind,
  difficulty: evalDifficulty.optional(),
  input: evalCaseInput,
  expect: evalExpect.optional(),
  tags: z.array(z.string()).optional(),
});
true satisfies Equals<z.infer<typeof evalCase>, EvalCase>;
/** What the runner runs on each line of a cases file. */
export const evalCaseSchema: z.ZodType<EvalCase> = evalCase;

/** The `gen_ai.operation.name` values a trial's spans carry. */
export type TraceOperation = 'invoke_agent' | 'chat' | 'generate_content' | 'execute_tool';

/** A message as the trace stores it: `{ role, parts: [...] }`, parts by hash; resolve them with `text` / `content`. */
export type TrialMessage = Record<string, TraceAttributeValue>;

/** What the root span reports the trial cost, as the kernel's `TurnTokens`. */
export interface TrialUsage {
  tokens: TurnTokens;
  costUsd?: number;
}

/**
 * One run of one case, as every grader receives it: the trace records that
 * share the trial's trace id and nothing else. If a grader needs a fact the
 * trace does not hold, the trace is wrong, not the grader.
 */
export interface Trial {
  suite: string;
  /** Absent in caseless recorded mode (a production trace with no `metadata.eval`). */
  case?: EvalCase;
  /** 0..k-1. */
  index: number;
  records: TraceRecord[];
  /** The `invoke_agent` span with no agent above it in the set; never assumed to be first. */
  root: TraceSpan;
  /**
   * The topmost span above `root` in the set: the host's own span when the host
   * nested the turn under it, else `root`. Its length is the trial's time.
   */
  top: TraceSpan;
  /** Spans by operation, in start order, across every record. */
  spans: (operation: TraceOperation) => TraceSpan[];
  /** The spans one span parents, in start order (a model call's HTTP tries, a response's tool calls). */
  children: (span: TraceSpan) => TraceSpan[];
  /** A value with every `{ content_sha256 }` / `{ json_sha256 }` reference replaced by its stored content. */
  content: (value: unknown) => unknown;
  /** The stored text one reference names; `undefined` for any other value. */
  text: (value: unknown) => string | undefined;
  /** What the host received: the root's output messages, or each Live response's, as stored. */
  delivered: () => TrialMessage[];
  /** Tokens and cost from the root's usage attributes. */
  usage: () => TrialUsage;
}

/** Who produced a result: a code grader, or a judge model. */
export type EvalResultSource = 'code' | 'model';
const evalResultSource = z.enum(['code', 'model']);
true satisfies Equals<z.infer<typeof evalResultSource>, EvalResultSource>;

/**
 * One grader's reading of one trial: the semconv `gen_ai.evaluation.result`
 * event, before it is written. `passed` is the grader's yes/no when it has one;
 * absent means the result informs but does not decide the verdict.
 */
export interface EvalResult {
  /** The grader's name, e.g. `tool_trajectory`, `faithfulness`. */
  name: string;
  source: EvalResultSource;
  /** `value` is 0–1 unless the grader says otherwise; `label` is one of the grader's labels. */
  score?: { value?: number; label?: string };
  /** Why, in the grader's words. */
  explanation?: string;
  /** Whether this result counts as a pass. Absent: informational only. */
  passed?: boolean;
  /** Why no score could be produced; the result is then a failed one. */
  errorType?: string;
  /** Judge turns this result was drawn from (`traceparent` each); model graders only. */
  judgeTraceparents?: string[];
}
const evalResult = z.object({
  name: z.string().min(1),
  source: evalResultSource,
  score: z.object({ value: z.number().optional(), label: z.string().optional() }).optional(),
  explanation: z.string().optional(),
  passed: z.boolean().optional(),
  errorType: z.string().optional(),
  judgeTraceparents: z.array(z.string()).optional(),
});
true satisfies Equals<z.infer<typeof evalResult>, EvalResult>;
/** A result as a reader validates it, e.g. one rebuilt from a written event. */
export const evalResultSchema: z.ZodType<EvalResult> = evalResult;

/** How k trials become one verdict: every trial (pass^k), any trial (pass@k), or at least n. */
export type EvalPassRule = 'all' | 'any' | { atLeast: number };
const evalPassRule = z.union([
  z.literal('all'),
  z.literal('any'),
  z.object({ atLeast: z.number().int().min(1) }),
]);
true satisfies Equals<z.infer<typeof evalPassRule>, EvalPassRule>;

/** How many times each case runs, and what counts as passing. */
export interface EvalTrials {
  /** Trials per case. No default: it is a cost decision, so the suite states it. `1` cannot tell noise from change. */
  repeat: number;
  /** Default `all`. */
  pass?: EvalPassRule;
}
const evalTrials = z.object({
  repeat: z.number().int().min(1),
  pass: evalPassRule.optional(),
});
true satisfies Equals<z.infer<typeof evalTrials>, EvalTrials>;

/**
 * What the runner hands every grader beside the trial. Code graders ignore it;
 * a model grader runs its judge through it and reports each judge call's
 * records through `traced`, so the runner can count their cost and write them
 * to the sink.
 */
export interface EvalGradeContext {
  /** The suite's judge profile, when it names one; a grader may name its own. */
  judge?: string;
  /** The host's provider for text judge profiles. */
  judgeProvider?: ModelProvider;
  /** The host's vault for decision judge profiles. */
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  /**
   * The trial span as a W3C `traceparent`: a judge call runs under it, so it
   * lands in the judged trace beneath the trial. Absent, each judge call
   * starts a trace of its own.
   */
  traceparent?: string;
  /**
   * The host's store for media a trace names only by hash. A judge that must
   * see media the case did not attach asks here; absent, only the case's own
   * attachments can be shown.
   */
  media?: EvalMediaResolver;
  /** Every record a grader's own judge call produced. */
  traced: (records: TraceRecord[]) => void | Promise<void>;
  signal?: AbortSignal;
}

/** Media a trace names by the sha256 (hex) of its raw bytes. */
export interface EvalMediaRef {
  sha256: string;
  mimeType: string;
}

/** The media's bytes as base64, or `undefined` when the host does not have them. */
export type EvalMediaResolver = (
  ref: EvalMediaRef,
) => string | undefined | Promise<string | undefined>;

/** Code or model logic that reads a trial and returns a result. */
export interface EvalGrader {
  /** The result's `gen_ai.evaluation.name`. */
  name: string;
  /**
   * Stable text naming exactly what this grader checks (its options, its
   * rubric). Its sha256 is written as `theorem.evaluation.grader.version`, so
   * a later reader can tell which rubric produced which score.
   */
  identity: string;
  source: EvalResultSource;
  /** Reads the case's `expect`; skipped when a trial has no case (caseless recorded mode). */
  needsExpect: boolean;
  /**
   * Model graders: every judge profile this grader may run, given the suite's
   * `judge.profile`: its judge first, then any it escalates to. Throws when
   * there is none, or a profile cannot run this grader, so a suite fails
   * before its first trial.
   */
  judgeProfiles?: (suiteJudge: string | undefined) => string[];
  grade: (trial: Trial, context: EvalGradeContext) => EvalResult | Promise<EvalResult>;
}
function isGrader(value: unknown): value is EvalGrader {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.identity === 'string' &&
    (value.source === 'code' || value.source === 'model') &&
    typeof value.needsExpect === 'boolean' &&
    (value.judgeProfiles === undefined || typeof value.judgeProfiles === 'function') &&
    typeof value.grade === 'function'
  );
}
const evalGrader = z.custom<EvalGrader>(isGrader);

/** A named set of cases against one profile, with graders and a pass rule. */
export interface EvalSuite {
  id: string;
  /** The profile under test; any type but `host`. */
  profile: string;
  mode: 'turn' | 'session';
  /** Path to `cases.jsonl`, relative to the suite module. */
  cases: string;
  trials: EvalTrials;
  graders: EvalGrader[];
  /**
   * The judge profile model graders run unless they name their own: a text
   * profile that answers through `evalJudgment`, or a decision profile (Jev).
   */
  judge?: { profile: string };
}
const evalSuite = z.object({
  id: z.string().min(1),
  profile: z.string().min(1),
  mode: z.enum(['turn', 'session']),
  cases: z.string().min(1),
  trials: evalTrials,
  graders: z.array(evalGrader),
  judge: z.object({ profile: z.string().min(1) }).optional(),
});
true satisfies Equals<z.infer<typeof evalSuite>, EvalSuite>;
/** What the runner runs on a suite module's default export. */
export const evalSuiteSchema: z.ZodType<EvalSuite> = evalSuite;
