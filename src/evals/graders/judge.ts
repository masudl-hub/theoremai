/**
 * The model grader: one rubric, filled from the judged trace and put to a
 * judge profile. The host picks the judge per suite or per grader:
 *
 * - a **text** profile runs the rubric's prompt through `runTurn`, so the
 *   judged transcript passes the judge's own guardrails, and answers through
 *   structured output (`evalJudgment`: label and explanation);
 * - a **decision** profile (Jev) answers the rubric's question through
 *   `runDecision`, over the rubric's variables as JSON state: a typed choice
 *   with its probabilities, and no written explanation.
 *
 * A decision judge's verdict is read from its probabilities, not its top
 * choice: a trial passes only when the pass labels together clear the line
 * the grader's `wrongPassCost` sets (more likely than not by default), fails
 * when the other labels hold most of the probability, and is `unknown`
 * otherwise. `escalate` names a text profile that decides the unknowns.
 *
 * Either way the judge call lands in a trace of its own, which the trial
 * record links.
 *
 * @module
 */

import { errorKind, TheoremError } from '../../guardrails/error.ts';
import {
  getProfile,
  registerStructured,
  runDecision,
  runTurn,
} from '../../kernel/default-scope.ts';
import type {
  DecisionAnswer,
  DecisionChoiceQuestion,
  StructuredSpec,
  TurnRequest,
} from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import { memorySink } from '../../observability/trace.ts';
import type { TraceRecord } from '../../observability/trace-record.ts';
import { formatTraceparent } from '../../observability/trace-span.ts';
import { type EvalRubric, fillRubric } from '../rubrics/types.ts';
import { buildTrial } from '../trial.ts';
import type { EvalGradeContext, EvalGrader, EvalResult, Trial } from '../types.ts';
import { deliveredJson } from './shared.ts';
import { TRIAL_VARIABLES, trialVariables } from './transcript.ts';

/** The structured schema id a text judge profile's `outputs.structured` must name. */
const EVAL_JUDGMENT = 'evalJudgment';

/** The label every rubric accepts: the judge could not decide. */
const UNKNOWN = 'unknown';

/** What a decision judge reads `unknown` as. */
const UNKNOWN_CRITERION = 'The record does not show enough to decide.';

/** The question id a decision judge answers under. */
const VERDICT = 'verdict';

/** What a judge answered. */
interface Judgment {
  label: string;
  explanation: string;
}

const JUDGMENT_SCHEMA: StructuredSpec = {
  jsonSchema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: `One of the labels the rubric names, exactly as written, or "${UNKNOWN}" when the record does not let you decide.`,
      },
      explanation: {
        type: 'string',
        description: 'Why, in a few sentences, citing what the record shows.',
      },
    },
    required: ['label', 'explanation'],
  },
};

// Importing this module registers the schema, so a host's judge profile can name it at registration.
registerStructured(EVAL_JUDGMENT, JUDGMENT_SCHEMA);

interface JudgeOptions {
  rubric: EvalRubric;
  /** The result's `gen_ai.evaluation.name`; default the rubric's name. */
  name?: string;
  /** Labels that pass, replacing the rubric's. */
  pass?: readonly string[];
  /** The judge profile, text or decision; default the suite's `judge.profile`. */
  profile?: string;
  /** The host's own readings of the trial, by variable name; they replace the standard ones. */
  variables?: (trial: Trial) => Record<string, string>;
  /**
   * Decision judges only: how many times worse a wrong pass is than a wrong
   * fail; default 1. A trial passes only when the judge puts the pass labels
   * above `wrongPassCost / (1 + wrongPassCost)`: more likely than not at 1,
   * above 75% at 3.
   */
  wrongPassCost?: number;
  /** Decision judges only: a text judge profile that decides when the decision judge is unsure. */
  escalate?: string;
}

/** One judge call's outcome, or an escalation's: the judge traces it drew on, first call first. */
interface JudgeRun {
  traceparents: string[];
  judgment?: Judgment;
  /** The kind of error that left the judge without a judgment. */
  error?: string;
}

function configError(grader: string, message: string): TheoremError {
  return new TheoremError('config', `judge ${grader}: ${message}`); // lexicon-exempt: developer contract error
}

