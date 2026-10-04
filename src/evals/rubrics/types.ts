/**
 * What a rubric is: the labels a judge may answer with and what each is
 * worth, which labels pass, and the variables the judge fills from the trace.
 * It carries a prompt for a text judge, a question for a decision judge
 * (Jev), or both, so a suite can grade one rubric with either judge, or with
 * Jev escalating to a text judge. `rubric()` builds a host's own.
 *
 * @module
 */

import { TheoremError } from '../../guardrails/error.ts';
import { renderTemplate, templateVariables } from './mustache.ts';

/** What a decision judge answers: instructions, and one criterion per label. */
export interface EvalRubricQuestion {
  instructions: string;
  /** Every label of the rubric, each described as the judge should recognise it. */
  criteria: Readonly<Record<string, string>>;
}

/** A judge's rubric: labels, the pass set, and the prompt, the question, or both. */
export interface EvalRubric {
  /** The result's `gen_ai.evaluation.name` unless the grader renames it. */
  name: string;
  /** One line on what the rubric measures. */
  description: string;
  /**
   * What the judge reads from the trace: the names the prompt reads outside
   * any section (`output` for `{{#output.messages}}`), and the keys of the
   * state a decision judge reads. Each is a standard trace variable or one
   * the grader's `variables` option supplies.
   */
  variables: readonly string[];
  /** The labels the judge may answer with, each mapped to the result's `score.value`. */
  labels: Readonly<Record<string, number>>;
  /** Labels that pass. Absent: the result informs but never decides a trial. */
  pass?: readonly string[];
  /** The Mustache prompt a text judge fills (`mustache.ts`). Absent: no text judge can run it. */
  template?: string;
  /** The question a decision judge answers over the variables as state. Absent: no decision judge can run it. */
  question?: EvalRubricQuestion;
}

function configError(rubric: string, message: string): TheoremError {
  return new TheoremError('config', `rubric ${rubric}: ${message}`); // lexicon-exempt: developer contract error
}

/** Render the prompt over the view; a rubric without one, or a variable the view lacks, is a config error. */
function fillRubric(rubric: EvalRubric, view: Readonly<Record<string, unknown>>): string {
  if (rubric.template === undefined)
    throw configError(rubric.name, 'has no prompt for a text judge');
  const missing = rubric.variables.filter((name) => view[name] === undefined);
  if (missing.length > 0) throw configError(rubric.name, `no value for ${missing.join(', ')}`);
  return renderTemplate(rubric.template, view);
}

/** The rubric's variables: the prompt's when it has one (and `variables`, when given, must match them). */
function variablesOf(spec: {
  name: string;
  variables?: readonly string[];
  template?: string;
}): readonly string[] {
  if (spec.template === undefined) {
    if (!spec.variables || spec.variables.length === 0) {
      throw configError(spec.name, 'a rubric with no prompt names its variables');
    }
    return spec.variables;
  }
  const found = templateVariables(spec.template);
  if (spec.variables && [...spec.variables].sort().join() !== [...found].sort().join()) {
    throw configError(
      spec.name,
      `variables ${spec.variables.join(', ')} differ from the prompt's ${found.join(', ')}`,
    );
  }
  return found;
}

function checkQuestion(
  name: string,
  labels: readonly string[],
  question: EvalRubricQuestion,
): void {
  const criteria = Object.keys(question.criteria);
  const missing = labels.filter((label) => !criteria.includes(label));
  const extra = criteria.filter((label) => !labels.includes(label));
  if (missing.length > 0 || extra.length > 0) {
    throw configError(
      name,
      `the question's criteria must be its labels (${labels.join(', ')}); got ${criteria.join(', ')}`,
    );
  }
}

/**
 * A host's own rubric: the labels, what passes, and a prompt, a question or
 * both. A prompt's variables are read from it; a question-only rubric names
 * its `variables`, the keys of the state the decision judge reads.
 */
function rubric(spec: {
  name: string;
  description?: string;
  labels: Readonly<Record<string, number>>;
  pass?: readonly string[];
  variables?: readonly string[];
  template?: string;
  question?: EvalRubricQuestion;
}): EvalRubric {
  const names = Object.keys(spec.labels);
  if (names.length === 0) throw configError(spec.name, 'no labels');
  if (spec.template === undefined && spec.question === undefined) {
    throw configError(spec.name, 'needs a prompt (template), a question, or both');
  }
  const unknownPass = (spec.pass ?? []).filter((label) => !(label in spec.labels));
  if (unknownPass.length > 0) {
    throw configError(spec.name, `pass names labels it lacks: ${unknownPass.join(', ')}`);
  }
  if (spec.question) checkQuestion(spec.name, names, spec.question);
  return {
    name: spec.name,
    description: spec.description ?? '',
    variables: variablesOf(spec),
    labels: spec.labels,
    ...(spec.pass ? { pass: spec.pass } : {}),
    ...(spec.template === undefined ? {} : { template: spec.template }),
    ...(spec.question ? { question: spec.question } : {}),
  };
}

export { fillRubric, rubric };
