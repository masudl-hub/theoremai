#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * Live, opt-in contract probe for TypeSafe Jev's System One API.
 *
 * This script deliberately uses raw fetch rather than the TypeSafe SDK. It lets
 * us validate the wire contract and Deno compatibility before adding a runtime
 * dependency or designing THEOREM's native decision API.
 *
 * Credential handling:
 * - reads TYPESAFE_API_KEY only from the process environment;
 * - never reads .env files, writes credentials, or prints the key;
 * - does not print request state or raw response bodies.
 *
 * Usage:
 *   deno task verify:jev-api
 *   deno task verify:jev-api -- --model jev-1.13.0 --full --edge
 *   deno task verify:jev-api -- --use-cases
 *   deno task verify:jev-api -- --failure-states
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
type RecordValue = Record<string, unknown>;

interface ProbeSummary {
  name: string;
  model: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  assertions: string[];
  observations?: string[];
}

function valueAfterFlag(flag: string): string | undefined {
  const index = Deno.args.indexOf(flag);
  return index < 0 ? undefined : Deno.args[index + 1];
}

function hasFlag(flag: string): boolean {
  return Deno.args.includes(flag);
}

function write(stream: typeof Deno.stdout, message: string): void {
  const text = message.endsWith('\n') ? message.slice(0, -1) : message;
  if (stream === Deno.stderr) {
    console.error(text);
    return;
  }
  console.log(text);
}