/** The judge profile's kind, once it is known to fit the rubric. */
function judgeKind(grader: string, rubric: EvalRubric, profileId: string): 'text' | 'decision' {
  const profile = getProfile(profileId);
  if (profile.type === 'decision') {
    if (!rubric.question) {
      throw configError(
        grader,
        `rubric ${rubric.name} has no question for decision profile ${profileId}`,
      );
    }
    return 'decision';
  }
  if (profile.type !== 'text') {
    throw configError(
      grader,
      `judge profile ${profileId} is neither a text nor a decision profile`,
    );
  }
  if (profile.outputs?.structured !== EVAL_JUDGMENT) {
    throw configError(
      grader,
      `judge profile ${profileId} must set outputs.structured to '${EVAL_JUDGMENT}'`,
    );
  }
  if (rubric.template === undefined) {
    throw configError(grader, `rubric ${rubric.name} has no prompt for text profile ${profileId}`);
  }
  return 'text';
}

/** The first record's root as a `traceparent`, when the judge call wrote one. */
function traceparentsOf(records: readonly TraceRecord[]): string[] {
  const root =
    records[0]?.spans.find((span) => span.parentSpanId === undefined) ?? records[0]?.spans[0];
  return root ? [formatTraceparent(root.traceId, root.spanId)] : [];
}

/** The stamp every judge call carries, so recorded mode knows it for a judge's trace. */
function judgeStamp(trial: Trial, grader: string): Record<string, unknown> {
  return {
    eval: {
      suite: trial.suite,
      ...(trial.case ? { case: trial.case.id } : {}),
      trial: trial.index,
      judge: { grader },
    },
  };
}

function parseJudgment(value: unknown): Judgment | undefined {
  if (!isRecord(value)) return undefined;
  const { label, explanation } = value;
  if (typeof label !== 'string' || typeof explanation !== 'string') return undefined;
  return { label, explanation };
}

/** Run a text judge once over the filled prompt; its trace goes to the context. */
async function askText(args: {
  trial: Trial;
  prompt: string;
  profile: string;
  grader: string;
  context: EvalGradeContext;
}): Promise<JudgeRun> {
  const { context } = args;
  if (!context.judgeProvider) {
    throw configError(args.grader, `no provider for text judge profile ${args.profile}`);
  }
  const records: TraceRecord[] = [];
  let error: string | undefined;
  const request: TurnRequest = {
    profile: args.profile,
    input: { text: args.prompt },
    metadata: judgeStamp(args.trial, args.grader),
    ...(context.signal ? { signal: context.signal } : {}),
  };
  try {
    for await (const _event of runTurn(request, context.judgeProvider, memorySink(records))) {
      // The judge's trace is its record; its events are not read.
    }
  } catch (thrown) {
    error = errorKind(thrown);
  }
  await context.traced(records);
  if (records.length === 0) return { traceparents: [], error: error ?? 'internal' };
  const judged = buildTrial({ suite: args.trial.suite, index: 0, records });
  const traceparents = [formatTraceparent(judged.root.traceId, judged.root.spanId)];
  const failure = judged.root.attributes['error.type'];
  if (error === undefined && typeof failure === 'string') error = failure;
  if (error !== undefined) return { traceparents, error };
  const judgment = parseJudgment(deliveredJson(judged));
  return judgment ? { traceparents, judgment } : { traceparents, error: 'bad_response' };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** How a decision judge's probabilities become a verdict. */
interface ChoiceRule {
  /** Labels that pass; absent, the top choice stands and nothing is decided. */
  pass: readonly string[] | undefined;
  /** Every label the rubric declares. */
  labels: readonly string[];
  /** The probability the pass labels together must exceed. */
  line: number;
}

/**
 * A choice read back as a judgment. With a pass rule the label comes from the
 * probabilities: the likeliest pass label when the pass labels clear the
 * line, the likeliest other label when those hold most of the probability,
 * else `unknown`. The explanation keeps every label's odds.
 */
function choiceJudgment(
  answer: DecisionAnswer | undefined,
  rule: ChoiceRule,
): Judgment | undefined {
  if (answer?.type !== 'choice') return undefined;
  const p = answer.probabilities;
  const odds = Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => `${label} ${percent(value)}`)
    .join(', ');
  const { pass } = rule;
  if (!pass) return { label: answer.choice, explanation: `Jev chose ${answer.choice} (${odds}).` };
  const mass = (labels: readonly string[]) => labels.reduce((sum, l) => sum + (p[l] ?? 0), 0);
  const likeliest = (labels: readonly string[]) =>
    labels.reduce((best, l) => ((p[l] ?? 0) > (p[best] ?? 0) ? l : best));
  const failing = rule.labels.filter((label) => !pass.includes(label));
  const needs = `passing needs ${pass.join(' or ')} above ${percent(rule.line)}`;
  if (mass(pass) > rule.line) {
    return { label: likeliest(pass), explanation: `Jev: ${odds}; ${needs}.` };
  }
  if (failing.length > 0 && mass(failing) > 0.5) {
    return { label: likeliest(failing), explanation: `Jev: ${odds}; ${needs}.` };
  }
  return { label: UNKNOWN, explanation: `Jev was unsure: ${odds}; ${needs}.` };
}

