/**
 * Code graders: deterministic checks over a trial's trace. Each returns one
 * pass/fail result with the reason in plain words. Outcome first: what was
 * delivered and what it cost matter more than the path taken.
 *
 * @module
 */

import { collectValidationFailures } from '../../kernel/engine/runner/schema-validation.ts';
import { isRecord } from '../../kernel/util/record.ts';
import type { TraceSpan } from '../../observability/trace-span.ts';
import type { EvalGrader, EvalResult, Trial } from '../types.ts';
import {
  codeGrader,
  deliveredJson,
  deliveredText,
  listOf,
  modelCalls,
  passFail,
  spanDurationMs,
} from './shared.ts';

const MS_PER_S = 1000;

function stringAttribute(span: TraceSpan, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function numberAttribute(span: TraceSpan, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === 'number' ? value : undefined;
}

/** Deep structural equality over JSON values. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function quote(text: string): string {
  return JSON.stringify(text);
}

// ── delivered ───────────────────────────────────────

/** Graders over what the host received: the model's own text and JSON. */
interface DeliveredGraders {
  /** The delivered text contains `text`. */
  includes: (text: string) => EvalGrader;
  /** The delivered text matches `pattern` (a JavaScript regular expression source). */
  regex: (pattern: string, flags?: string) => EvalGrader;
  /** The delivered text equals `text` exactly. */
  equals: (text: string) => EvalGrader;
  /**
   * The delivered JSON validates against a JSON Schema object (required
   * fields present, recursively). The structured part is read when the
   * profile has one; otherwise the text is parsed.
   */
  jsonSchema: (schema: Record<string, unknown>) => EvalGrader;
  /** Every field of the case's `expect.json` is present in the delivered JSON with the same value. */
  json: () => EvalGrader;
}

const delivered: DeliveredGraders = {
  /** The delivered text contains `text`. */
  includes(text: string): EvalGrader {
    return codeGrader('delivered_includes', `delivered.includes:${text}`, false, (trial) => {
      const actual = deliveredText(trial, undefined);
      const passed = actual.includes(text);
      return passFail(
        'delivered_includes',
        passed,
        passed ? `delivered text includes ${quote(text)}` : `delivered text lacks ${quote(text)}`,
      );
    });
  },
  /** The delivered text matches `pattern` (a JavaScript regular expression source). */
  regex(pattern: string, flags = ''): EvalGrader {
    const re = new RegExp(pattern, flags);
    return codeGrader('delivered_regex', `delivered.regex:/${pattern}/${flags}`, false, (trial) => {
      const passed = re.test(deliveredText(trial, undefined));
      return passFail(
        'delivered_regex',
        passed,
        passed
          ? `delivered text matches /${pattern}/${flags}`
          : `delivered text does not match /${pattern}/${flags}`,
      );
    });
  },
  /** The delivered text equals `text` exactly. */
  equals(text: string): EvalGrader {
    return codeGrader('delivered_equals', `delivered.equals:${text}`, false, (trial) => {
      const actual = deliveredText(trial, undefined);
      const passed = actual === text;
      return passFail(
        'delivered_equals',
        passed,
        passed ? 'delivered text is exactly as expected' : `delivered text was ${quote(actual)}`,
      );
    });
  },
  /**
   * The delivered JSON validates against a JSON Schema object (required
   * fields present, recursively). The structured part is read when the
   * profile has one; otherwise the text is parsed.
   */
  jsonSchema(schema: Record<string, unknown>): EvalGrader {
    return codeGrader(
      'delivered_json_schema',
      `delivered.jsonSchema:${JSON.stringify(schema)}`,
      false,
      async (trial) => {
        const value = deliveredJson(trial);
        if (value === undefined) {
          return passFail('delivered_json_schema', false, 'delivered output is not JSON');
        }
        const failures = await collectValidationFailures(schema, value, undefined);
        const passed = failures.length === 0;
        return passFail(
          'delivered_json_schema',
          passed,
          passed ? 'delivered JSON fits the schema' : failures.map((f) => f.error).join('; '),
        );
      },
    );
  },
  /** Every field of the case's `expect.json` is present in the delivered JSON with the same value. */
  json(): EvalGrader {
    return codeGrader('delivered_json', 'delivered.json', true, (trial) => {
      const expected = trial.case?.expect?.json;
      if (!expected) {
        return passFail('delivered_json', false, 'case has no expect.json');
      }
      const actual = deliveredJson(trial);
      if (!isRecord(actual)) {
        return passFail('delivered_json', false, 'delivered output is not a JSON object');
      }
      const wrong = Object.entries(expected).filter(([key, want]) => !sameJson(actual[key], want));
      const passed = wrong.length === 0;
      return passFail(
        'delivered_json',
        passed,
        passed
          ? 'delivered JSON carries every expected field'
          : `fields differ: ${wrong.map(([key, want]) => `${key} expected ${JSON.stringify(want)} got ${JSON.stringify(actual[key])}`).join('; ')}`,
      );
    });
  },
};

// ── tool trajectory ─────────────────────────────────

/**
 * How the called tools are compared with the expected list:
 * - `exact`: the same tools in the same order, nothing more;
 * - `in_order`: the expected tools appear in that order, others may interleave;
 * - `any_order`: the same tools, order ignored;
 * - `subset`: every tool called is one that was expected (none unexpected; some may be missing).
 */
type TrajectoryMode = 'exact' | 'in_order' | 'any_order' | 'subset';

function inOrder(expected: string[], actual: string[]): boolean {
  let at = 0;
  for (const name of actual) {
    if (name === expected[at]) at += 1;
  }
  return at === expected.length;
}

function anyOrder(expected: string[], actual: string[]): boolean {
  return sameJson([...expected].sort(), [...actual].sort());
}

function trajectoryMatches(mode: TrajectoryMode, expected: string[], actual: string[]): boolean {
  switch (mode) {
    case 'exact':
      return sameJson(expected, actual);
    case 'in_order':
      return inOrder(expected, actual);
    case 'any_order':
      return anyOrder(expected, actual);
    case 'subset':
      return actual.every((name) => expected.includes(name));
    default:
      return false;
  }
}

/** The tools the agent called, in start order, against `expect` or the case's `expect.tools`. */
function toolTrajectory(options: { expect?: string[]; mode: TrajectoryMode }): EvalGrader {
  const identity = `toolTrajectory:${options.mode}:${options.expect ? JSON.stringify(options.expect) : 'case'}`;
  return codeGrader('tool_trajectory', identity, options.expect === undefined, (trial) => {
    const expected = options.expect ?? trial.case?.expect?.tools;
    if (!expected) {
      return passFail('tool_trajectory', false, 'case has no expect.tools');
    }
    const actual = trial
      .spans('execute_tool')
      .flatMap((span) => stringAttribute(span, 'gen_ai.tool.name') ?? []);
    const passed = trajectoryMatches(options.mode, expected, actual);
    return passFail(
      'tool_trajectory',
      passed,
      `called ${listOf(actual)}; expected ${listOf(expected)} (${options.mode})`,
    );
  });
}

// ── stop, guardrail, budget ─────────────────────────

/** The turn stopped for one of these reasons (`theorem.stop.kind`). */
function stopKind(kind: string | string[]): EvalGrader {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return codeGrader('stop_kind', `stopKind:${kinds.join('|')}`, false, (trial) => {
    const actual = stringAttribute(trial.root, 'theorem.stop.kind');
    const passed = actual !== undefined && kinds.includes(actual);
    return passFail(
      'stop_kind',
      passed,
      `stopped ${actual ?? 'without a stop'}; expected ${listOf(kinds)}`,
    );
  });
}

/** A guardrail did (`fired: true`) or did not (`fired: false`) act on any span; `allow` does not count as acting. */
function guardrail(options: { fired: boolean; action?: 'redact' | 'flag' | 'block' }): EvalGrader {
  const identity = `guardrail:${options.fired}:${options.action ?? 'any'}`;
  return codeGrader('guardrail', identity, false, (trial) => {
    const actions = trial.records
      .flatMap((record) => record.spans)
      .flatMap((span) => span.events)
      .filter((event) => event.name === 'theorem.guardrail')
      .flatMap((event) =>
        typeof event.attributes.action === 'string' ? [event.attributes.action] : [],
      )
      .filter((action) => (options.action ? action === options.action : action !== 'allow'));
    const fired = actions.length > 0;
    const passed = fired === options.fired;
    return passFail(
      'guardrail',
      passed,
      fired ? `guardrail acted: ${listOf(actions)}` : 'no guardrail acted',
    );
  });
}

/** Ceilings the trial must stay under; every one that is crossed is named. */
interface BudgetOptions {
  maxCostUsd?: number;
  maxTokens?: number;
  maxSteps?: number;
  maxDurationMs?: number;
  /** The slowest model call's time to first chunk. */
  maxTimeToFirstChunkMs?: number;
}

const BUDGET_KEYS: readonly (keyof BudgetOptions)[] = [
  'maxCostUsd',
  'maxTokens',
  'maxSteps',
  'maxDurationMs',
  'maxTimeToFirstChunkMs',
];

function budgetReadings(trial: Trial): Record<keyof BudgetOptions, number | undefined> {
  const usage = trial.usage();
  const firstChunks = modelCalls(trial).flatMap(
    (span) => numberAttribute(span, 'gen_ai.response.time_to_first_chunk') ?? [],
  );
  return {
    maxCostUsd: usage.costUsd,
    maxTokens: usage.tokens.total,
    maxSteps: numberAttribute(trial.root, 'theorem.steps'),
    maxDurationMs: spanDurationMs(trial.root),
    maxTimeToFirstChunkMs: firstChunks.length > 0 ? Math.max(...firstChunks) * MS_PER_S : undefined,
  };
}

/** The trial stayed within every ceiling given; a ceiling with no reading in the trace fails, since it cannot be shown. */
function budget(options: BudgetOptions): EvalGrader {
  return codeGrader('budget', `budget:${JSON.stringify(options)}`, false, (trial) => {
    const readings = budgetReadings(trial);
    const over: string[] = [];
    for (const key of BUDGET_KEYS) {
      const limit = options[key];
      if (limit === undefined) continue;
      const reading = readings[key];
      if (reading === undefined) over.push(`${key}: not recorded`);
      else if (reading > limit) over.push(`${key}: ${reading} over ${limit}`);
    }
    const passed = over.length === 0;
    return passFail('budget', passed, passed ? 'within budget' : over.join('; '));
  });
}

// ── outcome ─────────────────────────────────────────

/**
 * The host's own check of the end state (a booking exists, a row changed):
 * "host decides". Return a boolean, or a full result to score and explain.
 */
function outcome(
  name: string,
  check: (trial: Trial) => boolean | EvalResult | Promise<boolean | EvalResult>,
): EvalGrader {
  return codeGrader(name, `outcome:${name}`, false, async (trial) => {
    const verdict = await check(trial);
    if (typeof verdict === 'boolean') {
      return passFail(name, verdict, verdict ? 'outcome check passed' : 'outcome check failed');
    }
    return verdict;
  });
}

export type { BudgetOptions, DeliveredGraders, TrajectoryMode };
export { budget, delivered, guardrail, outcome, stopKind, toolTrajectory };