function fail(message: string): never {
  write(Deno.stderr, `Jev probe failed: ${message}\n`);
  Deno.exit(1);
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function requireFinite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${path} must be a finite number in [${min}, ${max}]`);
  }
  return value;
}

function requireTokenCount(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    fail(`${path} must be a non-negative integer`);
  }
  return value;
}

function requireExactKeys(value: RecordValue, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, i) => key !== sortedExpected[i])
  ) {
    fail(`${path} keys differ from the declared question criteria`);
  }
}

function requireDistribution(value: unknown, keys: readonly string[], path: string): void {
  const distribution = requireRecord(value, path);
  requireExactKeys(distribution, keys, path);
  const sum = keys.reduce(
    (total, key) => total + requireFinite(distribution[key], `${path}.${key}`, 0, 1),
    0,
  );
  if (Math.abs(sum - 1) > 0.001) {
    fail(`${path} must sum to 1 (received ${sum})`);
  }
}

function validateCommonResult(raw: unknown): {
  result: RecordValue;
  model: string;
  inputTokens: number;
  outputTokens: number;
} {
  const result = requireRecord(raw, 'response');
  const model = requireString(result.model, 'response.model');
  const usage = requireRecord(result.usage, 'response.usage');
  return {
    result,
    model,
    inputTokens: requireTokenCount(usage.input_tokens, 'response.usage.input_tokens'),
    outputTokens: requireTokenCount(usage.output_tokens, 'response.usage.output_tokens'),
  };
}

function validatePrimitiveAnswers(raw: unknown): string[] {
  const { result } = validateCommonResult(raw);
  const answers = requireRecord(result.answers, 'response.answers');
  requireExactKeys(answers, ['route', 'proceed', 'risk'], 'response.answers');

  const route = requireRecord(answers.route, 'response.answers.route');
  if (route.type !== 'choice') {
    fail('response.answers.route.type must be choice');
  }
  const routeLabels = ['implementation', 'research', 'clarify'] as const;
  const choice = requireString(route.choice, 'response.answers.route.choice');
  if (!routeLabels.includes(choice as (typeof routeLabels)[number])) {
    fail('response.answers.route.choice is not a declared label');
  }
  requireFinite(route.confidence, 'response.answers.route.confidence', 0, 1);
  requireDistribution(route.probabilities, routeLabels, 'response.answers.route.probabilities');

  const proceed = requireRecord(answers.proceed, 'response.answers.proceed');
  if (proceed.type !== 'noul') {
    fail('response.answers.proceed.type must be noul');
  }
  requireFinite(proceed.noul, 'response.answers.proceed.noul', 0, 1);

  const risk = requireRecord(answers.risk, 'response.answers.risk');
  if (risk.type !== 'score') fail('response.answers.risk.type must be score');
  requireFinite(risk.score, 'response.answers.risk.score', 0, 2);
  requireFinite(risk.confidence, 'response.answers.risk.confidence', 0, 1);
  requireExactKeys(
    requireRecord(risk.legend, 'response.answers.risk.legend'),
    ['0', '1', '2'],
    'response.answers.risk.legend',
  );
  requireDistribution(risk.probabilities, ['0', '1', '2'], 'response.answers.risk.probabilities');

  return [
    'all declared questions are returned',
    'choice labels and distributions match the request',
    'noul is a bounded probability',
    'score permits a bounded fractional result with a numeric distribution',
  ];
}

function validateStructuredEntryAnswers(raw: unknown): string[] {
  const { result } = validateCommonResult(raw);
  const answers = requireRecord(result.answers, 'response.answers');
  requireExactKeys(answers, ['policyMatch'], 'response.answers');
  const answer = requireRecord(answers.policyMatch, 'response.answers.policyMatch');
  if (answer.type !== 'noul') {
    fail('response.answers.policyMatch.type must be noul');
  }
  requireFinite(answer.noul, 'response.answers.policyMatch.noul', 0, 1);
  return ['JSON object state and structured instruction/criteria entries are accepted'];
}

function validateUseCaseAnswers(raw: unknown): string[] {
  const { result } = validateCommonResult(raw);
  const answers = requireRecord(result.answers, 'response.answers');
  requireExactKeys(answers, ['actionRisk', 'nextAction', 'requiresHuman'], 'response.answers');

  const nextAction = requireRecord(answers.nextAction, 'response.answers.nextAction');
  if (nextAction.type !== 'choice') {
    fail('response.answers.nextAction.type must be choice');
  }
  const labels = ['ask_user', 'implement', 'research'] as const;
  const choice = requireString(nextAction.choice, 'response.answers.nextAction.choice');
  if (!labels.includes(choice as (typeof labels)[number])) {
    fail('response.answers.nextAction.choice is not a declared label');
  }
  requireFinite(nextAction.confidence, 'response.answers.nextAction.confidence', 0, 1);
  requireDistribution(
    nextAction.probabilities,
    labels,
    'response.answers.nextAction.probabilities',
  );

  const requiresHuman = requireRecord(answers.requiresHuman, 'response.answers.requiresHuman');
  if (requiresHuman.type !== 'noul') {
    fail('response.answers.requiresHuman.type must be noul');
  }
  requireFinite(requiresHuman.noul, 'response.answers.requiresHuman.noul', 0, 1);

  const actionRisk = requireRecord(answers.actionRisk, 'response.answers.actionRisk');
  if (actionRisk.type !== 'score') {
    fail('response.answers.actionRisk.type must be score');
  }
  requireFinite(actionRisk.score, 'response.answers.actionRisk.score', 0, 2);
  requireFinite(actionRisk.confidence, 'response.answers.actionRisk.confidence', 0, 1);
  requireDistribution(
    actionRisk.probabilities,
    ['0', '1', '2'],
    'response.answers.actionRisk.probabilities',
  );

  return ['workflow decision answers conform to the declared contract'];
}

function useCaseObservations(raw: unknown): string[] {
  const { result } = validateCommonResult(raw);
  const answers = requireRecord(result.answers, 'response.answers');
  const nextAction = requireRecord(answers.nextAction, 'response.answers.nextAction');
  const requiresHuman = requireRecord(answers.requiresHuman, 'response.answers.requiresHuman');
  const actionRisk = requireRecord(answers.actionRisk, 'response.answers.actionRisk');
  return [
    `selected action: ${requireString(nextAction.choice, 'response.answers.nextAction.choice')}`,
    `human-review probability: ${requireFinite(
      requiresHuman.noul,
      'response.answers.requiresHuman.noul',
      0,
      1,
    ).toFixed(3)}`,
    `risk score: ${requireFinite(
      actionRisk.score,
      'response.answers.actionRisk.score',
      0,
      2,
    ).toFixed(3)}`,
  ];
}

async function request(
  name: string,
  body: Record<string, JsonValue>,
  validate: (raw: unknown) => string[],
  context: { apiKey: string; baseUrl: string; timeoutMs: number },
  observe?: (raw: unknown) => string[],
): Promise<ProbeSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${context.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `request timed out after ${context.timeoutMs}ms`
        : 'network request failed';
    fail(`${name}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Do not echo arbitrary response text: an upstream might reflect request state.
    fail(`${name}: API returned HTTP ${response.status}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    fail(`${name}: API returned a non-JSON success response`);
  }

  const common = validateCommonResult(raw);
  return {
    name,
    model: common.model,
    requestId: response.headers.get('x-request-id') ?? undefined,
    inputTokens: common.inputTokens,
    outputTokens: common.outputTokens,
    assertions: validate(raw),
    ...(observe ? { observations: observe(raw) } : {}),
  };
}

async function expectRejectedRequest(
  name: string,
  body: Record<string, JsonValue>,
  context: { apiKey: string; baseUrl: string; timeoutMs: number },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${context.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `request timed out after ${context.timeoutMs}ms`
        : 'network request failed';
    fail(`${name}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (response.ok) fail(`${name}: request unexpectedly succeeded`);
  return `request is rejected with HTTP ${response.status}`;
}

const apiKey = Deno.env.get('TYPESAFE_API_KEY');
if (!apiKey) {
  fail('missing TYPESAFE_API_KEY in this process environment');
}

const baseUrl = (valueAfterFlag('--base-url') ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = valueAfterFlag('--model') ?? 'jev-latest';
const timeoutMs = Number(valueAfterFlag('--timeout-ms') ?? '10000');
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  fail('--timeout-ms must be a positive number');
}

const context = { apiKey, baseUrl, timeoutMs };
const summaries: ProbeSummary[] = [];

summaries.push(
  await request(
    'primitive contract',
    {
      model,
      state: {
        request: 'Investigate an unfamiliar external technology before changing application code.',
        hasBlockingQuestion: false,
      },
      questions: {
        route: {
          type: 'choice',
          instructions: 'Choose the most appropriate next step.',
          criteria: {
            implementation: 'The task is ready for a code change.',
            research: 'The task needs external fact-finding first.',
            clarify: 'A material user choice is missing.',
          },
        },
        proceed: {
          type: 'noul',
          instructions: 'Can work proceed without asking the user a material question?',
        },
        risk: {
          type: 'score',
          instructions: 'How consequential would an incorrect next action be?',
          criteria: ['low consequence', 'meaningful consequence', 'high consequence'],
        },
      },
    },
    validatePrimitiveAnswers,
    context,
  ),
);

if (hasFlag('--full')) {
  summaries.push(
    await request(
      'structured entry contract',
      {
        model,
        state: {
          event: { kind: 'tool_request', requestedTool: 'web_search' },
          policy: { allowedTools: ['web_search', 'calculator'] },
        },
        questions: {
          policyMatch: {
            type: 'noul',
            instructions: {
              question: 'Does the requested tool appear in policy.allowedTools?',
            },
            criteria: {
              true: { meaning: 'The requested tool is explicitly allowed.' },
              false: {
                meaning: 'The requested tool is absent from the allowed list.',
              },
            },
          },
        },
      },
      validateStructuredEntryAnswers,
      context,
    ),
  );
}

if (hasFlag('--edge')) {
  const nullStateAssertion = await expectRejectedRequest(
    'null state contract',
    {
      model,
      state: null,
      questions: {
        blankState: {
          type: 'noul',
          instructions: 'Does this empty state contain enough information to approve an action?',
          criteria: {
            true: 'The empty state has enough information.',
            false: 'The empty state lacks enough information.',
          },
        },
      },
    },
    context,
  );
  write(Deno.stdout, `null state contract: PASS\n  ✓ ${nullStateAssertion}\n`);

  const nullQuestionAssertion = await expectRejectedRequest(
    'empty question contract',
    {
      model,
      state: 'A deliberately ordinary state.',
      questions: {
        emptyQuestion: {
          type: 'noul',
          instructions: null,
          criteria: { true: null, false: null },
        },
      },
    },
    context,
  );
  write(Deno.stdout, `empty question contract: PASS\n  ✓ ${nullQuestionAssertion}\n`);

  const invalidModelAssertion = await expectRejectedRequest(
    'invalid model contract',
    {
      model: '__theoremai_invalid_jev_model__',
      state: 'This request must be rejected before evaluation.',
      questions: {
        validQuestion: {
          type: 'noul',
          instructions: 'Does this statement exist?',
        },
      },
    },
    context,
  );
  write(Deno.stdout, `invalid model contract: PASS\n  ✓ ${invalidModelAssertion}\n`);
}

if (hasFlag('--use-cases')) {
  summaries.push(
    await request(
      'use case: research routing',
      {
        model,
        state: {
          userRequest:
            'Support a technology released last week, but first verify its current API and behavior.',
          allowedActions: ['research', 'implement', 'ask_user'],
          authority: 'Read-only internet research is allowed. Code changes are not yet authorized.',
        },
        questions: {
          nextAction: {
            type: 'choice',
            instructions: 'What should the system do next?',
            criteria: {
              research: 'Verify current external facts before making any implementation plan.',
              implement: 'Make a code change now.',
              ask_user: 'Ask for a material missing decision.',
            },
          },
          requiresHuman: {
            type: 'noul',
            instructions:
              'Does this request require a human approval before the stated next action?',
          },
          actionRisk: {
            type: 'score',
            instructions: 'How consequential would a wrong next action be?',
            criteria: ['low', 'moderate', 'high'],
          },
        },
      },
      validateUseCaseAnswers,
      context,
      useCaseObservations,
    ),
  );

  summaries.push(
    await request(
      'use case: irreversible-action gate',
      {
        model,
        state: {
          requestedAction:
            'Permanently delete a production customer workspace and all of its records.',
          userAuthorization: false,
          reversibility: 'none',
          allowedActions: ['research', 'implement', 'ask_user'],
        },
        questions: {
          nextAction: {
            type: 'choice',
            instructions: 'What should the system do next?',
            criteria: {
              research: 'Gather external facts before acting.',
              implement: 'Perform the requested operation.',
              ask_user: 'Obtain explicit human authorization before acting.',
            },
          },
          requiresHuman: {
            type: 'noul',
            instructions: 'Must a human explicitly approve this action before it can execute?',
          },
          actionRisk: {
            type: 'score',
            instructions: 'How consequential would an incorrect next action be?',
            criteria: ['low', 'moderate', 'high'],
          },
        },
      },
      validateUseCaseAnswers,
      context,
      useCaseObservations,
    ),
  );
}

if (hasFlag('--failure-states')) {
  const malformedScoreAssertion = await expectRejectedRequest(
    'null score-level contract',
    {
      model,
      state: 'An ordinary state.',
      questions: {
        risk: {
          type: 'score',
          instructions: 'How risky is this?',
          criteria: ['low', null],
        },
      },
    },
    context,
  );
  write(Deno.stdout, `null score-level contract: PASS\n  ✓ ${malformedScoreAssertion}\n`);

  const missingNoulAssertion = await expectRejectedRequest(
    'empty noul contract',
    {
      model,
      state: 'An ordinary state.',
      questions: {
        answer: { type: 'noul' },
      },
    },
    context,
  );
  write(Deno.stdout, `empty noul contract: PASS\n  ✓ ${missingNoulAssertion}\n`);

  const authenticationAssertion = await expectRejectedRequest(
    'authentication contract',
    {
      model,
      state: 'This must not be evaluated.',
      questions: {
        answer: {
          type: 'noul',
          instructions: 'Does this request have a valid credential?',
        },
      },
    },
    { ...context, apiKey: 'not-a-real-typesafe-api-key' },
  );
  write(Deno.stdout, `authentication contract: PASS\n  ✓ ${authenticationAssertion}\n`);
}

for (const summary of summaries) {
  write(Deno.stdout, `${summary.name}: PASS\n`);
  write(Deno.stdout, `  model: ${summary.model}\n`);
  write(Deno.stdout, `  tokens: ${summary.inputTokens} input, ${summary.outputTokens} output\n`);
  if (summary.requestId) {
    write(Deno.stdout, `  request id: ${summary.requestId}\n`);
  }
  for (const assertion of summary.assertions) {
    write(Deno.stdout, `  ✓ ${assertion}\n`);
  }
  for (const observation of summary.observations ?? []) {
    write(Deno.stdout, `  → ${observation}\n`);
  }
}

write(
  Deno.stdout,
  `Jev probe complete: ${summaries.length} successful evaluation(s); expected rejected cases are listed above. No raw state or credentials logged.\n`,
);