/** Put the rubric's question to a decision judge once; its trace goes to the context. */
async function askDecision(args: {
  trial: Trial;
  rubric: EvalRubric;
  rule: ChoiceRule;
  state: Record<string, string>;
  profile: string;
  grader: string;
  context: EvalGradeContext;
}): Promise<JudgeRun> {
  const { context, rubric } = args;
  if (!context.judgeDecision) {
    throw configError(args.grader, `no key for decision judge profile ${args.profile}`);
  }
  if (!rubric.question) {
    throw configError(args.grader, `rubric ${rubric.name} has no question`);
  }
  const question: DecisionChoiceQuestion = {
    type: 'choice',
    instructions: rubric.question.instructions,
    criteria: { ...rubric.question.criteria, [UNKNOWN]: UNKNOWN_CRITERION },
  };
  const records: TraceRecord[] = [];
  try {
    const result = await runDecision(
      {
        profile: args.profile,
        state: args.state,
        questions: { [VERDICT]: question },
        metadata: judgeStamp(args.trial, args.grader),
        ...(context.signal ? { signal: context.signal } : {}),
      },
      { ...context.judgeDecision, sink: memorySink(records) },
    );
    await context.traced(records);
    const traceparents = traceparentsOf(records);
    const judgment = choiceJudgment(result.answers[VERDICT], args.rule);
    return judgment ? { traceparents, judgment } : { traceparents, error: 'bad_response' };
  } catch (thrown) {
    await context.traced(records);
    return { traceparents: traceparentsOf(records), error: errorKind(thrown) };
  }
}

/** The text judge's answer to what the decision judge left unknown, drawn from both judge traces. */
function escalated(decision: JudgeRun, text: JudgeRun): JudgeRun {
  const traceparents = [...decision.traceparents, ...text.traceparents];
  if (!text.judgment) return { traceparents, error: text.error ?? 'internal' };
  return {
    traceparents,
    judgment: {
      label: text.judgment.label,
      explanation: `${decision.judgment?.explanation ?? ''} The text judge decided: ${text.judgment.explanation}`,
    },
  };
}

/** The rubric's variables as the state a decision judge reads; a variable the values lack is a config error. */
function stateOf(
  rubric: EvalRubric,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const state: Record<string, string> = {};
  for (const variable of rubric.variables) {
    const value = values[variable];
    if (value === undefined) {
      throw new TheoremError('config', `rubric ${rubric.name}: no value for ${variable}`); // lexicon-exempt: developer contract error
    }
    state[variable] = value;
  }
  return state;
}

/**
 * The label as the rubric declares it. Models echo the prompt's headings
 * (`CORRECT -`), so a text judge's label is read case-insensitively; a label
 * the rubric did not declare is `undefined`.
 */
function declaredLabel(label: string, allowed: ReadonlySet<string>): string | undefined {
  const wanted = label.trim().toLowerCase();
  return [...allowed].find((declared) => declared.toLowerCase() === wanted);
}

/** One trial's result from the judge's answer. */
function resultOf(
  run: JudgeRun,
  rubric: EvalRubric,
  name: string,
  pass: readonly string[] | undefined,
): EvalResult {
  const base: EvalResult = {
    name,
    source: 'model',
    ...(run.traceparents.length > 0 ? { judgeTraceparents: run.traceparents } : {}),
  };
  if (!run.judgment) {
    return {
      ...base,
      errorType: run.error ?? 'internal',
      explanation: `the judge gave no judgment (${run.error ?? 'internal'})`,
    };
  }
  const allowed = new Set([...Object.keys(rubric.labels), UNKNOWN]);
  const label = declaredLabel(run.judgment.label, allowed);
  if (label === undefined) {
    return {
      ...base,
      errorType: 'bad_response',
      explanation: `the judge answered ${JSON.stringify(run.judgment.label)}, not one of ${[...allowed].join(', ')}`,
    };
  }
  const value = rubric.labels[label];
  return {
    ...base,
    score: { ...(value === undefined ? {} : { value }), label },
    explanation: run.judgment.explanation,
    ...(pass ? { passed: pass.includes(label) } : {}),
  };
}

