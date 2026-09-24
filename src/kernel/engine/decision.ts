/** Native, single-request execution for TypeSafe Jev decision profiles. */

import { type ErrorKind, TheoremError } from '../../guardrails/error.ts';
import type { DecisionDisclosureVerdict } from '../../guardrails/types.ts';
import { getProfile } from '../registry/profiles.ts';
import { soleModelId } from '../registry/sole-model.ts';
import type {
  DecisionAnswer,
  DecisionJson,
  DecisionProfile,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  KeyVault,
  ModelId,
} from '../types.ts';

const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';

/** Each native-decision failure code and the error kind it reports. */
const DECISION_ERROR_KINDS = {
  invalid_request: 'request',
  authentication: 'auth',
  permission: 'auth',
  rate_limited: 'rate_limit',
  unavailable: 'unavailable',
  network: 'network',
  timeout: 'timeout',
  cancelled: 'cancelled',
  malformed_response: 'bad_response',
  disclosure_blocked: 'blocked',
} as const satisfies Record<string, ErrorKind>;

/** A normalized native-decision failure; response bodies are deliberately omitted. */
export class DecisionError extends TheoremError {
  constructor(
    readonly code: keyof typeof DECISION_ERROR_KINDS,
    message: string,
    readonly status?: number,
  ) {
    super(DECISION_ERROR_KINDS[code], message);
  }
}

export interface RunDecisionOptions {
  /** A flat API key, or use `keyVault` with profile/model key slots. */
  apiKey?: string;
  keyVault?: KeyVault;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
}

function requireDecisionProfile(id: string): DecisionProfile {
  const profile = getProfile(id);
  if (profile.type !== 'decision') {
    throw new TheoremError(
      'request',
      // lexicon-exempt: developer contract error
      `runDecision requires profile.type 'decision' (got '${profile.type}' for ${profile.id})`,
    );
  }
  return profile;
}

/** The profile's one model; registration guarantees exactly one. */
function decisionModel(profile: DecisionProfile): [ModelId, DecisionProfile['models'][string]] {
  const modelId = soleModelId(profile.models);
  const binding = modelId ? profile.models[modelId] : undefined;
  if (!modelId || !binding) {
    throw new TheoremError(
      'config',
      `Profile ${profile.id}: type 'decision' must declare exactly one model`, // lexicon-exempt: developer contract error
    );
  }
  return [modelId, binding];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, path: string, min = 0, max = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DecisionError('malformed_response', `${path} is outside its valid range`); // lexicon-exempt: upstream contract error
  }
  return value;
}

function distribution(value: unknown, labels: string[], path: string): Record<string, number> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== labels.length ||
    labels.some((key) => !(key in value))
  ) {
    throw new DecisionError('malformed_response', `${path} does not match declared labels`); // lexicon-exempt: upstream contract error
  }
  const out: Record<string, number> = {};
  for (const label of labels) out[label] = finite(value[label], `${path}.${label}`);
  const total = Object.values(out).reduce((sum, item) => sum + item, 0);
  if (Math.abs(total - 1) > 0.001) {
    throw new DecisionError('malformed_response', `${path} must sum to one`); // lexicon-exempt: upstream contract error
  }
  return out;
}

function validateAnswers(
  raw: unknown,
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionAnswer> {
  if (!isRecord(raw) || Object.keys(raw).length !== Object.keys(questions).length) {
    throw new DecisionError('malformed_response', 'Jev returned an incomplete answer set'); // lexicon-exempt: upstream contract error
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new DecisionError('malformed_response', `Jev returned an invalid answer for '${id}'`); // lexicon-exempt: upstream contract error
    }
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) {
        throw new DecisionError(
          'malformed_response',
          // lexicon-exempt: upstream contract error
          `Jev returned an undeclared choice for '${id}'`,
        );
      }
      answers[id] = {
        type: 'choice',
        choice: answer.choice,
        confidence: finite(answer.confidence, `${id}.confidence`),
        probabilities: distribution(answer.probabilities, labels, `${id}.probabilities`),
      };
    } else if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: finite(answer.noul, `${id}.noul`) };
    } else {
      const labels = question.criteria.map((_, index) => String(index));
      answers[id] = {
        type: 'score',
        score: finite(answer.score, `${id}.score`, 0, Math.max(0, labels.length - 1)),
        confidence: finite(answer.confidence, `${id}.confidence`),
        legend: isRecord(answer.legend)
          ? Object.fromEntries(
              Object.entries(answer.legend).map(([key, value]) => [
                key,
                finite(value, `${id}.legend.${key}`, 0, labels.length - 1),
              ]),
            )
          : (() => {
              throw new DecisionError('malformed_response', `${id}.legend is invalid`);
            })(),
        probabilities: distribution(answer.probabilities, labels, `${id}.probabilities`),
      };
    }
  }
  return answers;
}

function isNonNullJson(value: unknown): value is Exclude<DecisionJson, null> {
  return (
    isRecord(value) ||
    Array.isArray(value) ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function validateQuestion(id: string, question: DecisionQuestion): void {
  if (!id.trim() || !isDecisionEntry(question.instructions)) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
      `Decision question '${id}' must include instructions`,
    );
  }
  if (question.type === 'noul') return;
  const criteria =
    question.type === 'choice' ? Object.values(question.criteria) : question.criteria;
  if (!criteria.length || !criteria.every(isDecisionEntry)) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
      `Decision ${question.type} '${id}' must declare criteria`,
    );
  }
}

