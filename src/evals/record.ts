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

function responseIdOf(trial: Trial): string | undefined {
  const calls = [...trial.spans('chat'), ...trial.spans('generate_content')];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const id = calls[i]?.attributes['gen_ai.response.id'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

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

/** A grader's result with the identity of the grader that gave it. */
interface GradedResult {
  result: EvalResult;
  graderIdentity: string;
}

/** What a trial's record is built from. */
interface TrialRecordInput {
  trial: Trial;
  policy: ResolvedObservabilityPolicy;
  clock?: TraceClock;
}

/** A trial record being built: its `traceparent` and a `finish` that writes it with the results. */
interface OpenTrialRecord {
  traceparent: string;
  finish: (results: readonly GradedResult[]) => Promise<{ record: TraceRecord; span: TraceSpan }>;
}

/** Opens the record of a trial. */
function startTrialRecord(input: TrialRecordInput): OpenTrialRecord {
  const { trial, policy } = input;
  const tree = startTrace(TRIAL_SPAN, {
    traceparent: formatTraceparent(trial.root.traceId, trial.root.spanId),
    ...(input.clock ? { clock: input.clock } : {}),
    attributes: {
      'theorem.evaluation.suite': trial.suite,
      ...optional('theorem.evaluation.case', trial.case?.id),
      'theorem.evaluation.trial': trial.index,
    },
  });
  const finish = async (results: readonly GradedResult[]) => {
    const responseId = responseIdOf(trial);
    for (const { result, graderIdentity } of results) {
      tree.root.event(RESULT_EVENT, await resultAttributes(result, graderIdentity, responseId));
    }
    const errorType = results.find(({ result }) => result.errorType !== undefined)?.result
      .errorType;
    tree.root.end(errorType ? { code: 'ERROR', message: errorType } : { code: 'OK' });
    const record = await buildRecord({
      spans: tree.collect(),
      policy,
      ...(trial.records[0]?.metadata ? { metadata: trial.records[0].metadata } : {}),
    });
    const [span] = record.spans;
    if (!span) throw new TheoremError('internal', 'trial record has no span'); // lexicon-exempt: invariant
    return { record, span };
  };
  return { traceparent: tree.root.traceparent(), finish };
}

/** What a run's record is built from: the suite, the verdicts and the trial spans. */
interface RunRecordInput {
  suite: Pick<EvalSuite, 'id' | 'trials'>;
  verdicts: readonly CaseVerdict[];
  trialSpans: readonly Pick<TraceSpan, 'traceId' | 'spanId'>[];
  policy: ResolvedObservabilityPolicy;
  clock?: TraceClock;
  caseless?: boolean;
  stopped?: 'budget';
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

/** Builds the record of a whole run. */
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
  // why: A run that reached its end is OK whatever the verdicts say; one stopped early is not finished.
  tree.root.end(input.stopped ? { code: 'UNSET' } : { code: 'OK' });
  return buildRecord({ spans: tree.collect(), policy: input.policy });
}

export type { GradedResult, OpenTrialRecord, RunRecordInput, TrialRecordInput };
export { buildRunRecord, startTrialRecord };
