/**
 * The dataset grader: was the agent's answer one the case accepts? Graded by
 * code alone against `expect.answer`; a miss is for a person to read, not a
 * judge to second-guess.
 *
 * @module
 */

import { isRecord } from '../../kernel/util/record.ts';
import type { EvalGrader, EvalResult, Trial } from '../types.ts';
import { codeGrader, deliveredJson, deliveredText, listOf } from './shared.ts';
import { toolSteps } from './transcript.ts';

/**
 * Where `answer` reads the agent's answer:
 * - `{ json: 'a.b' }`: that key of the delivered JSON (dots walk into objects);
 * - `{ tool, arg: 'a.b' }`: that argument of the last call to the tool the
 *   agent commits its answer with;
 * - absent: the reply text, searched for the case's names as whole words.
 */
type AnswerSource = { json: string } | { tool: string; arg: string };

/** `accepted` passes; `partial` is close but not enough; `wrong` is anything else. */
type AnswerLabel = 'accepted' | 'partial' | 'wrong';

/** Case, accents, punctuation and spacing left out, so `Épipremnum  aureum.` is `epipremnum aureum`. */
function normalized(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parsedArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The answer the source holds, and where it was read, or why there is none. */
function readAnswer(
  trial: Trial,
  source: AnswerSource,
): { value: string; where: string } | { missing: string } {
  if ('json' in source) {
    const where = `JSON key ${source.json}`;
    const value = at(deliveredJson(trial), source.json);
    return typeof value === 'string' ? { value, where } : { missing: `no string at ${where}` };
  }
  const where = `${source.tool} argument ${source.arg}`;
  const call = toolSteps(trial)
    .filter((step) => step.name === source.tool)
    .at(-1);
  if (!call) return { missing: `${source.tool} was not called` };
  const value = at(parsedArguments(call.arguments), source.arg);
  return typeof value === 'string' ? { value, where } : { missing: `no string at ${where}` };
}

function result(label: AnswerLabel, explanation: string): EvalResult {
  const passed = label === 'accepted';
  return {
    name: 'answer',
    source: 'code',
    score: { value: passed ? 1 : 0, label },
    explanation,
    passed,
  };
}

/**
 * A turn the provider failed before it answered: the agent never had its
 * say, so the trial errors instead of counting as wrong.
 */
function unanswered(trial: Trial, why: string): EvalResult | undefined {
  if (trial.root.attributes['theorem.stop.kind'] !== 'provider_error') return undefined;
  const kind = trial.root.status.message ? ` (${trial.root.status.message})` : '';
  return {
    name: 'answer',
    source: 'code',
    errorType: 'provider_error',
    explanation: `${why}; the turn stopped provider_error${kind} before it answered`,
  };
}

/**
 * Labels a trial `accepted`, `partial` or `wrong` against the case's
 * `expect.answer`; only `accepted` passes. A turn that stopped
 * `provider_error` without an answer gets no label: its trial errors.
 */
function answer(options: { from?: AnswerSource } = {}): EvalGrader {
  const { from } = options;
  const identity = `answer:${from ? JSON.stringify(from) : 'reply'}`;
  return codeGrader('answer', identity, true, (trial) => {
    const expected = trial.case?.expect?.answer;
    if (!expected) return result('wrong', 'case has no expect.answer');
    const accepted = expected.accepted;
    const partial = expected.partial ?? [];
    if (from) {
      const read = readAnswer(trial, from);
      if ('missing' in read) {
        return (
          unanswered(trial, read.missing) ??
          result('wrong', `${read.missing}; accepted ${listOf(accepted)}`)
        );
      }
      const said = normalized(read.value);
      const quoted = JSON.stringify(read.value);
      if (accepted.some((name) => normalized(name) === said)) {
        return result('accepted', `answered ${quoted} (${read.where})`);
      }
      if (partial.some((name) => normalized(name) === said)) {
        return result(
          'partial',
          `answered ${quoted} (${read.where}); accepted ${listOf(accepted)}`,
        );
      }
      return result('wrong', `answered ${quoted} (${read.where}); accepted ${listOf(accepted)}`);
    }
    const reply = ` ${normalized(deliveredText(trial, undefined))} `;
    const found = (names: string[]) =>
      names.find((name) => reply.includes(` ${normalized(name)} `));
    const hit = found(accepted);
    if (hit) return result('accepted', `reply names ${JSON.stringify(hit)}`);
    const near = found(partial);
    if (near) {
      return result('partial', `reply names ${JSON.stringify(near)}; accepted ${listOf(accepted)}`);
    }
    return (
      unanswered(trial, 'the reply names no answer') ??
      result('wrong', `reply names none of ${listOf(accepted)}`)
    );
  });
}

export type { AnswerLabel, AnswerSource };
export { answer };