function validateRequest(request: DecisionRequest, profile: DecisionProfile): void {
  if ((request as DecisionRequest & { model?: unknown }).model !== undefined) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
      'Decision requests do not select a model; the profile runs its one model',
    );
  }
  if (!isNonNullJson(request.state)) {
    throw new DecisionError('invalid_request', 'Decision state must be non-null JSON'); // lexicon-exempt: developer contract error
  }
  const bytes = new TextEncoder().encode(JSON.stringify(request.state)).byteLength;
  if (profile.inputs.maxStateBytes !== undefined && bytes > profile.inputs.maxStateBytes) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
      `Decision state exceeds ${profile.inputs.maxStateBytes} bytes`,
    );
  }
  if (Object.keys(request.questions).length === 0) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
      'Decision request must declare at least one question',
    );
  }
  for (const [id, question] of Object.entries(request.questions)) validateQuestion(id, question);
}

function isDecisionEntry(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(isDecisionEntry);
  return (
    isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isDecisionEntry)
  );
}

function errorForStatus(status: number): DecisionError {
  if (status === 400 || status === 409 || status === 413 || status === 422)
    return new DecisionError('invalid_request', 'Jev rejected the decision request', status); // lexicon-exempt: upstream contract error
  if (status === 401)
    return new DecisionError('authentication', 'Jev authentication failed', status); // lexicon-exempt: upstream contract error
  if (status === 403)
    return new DecisionError('permission', 'Jev refused the decision request', status); // lexicon-exempt: upstream contract error
  if (status === 429)
    return new DecisionError('rate_limited', 'Jev rate limited the decision request', status); // lexicon-exempt: upstream contract error
  return new DecisionError('unavailable', 'Jev is unavailable', status); // lexicon-exempt: upstream contract error
}

async function enforceDisclosure(
  profile: DecisionProfile,
  model: string,
  request: DecisionRequest,
): Promise<void> {
  const verdict: DecisionDisclosureVerdict | undefined =
    await profile.guardrails?.disclosure?.enforce(request.state, {
      destination: 'typesafe',
      profileId: profile.id,
      model,
      questionIds: Object.keys(request.questions),
    });
  if (verdict?.action === 'block') {
    throw new DecisionError('disclosure_blocked', 'Decision disclosure was blocked'); // lexicon-exempt: developer contract error
  }
}

function requireApiKey(
  profile: DecisionProfile,
  binding: DecisionProfile['models'][string],
  options: RunDecisionOptions,
): string {
  const keySlot = binding.key ?? profile.key;
  const apiKey = options.apiKey ?? (keySlot ? options.keyVault?.[keySlot] : undefined);
  if (!apiKey) throw new DecisionError('authentication', 'Jev requires an API key'); // lexicon-exempt: developer contract error
  return apiKey;
}

async function sendDecisionRequest(args: {
  request: DecisionRequest;
  apiId: string;
  apiKey: string;
  options: RunDecisionOptions;
  signal: AbortSignal;
}): Promise<Response> {
  try {
    const response = await (args.options.fetch ?? globalThis.fetch)(
      args.options.endpoint ?? TYPESAFE_SYSTEM_ONE_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: args.apiId,
          state: args.request.state,
          questions: args.request.questions,
        }),
        signal: args.signal,
      },
    );
    if (!response.ok) throw errorForStatus(response.status);
    return response;
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    if (args.request.signal?.aborted)
      throw new DecisionError('cancelled', 'Decision request was cancelled'); // lexicon-exempt: developer contract error
    if (args.signal.aborted) throw new DecisionError('timeout', 'Decision request timed out'); // lexicon-exempt: developer contract error
    throw new DecisionError('network', 'Jev network request failed'); // lexicon-exempt: upstream contract error
  }
}

function usageFrom(body: Record<string, unknown>): DecisionResult['usage'] {
  const usage = body.usage;
  if (
    !isRecord(usage) ||
    !Number.isInteger(usage.input_tokens) ||
    !Number.isInteger(usage.output_tokens)
  ) {
    return undefined;
  }
  return { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number };
}

async function resultFromResponse(
  response: Response,
  questions: DecisionRequest['questions'],
): Promise<DecisionResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DecisionError('malformed_response', 'Jev returned non-JSON output'); // lexicon-exempt: upstream contract error
  }
  if (!isRecord(body) || typeof body.model !== 'string' || !isRecord(body.answers)) {
    throw new DecisionError('malformed_response', 'Jev response has an invalid shape'); // lexicon-exempt: upstream contract error
  }
  const usage = usageFrom(body);
  return {
    model: body.model,
    answers: validateAnswers(body.answers, questions),
    ...(usage ? { usage } : {}),
  };
}

/** Execute exactly one Jev System One request. This function never retries an ambiguous POST. */
export async function runDecision(
  request: DecisionRequest,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  const profile = requireDecisionProfile(request.profile);
  validateRequest(request, profile);
  const [modelId, binding] = decisionModel(profile);
  await enforceDisclosure(profile, modelId, request);
  const apiKey = requireApiKey(profile, binding, options);
  const controller = new AbortController();
  const timeout = binding.timeoutMs
    ? setTimeout(() => controller.abort(), binding.timeoutMs)
    : undefined;
  const abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await sendDecisionRequest({
      request,
      apiId: binding.apiId,
      apiKey,
      options,
      signal: controller.signal,
    });
    return await resultFromResponse(response, request.questions);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
  }
}