/**
 * A model grader over one rubric. Runs its judge profile (the grader's own,
 * else the suite's) once per trial and reads the label back: through
 * structured output from a text judge, as a typed choice from a decision
 * judge. The result names the judge trace it was drawn from.
 */
function judge(options: JudgeOptions): EvalGrader {
  const { rubric } = options;
  const name = options.name ?? rubric.name;
  const pass = options.pass ?? rubric.pass;
  const unknownPass = (pass ?? []).filter((label) => !(label in rubric.labels));
  if (unknownPass.length > 0) {
    throw configError(name, `pass names labels the rubric lacks: ${unknownPass.join(', ')}`);
  }
  const unfillable = rubric.variables.filter(
    (variable) => !(TRIAL_VARIABLES as readonly string[]).includes(variable),
  );
  if (unfillable.length > 0 && !options.variables) {
    throw configError(
      name,
      `the rubric needs ${unfillable.join(', ')}, which the trace cannot fill; pass variables`,
    );
  }
  const wrongPassCost = options.wrongPassCost ?? 1;
  if (!(Number.isFinite(wrongPassCost) && wrongPassCost > 0)) {
    throw configError(name, `wrongPassCost must be a positive number, not ${wrongPassCost}`);
  }
  if (options.wrongPassCost !== undefined && !pass) {
    throw configError(
      name,
      `wrongPassCost needs labels that pass, and rubric ${rubric.name} names none`,
    );
  }
  const rule: ChoiceRule = {
    pass,
    labels: Object.keys(rubric.labels),
    line: wrongPassCost / (1 + wrongPassCost),
  };
  const judgeProfile = (suiteJudge: string | undefined): string => {
    const profile = options.profile ?? suiteJudge;
    if (!profile) throw configError(name, 'names no judge profile, and neither does the suite');
    const kind = judgeKind(name, rubric, profile);
    const decisionOnly = [
      ...(options.wrongPassCost === undefined ? [] : ['wrongPassCost']),
      ...(options.escalate === undefined ? [] : ['escalate']),
    ];
    if (kind === 'text' && decisionOnly.length > 0) {
      throw configError(
        name,
        `${decisionOnly.join(' and ')} ${decisionOnly.length > 1 ? 'need' : 'needs'} a decision judge, and ${profile} is a text profile`,
      );
    }
    if (options.escalate !== undefined && judgeKind(name, rubric, options.escalate) !== 'text') {
      throw configError(name, `escalate names ${options.escalate}, which is not a text profile`);
    }
    return profile;
  };
  const identity = [
    `judge:${name}`,
    `labels=${Object.entries(rubric.labels)
      .map(([label, value]) => `${label}:${value}`)
      .join(',')}`,
    `pass=${pass ? [...pass].join(',') : 'none'}`,
    ...(options.profile ? [`profile=${options.profile}`] : []),
    ...(options.wrongPassCost === undefined ? [] : [`wrongPassCost=${options.wrongPassCost}`]),
    ...(options.escalate ? [`escalate=${options.escalate}`] : []),
    `template=${rubric.template ?? ''}`,
    `question=${rubric.question ? JSON.stringify(rubric.question) : ''}`,
  ].join('\n');

  const grade = async (trial: Trial, context: EvalGradeContext): Promise<EvalResult> => {
    const profile = judgeProfile(context.judge);
    const values = { ...trialVariables(trial), ...(options.variables?.(trial) ?? {}) };
    const text = (textProfile: string) =>
      askText({
        trial,
        prompt: fillRubric(rubric, values),
        profile: textProfile,
        grader: name,
        context,
      });
    if (judgeKind(name, rubric, profile) === 'text')
      return resultOf(await text(profile), rubric, name, pass);
    const run = await askDecision({
      trial,
      rubric,
      rule,
      state: stateOf(rubric, values),
      profile,
      grader: name,
      context,
    });
    if (!options.escalate || run.judgment?.label !== UNKNOWN)
      return resultOf(run, rubric, name, pass);
    return resultOf(escalated(run, await text(options.escalate)), rubric, name, pass);
  };

  return { name, identity, source: 'model', needsExpect: false, judgeProfile, grade };
}

export type { JudgeOptions, Judgment };
export { EVAL_JUDGMENT, judge };
