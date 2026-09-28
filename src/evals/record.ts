/**
 * Results as trace records. A trial's results are a `theorem.eval.trial` span
 * inside the judged trace, parented to the judged root, so a viewer shows them
 * under the turn; a suite run is its own `theorem.eval.run` record that links
 * every trial span. Both go through `buildRecord` with the profile's policy,
 * so retention, scrub and sampling apply as they do to turns.
 *
 * @module
 */

import { TheoremError } from '../guardrails/error.ts';
import { sha256 } from '../kernel/engine/hash.ts';
import { buildRecord, type TraceRecord } from '../observability/trace-record.ts';
import {
  formatTraceparent,
  startTrace,
  type TraceAttributes,
  type TraceClock,
  type TraceSpan,
  traceContent,
} from '../observability/trace-span.ts';
import type { ResolvedObservabilityPolicy } from '../observability/types.ts';
import type { EvalResult, EvalSuite, Trial } from './types.ts';
import { type CaseVerdict, passRuleName } from './verdict.ts';

const TRIAL_SPAN = 'theorem.eval.trial';
const RUN_SPAN = 'theorem.eval.run';
const RESULT_EVENT = 'gen_ai.evaluation.result';
const VERDICT_EVENT = 'theorem.eval.verdict';

function optional(key: string, value: TraceAttributes[string] | undefined): TraceAttributes {
  return value === undefined ? {} : { [key]: value };
}

/** The judged model response's id: the last model call that reported one. */
function responseIdOf(trial: Trial): string | undefined {
  const calls = [...trial.spans('chat'), ...trial.spans('generate_content')];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const id = calls[i]?.attributes['gen_ai.response.id'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** One result as `gen_ai.evaluation.result` event attributes. */
async function resultAttributes(
  result: EvalResult,
  graderIdentity: string,
  responseId: string | undefined,
): Promise<TraceAttributes> {
  return {
    'gen_ai.evaluation.name': result.name,
    ...optional('gen_ai.evaluation.score.value', result.score?.value),
    ...optional('gen_ai.evaluation.score.label', result.score?.label),
    ...(result.explanation === undefined
      ? {}
      : { 'gen_ai.evaluation.explanation': traceContent(result.explanation) }),
    ...optional('gen_ai.response.id', responseId),
    ...optional('error.type', result.errorType),
    'theorem.evaluation.source': result.source,
    'theorem.evaluation.grader.version': await sha256(graderIdentity),
    ...optional('theorem.evaluation.passed', result.passed),
  };
}

/** A result with the identity of the grader that produced it. */
interface GradedResult {
  result: EvalResult;
  graderIdentity: string;
}

/** What a trial record is built from. */
interface TrialRecordInput {
  trial: Trial;
  results: readonly GradedResult[];
  policy: ResolvedObservabilityPolicy;
  /** Share a clock with the run so both timelines agree. */
  clock?: TraceClock;
}

/** Every judge trace the results were drawn from, once each. */
function judgeTraceparents(results: readonly GradedResult[]): string[] {
  return [...new Set(results.flatMap(({ result }) => result.judgeTraceparents ?? []))];
}

/**
 * The trial's results as a record in the judged trace: a `theorem.eval.trial`
 * span under the judged root, one `gen_ai.evaluation.result` event per result,
 * a link to each judge turn. Returns the record and its stored span, so the run
 * can link it.
 */
async function buildTrialRecord(
  input: TrialRecordInput,
): Promise<{ record: TraceRecord; span: TraceSpan }> {
  const { trial, results, policy } = input;
  const judges = judgeTraceparents(results);
  const tree = startTrace(TRIAL_SPAN, {
    traceparent: formatTraceparent(trial.root.traceId, trial.root.spanId),
    ...(input.clock ? { clock: input.clock } : {}),
    attributes: {
      'theorem.evaluation.suite': trial.suite,
      ...optional('theorem.evaluation.case', trial.case?.id),
      'theorem.evaluation.trial': trial.index,
      ...(judges.length === 1 ? { 'theorem.evaluation.judge.traceparent': judges[0] } : {}),
    },
    links: judges.map((traceparent) => ({
      traceparent,
      attributes: { 'theorem.link.kind': 'judge' },
    })),
  });
  const responseId = responseIdOf(trial);
  for (const { result, graderIdentity } of results) {
    tree.root.event(RESULT_EVENT, await resultAttributes(result, graderIdentity, responseId));
  }
  const errored = results.some(({ result }) => result.errorType !== undefined);
  tree.root.end(errored ? { code: 'ERROR', message: 'grader_error' } : { code: 'OK' });
  const record = await buildRecord({
    spans: tree.collect(),
    policy,
    ...(trial.records[0]?.metadata ? { metadata: trial.records[0].metadata } : {}),
  });
  const [span] = record.spans;
  if (!span) throw new TheoremError('internal', 'trial record has no span'); // lexicon-exempt: invariant
  return { record, span };
}

/** What a run record is built from. */
interface RunRecordInput {
  suite: Pick<EvalSuite, 'id' | 'trials'>;
  verdicts: readonly CaseVerdict[];
  /** Every trial span the run wrote, to link. */
  trialSpans: readonly Pick<TraceSpan, 'traceId' | 'spanId'>[];
  policy: ResolvedObservabilityPolicy;
  clock?: TraceClock;
  /** Recorded mode over traces with no case: only caseless graders ran. */
  caseless?: boolean;
  /** The run stopped early, and why. */
  stopped?: 'budget';
  /** The commit under test (`vcs.ref.head.revision`). */
  revision?: string;
}

function verdictAttributes(verdict: CaseVerdict): TraceAttributes {
  return {
    case: verdict.case,
    kind: verdict.kind,
    ...optional('difficulty', verdict.difficulty),
    passed: verdict.passed,
    trials: verdict.trials,
    trials_passed: verdict.trialsPassed,
    trials_errored: verdict.trialsErrored,
    trials_ungraded: verdict.trialsUngraded,
  };
}

/**
 * One suite run as its own trace: a `theorem.eval.run` root, one
 * `theorem.eval.verdict` event per case (zeros included), a link to every trial span.
 */
function buildRunRecord(input: RunRecordInput): Promise<TraceRecord> {
  const rule = input.suite.trials.pass ?? 'all';
  const tree = startTrace(RUN_SPAN, {
    ...(input.clock ? { clock: input.clock } : {}),
    attributes: {
      'theorem.evaluation.suite': input.suite.id,
      'theorem.eval.repeat': input.suite.trials.repeat,
      'theorem.eval.pass_rule': passRuleName(rule),
      ...(typeof rule === 'object' ? { 'theorem.eval.pass_at_least': rule.atLeast } : {}),
      ...(input.caseless ? { 'theorem.eval.caseless': true } : {}),
      ...optional('theorem.eval.stopped', input.stopped),
      ...optional('vcs.ref.head.revision', input.revision),
    },
    links: input.trialSpans.map((span) => ({
      traceparent: formatTraceparent(span.traceId, span.spanId),
      attributes: { 'theorem.link.kind': 'trial' },
    })),
  });
  for (const verdict of input.verdicts) {
    tree.root.event(VERDICT_EVENT, verdictAttributes(verdict));
  }
  // A run that reached its end is OK whatever the verdicts say; one stopped early is not finished.
  tree.root.end(input.stopped ? { code: 'UNSET' } : { code: 'OK' });
  return buildRecord({ spans: tree.collect(), policy: input.policy });
}

export type { GradedResult, RunRecordInput, TrialRecordInput };
export { buildRunRecord, buildTrialRecord };
