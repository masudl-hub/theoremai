import { z } from 'zod';
import type { RunDecisionOptions } from '../kernel/engine/decision.ts';
import type { TurnTokens } from '../kernel/turn-events.ts';
import type { ModelProvider } from '../kernel/types.ts';
import type { Equals } from '../kernel/util/exact-type.ts';
import { isRecord } from '../kernel/util/record.ts';
import type { TraceRecord } from '../observability/trace-record.ts';
import type { TraceAttributeValue, TraceSpan } from '../observability/trace-span.ts';

export type EvalCaseKind = 'capability' | 'regression';
const evalCaseKind = z.enum(['capability', 'regression']);
true satisfies Equals<z.infer<typeof evalCaseKind>, EvalCaseKind>;

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

/** A file attachment is pinned by the hex SHA-256 of its bytes; a file whose bytes hash otherwise is refused. */
export interface EvalFileAttachment {
  mimeType: string;
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

export type EvalAttachment = EvalInlineAttachment | EvalFileAttachment;
const evalAttachment = z.union([evalInlineAttachment, evalFileAttachment]);
true satisfies Equals<z.infer<typeof evalAttachment>, EvalAttachment>;

export interface EvalTurnInput {
  text?: string;
  attachments?: EvalAttachment[];
}
const evalTurnInput = z.object({
  text: z.string().optional(),
  attachments: z.array(evalAttachment).optional(),
});
true satisfies Equals<z.infer<typeof evalTurnInput>, EvalTurnInput>;

export interface EvalSessionStep {
  text: string;
  until: 'turn_complete';
}
const evalSessionStep = z.object({ text: z.string(), until: z.literal('turn_complete') });
true satisfies Equals<z.infer<typeof evalSessionStep>, EvalSessionStep>;

export interface EvalSessionInput {
  session: { steps: EvalSessionStep[] };
}
const evalSessionInput = z.object({ session: z.object({ steps: z.array(evalSessionStep) }) });
true satisfies Equals<z.infer<typeof evalSessionInput>, EvalSessionInput>;

export type EvalCaseInput = EvalTurnInput | EvalSessionInput;
const evalCaseInput = z.union([evalSessionInput, evalTurnInput]);
true satisfies Equals<z.infer<typeof evalCaseInput>, EvalCaseInput>;

/** Only an `accepted` name passes; a `partial` one is close but not enough; a `rejected` one named beside an accepted name makes the reply `partial`, not a pass. */
export interface EvalAnswer {
  accepted: string[];
  partial?: string[];
  rejected?: string[];
  reference?: string;
}
const evalAnswer = z.object({
  accepted: z.array(z.string().min(1)).min(1),
  partial: z.array(z.string().min(1)).optional(),
  rejected: z.array(z.string().min(1)).optional(),
  reference: z.string().optional(),
});
true satisfies Equals<z.infer<typeof evalAnswer>, EvalAnswer>;

export interface EvalExpect {
  tools?: string[];
  json?: Record<string, unknown>;
  transcription?: { includes?: string; regex?: string };
  answer?: EvalAnswer;
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

export type EvalDifficulty = 1 | 2 | 3 | 4 | 5;
const evalDifficulty = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
true satisfies Equals<z.infer<typeof evalDifficulty>, EvalDifficulty>;

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
export const evalCaseSchema: z.ZodType<EvalCase> = evalCase;

export type TraceOperation = 'invoke_agent' | 'chat' | 'generate_content' | 'execute_tool';

/** A message as the trace stores it: `{ role, parts: [...] }`, parts by hash; resolve them with `text` / `content`. */
export type TrialMessage = Record<string, TraceAttributeValue>;

export interface TrialUsage {
  tokens: TurnTokens;
  costUsd?: number;
}

/** A grader receives the trace records that share the trial's trace id and nothing else; if it needs a fact the trace does not hold, the trace is wrong, not the grader. */
export interface Trial {
  suite: string;
  case?: EvalCase;
  index: number;
  records: TraceRecord[];
  root: TraceSpan;
  /** The topmost span above `root`: the host's own span when the host nested the turn under it, else `root`. Its length is the trial's time. */
  top: TraceSpan;
  spans: (operation: TraceOperation) => TraceSpan[];
  children: (span: TraceSpan) => TraceSpan[];
  content: (value: unknown) => unknown;
  text: (value: unknown) => string | undefined;
  delivered: () => TrialMessage[];
  usage: () => TrialUsage;
}

export type EvalResultSource = 'code' | 'model';
const evalResultSource = z.enum(['code', 'model']);
true satisfies Equals<z.infer<typeof evalResultSource>, EvalResultSource>;

export interface EvalResult {
  name: string;
  source: EvalResultSource;
  score?: { value?: number; label?: string };
  explanation?: string;
  /** Whether this result counts as a pass. Absent: informational only. */
  passed?: boolean;
  /** Why no score could be produced; the result is then a failed one. */
  errorType?: string;
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
export const evalResultSchema: z.ZodType<EvalResult> = evalResult;

export type EvalPassRule = 'all' | 'any' | { atLeast: number };
const evalPassRule = z.union([
  z.literal('all'),
  z.literal('any'),
  z.object({ atLeast: z.number().int().min(1) }),
]);
true satisfies Equals<z.infer<typeof evalPassRule>, EvalPassRule>;

export interface EvalTrials {
  /** Trials per case. No default: it is a cost decision, so the suite states it. `1` cannot tell noise from change. */
  repeat: number;
  pass?: EvalPassRule;
}
const evalTrials = z.object({
  repeat: z.number().int().min(1),
  pass: evalPassRule.optional(),
});
true satisfies Equals<z.infer<typeof evalTrials>, EvalTrials>;

export interface EvalGradeContext {
  judge?: string;
  judgeProvider?: ModelProvider;
  judgeDecision?: Omit<RunDecisionOptions, 'sink'>;
  /** The trial span as a W3C `traceparent`: a judge call runs under it, so it lands in the judged trace beneath the trial. Absent, each judge call starts a trace of its own. */
  traceparent?: string;
  media?: EvalMediaResolver;
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

export interface EvalGrader {
  name: string;
  /** Stable text naming exactly what this grader checks; its sha256 is written as `theorem.evaluation.grader.version`, so a later reader can tell which rubric produced which score. */
  identity: string;
  source: EvalResultSource;
  needsExpect: boolean;
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

export interface EvalSuite {
  id: string;
  profile: string;
  mode: 'turn' | 'session';
  cases: string;
  trials: EvalTrials;
  graders: EvalGrader[];
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
export const evalSuiteSchema: z.ZodType<EvalSuite> = evalSuite;
