import { errorKind, TheoremError } from '../../guardrails/error.ts';
import {
  getProfile,
  registerStructured,
  runDecision,
  runTurn,
} from '../../kernel/default-scope.ts';
import { mimeAllowed, profileAccept } from '../../kernel/registry/catalog.ts';
import type {
  DecisionAnswer,
  DecisionChoiceQuestion,
  DecisionJson,
  StructuredSpec,
  TurnBlob,
  TurnMediaRef,
  TurnRequest,
} from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import { memorySink } from '../../observability/trace.ts';
import type { TraceRecord } from '../../observability/trace-record.ts';
import { formatTraceparent } from '../../observability/trace-span.ts';
import { type EvalRubric, fillRubric } from '../rubrics/types.ts';
import { buildTrial } from '../trial.ts';
import type { EvalGradeContext, EvalGrader, EvalResult, Trial } from '../types.ts';
import { resolveMedia, trialMedia } from './media.ts';
import { deliveredJson, deliveredText } from './shared.ts';
import { rubricView, TRIAL_VARIABLES } from './transcript.ts';

const EVAL_JUDGMENT = 'evalJudgment';

const UNKNOWN = 'unknown';

const UNKNOWN_CRITERION = 'The record does not show enough to decide.';

const VERDICT = 'verdict';

const FAILED_STOPS: ReadonlySet<string> = new Set([
  'provider_error',
  'cancelled',
  'stream_incomplete',
  'interrupted',
]);

function turnFailure(trial: Trial): string | undefined {
  const stop = trial.root.attributes['theorem.stop.kind'];
  if (typeof stop === 'string' && FAILED_STOPS.has(stop)) return `the turn stopped with ${stop}`;
  if (deliveredText(trial, undefined) === '' && deliveredJson(trial) === undefined) {
    return `the turn delivered nothing${typeof stop === 'string' ? ` (stopped ${stop})` : ''}`;
  }
  return undefined;
}

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
  name?: string;
  pass?: readonly string[];
  profile?: string;
  variables?: (trial: Trial) => Record<string, string>;
  /** Decision judges only: how many times worse a wrong pass is than a wrong fail; default 1. */
  wrongPassCost?: number;
  escalate?: string;
}

interface JudgeRun {
  traceparents: string[];
  judgment?: Judgment;
  error?: string;
}

function configError(grader: string, message: string): TheoremError {
  return new TheoremError('config', `judge ${grader}: ${message}`); // lexicon-exempt: developer contract error
}

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

function traceparentsOf(records: readonly TraceRecord[]): string[] {
  const spans = records[0]?.spans ?? [];
  const ids = new Set(spans.map((span) => span.spanId));
  const root = spans.find((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId));
  return root ? [formatTraceparent(root.traceId, root.spanId)] : [];
}

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

function judgeCall(
  trial: Trial,
  grader: string,
  context: EvalGradeContext,
): { metadata: Record<string, unknown>; traceparent?: string; signal?: AbortSignal } {
  return {
    metadata: judgeStamp(trial, grader),
    ...(context.traceparent ? { traceparent: context.traceparent } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

function parseJudgment(value: unknown): Judgment | undefined {
  if (!isRecord(value)) return undefined;
  const { label, explanation } = value;
  if (typeof label !== 'string' || typeof explanation !== 'string') return undefined;
  return { label, explanation };
}

async function askText(args: {
  trial: Trial;
  prompt: string;
  profile: string;
  grader: string;
  context: EvalGradeContext;
  attachments: Array<TurnBlob | TurnMediaRef>;
}): Promise<JudgeRun> {
  const { context } = args;
  if (!context.judgeProvider) {
    throw configError(args.grader, `no provider for text judge profile ${args.profile}`);
  }
  const records: TraceRecord[] = [];
  let error: string | undefined;
  const request: TurnRequest = {
    profile: args.profile,
    input: {
      text: args.prompt,
      ...(args.attachments.length > 0 ? { attachments: args.attachments } : {}),
    },
    ...judgeCall(args.trial, args.grader, context),
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

interface ChoiceRule {
  pass: readonly string[] | undefined;
  labels: readonly string[];
  line: number;
}

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

async function askDecision(args: {
  trial: Trial;
  rubric: EvalRubric;
  rule: ChoiceRule;
  state: Record<string, DecisionJson>;
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
        ...judgeCall(args.trial, args.grader, context),
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

function stateOf(
  rubric: EvalRubric,
  view: Readonly<Record<string, DecisionJson>>,
): Record<string, DecisionJson> {
  const state: Record<string, DecisionJson> = {};
  for (const variable of rubric.variables) {
    const value = view[variable];
    if (value === undefined) {
      throw new TheoremError('config', `rubric ${rubric.name}: no value for ${variable}`); // lexicon-exempt: developer contract error
    }
    state[variable] = value;
  }
  return state;
}

// Models echo the prompt's headings (`CORRECT -`), so a text judge's label is read case-insensitively.
function declaredLabel(label: string, allowed: ReadonlySet<string>): string | undefined {
  const wanted = label.trim().toLowerCase();
  return [...allowed].find((declared) => declared.toLowerCase() === wanted);
}

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
    const notJudged = (why: string): EvalResult => ({
      name,
      source: 'model',
      explanation: `${why}; not judged`,
    });
    const failure = turnFailure(trial);
    if (failure) return notJudged(failure);
    const profile = judgeProfile(context.judge);
    const view = rubricView(rubric, trial, options.variables?.(trial) ?? {});
    const read = JSON.stringify(view);
    const media = trialMedia(trial).filter((item) => read.includes(item.label));
    const resolved = await resolveMedia(trial, media, context);
    if ('missing' in resolved) {
      return notJudged(`the judge could not be shown ${resolved.missing.join(', ')}`);
    }
    const { attachments } = resolved;
    const text = (textProfile: string) => {
      const refused = attachments.filter(
        (item) =>
          !mimeAllowed(profileAccept(getProfile(textProfile), 'attachments') ?? [], item.mimeType),
      );
      if (refused.length > 0) {
        throw configError(
          name,
          `judge profile ${textProfile} must accept ${[...new Set(refused.map((item) => item.mimeType))].join(', ')} to see the media it judges`,
        );
      }
      return askText({
        trial,
        prompt: fillRubric(rubric, view),
        profile: textProfile,
        grader: name,
        context,
        attachments,
      });
    };
    if (judgeKind(name, rubric, profile) === 'text')
      return resultOf(await text(profile), rubric, name, pass);
    if (attachments.length > 0) {
      if (!options.escalate) {
        return notJudged(
          `decision judge ${profile} cannot see ${media.map((item) => item.label).join(', ')} and no escalate judge can`,
        );
      }
      return resultOf(await text(options.escalate), rubric, name, pass);
    }
    const run = await askDecision({
      trial,
      rubric,
      rule,
      state: stateOf(rubric, view),
      profile,
      grader: name,
      context,
    });
    if (!options.escalate || run.judgment?.label !== UNKNOWN)
      return resultOf(run, rubric, name, pass);
    return resultOf(escalated(run, await text(options.escalate)), rubric, name, pass);
  };

  const judgeProfiles = (suiteJudge: string | undefined): string[] => [
    judgeProfile(suiteJudge),
    ...(options.escalate === undefined ? [] : [options.escalate]),
  ];
  return { name, identity, source: 'model', needsExpect: false, judgeProfiles, grade };
}

export type { JudgeOptions, Judgment };
export { EVAL_JUDGMENT, judge };
