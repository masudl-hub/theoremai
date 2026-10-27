import { type ErrorKind, errorKind, TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { DecisionDisclosureVerdict } from '../../guardrails/types.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import { type SpanHandle, traceJson } from '../../observability/trace-span.ts';
import type { DecisionCall } from '../protocols/protocol.ts';
import type { ProviderHostOptions } from '../protocols/runtime.ts';
import { guardedCall } from '../provider-runtime.ts';
import type { KernelRegistry } from '../registry/kernel-registry.ts';
import { soleModelId } from '../registry/sole-model.ts';
import type {
  DecisionAnswer,
  DecisionJson,
  DecisionProfile,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  ModelId,
} from '../types.ts';
import { isRecord } from '../util/record.ts';
import { tracedCall } from './call-trace.ts';
import { referencedAssets } from './decision-references.ts';

/** Each decision failure code, and the error kind it reads as. */
const DECISION_ERROR_KINDS = {
  invalid_config: 'config',
  invalid_request: 'request',
  conflict: 'conflict',
  not_found: 'not_found',
  invalid_input: 'input',
  not_allowed: 'action',
  authentication: 'auth',
  permission: 'auth',
  rate_limited: 'rate_limit',
  busy: 'busy',
  unsupported: 'unsupported',
  unavailable: 'unavailable',
  network: 'network',
  timeout: 'timeout',
  cancelled: 'cancelled',
  malformed_response: 'bad_response',
  refused: 'safety',
  blocked: 'blocked',
  disclosure_blocked: 'blocked',
  declined: 'declined',
  failed: 'failed',
  internal: 'internal',
} as const satisfies Record<string, ErrorKind>;

/** Each kind's code: a thrown failure keeps its kind. */
const DECISION_CODES: Readonly<Record<ErrorKind, keyof typeof DECISION_ERROR_KINDS>> = {
  config: 'invalid_config',
  request: 'invalid_request',
  conflict: 'conflict',
  not_found: 'not_found',
  input: 'invalid_input',
  action: 'not_allowed',
  auth: 'authentication',
  rate_limit: 'rate_limited',
  busy: 'busy',
  unsupported: 'unsupported',
  unavailable: 'unavailable',
  bad_response: 'malformed_response',
  network: 'network',
  timeout: 'timeout',
  safety: 'refused',
  blocked: 'blocked',
  declined: 'declined',
  failed: 'failed',
  cancelled: 'cancelled',
  internal: 'internal',
};

/**
 * A normalized native-decision failure; response bodies are deliberately omitted. What the
 * provider path threw is its `cause`, and a failure the framework named reads as that failure.
 */
export class DecisionError extends TheoremError {
  constructor(
    readonly code: keyof typeof DECISION_ERROR_KINDS,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(DECISION_ERROR_KINDS[code], message, options);
  }
}

/** Options for running a decision: the key vault, transport utilities, and a trace sink that replaces the profile's. */
export interface RunDecisionOptions extends ProviderHostOptions {
  /** Replaces the profile's `observability.writeTo`; an explicit sink always records, unsampled. */
  sink?: TraceSink;
}

function requireDecisionProfile(registry: KernelRegistry, id: string): DecisionProfile {
  const profile = registry.profiles.get(id);
  if (profile.type !== 'decision') {
    throw new TheoremError(
      'request',
      // labels-exempt: developer contract error
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
      `Profile ${profile.id}: type 'decision' must declare exactly one model`, // labels-exempt: developer contract error
    );
  }
  return [modelId, binding];
}

function finite(value: unknown, path: string, min = 0, max = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new DecisionError('malformed_response', `${path} is outside its valid range`); // labels-exempt: upstream contract error
  }
  return value;
}

function distribution(value: unknown, labels: string[], path: string): Record<string, number> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== labels.length ||
    labels.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new DecisionError('malformed_response', `${path} does not match declared labels`); // labels-exempt: upstream contract error
  }
  const out: Record<string, number> = Object.create(null);
  for (const label of labels) out[label] = finite(value[label], `${path}.${label}`);
  const total = Object.values(out).reduce((sum, item) => sum + item, 0);
  // why: Answers come rounded to hundredths, so each label may be off by half of one.
  if (Math.abs(total - 1) > 0.005 * labels.length + 1e-9) {
    throw new DecisionError('malformed_response', `${path} must sum to one`); // labels-exempt: upstream contract error
  }
  return out;
}

/** A box's four edges, each a fraction of the image, with the low edge before the high one. */
function box(value: unknown, path: string) {
  if (!isRecord(value)) throw new DecisionError('malformed_response', `${path} is invalid`); // labels-exempt: upstream contract error
  const edges = {
    top: finite(value.top, `${path}.top`),
    bottom: finite(value.bottom, `${path}.bottom`),
    left: finite(value.left, `${path}.left`),
    right: finite(value.right, `${path}.right`),
  };
  if (edges.left >= edges.right || edges.top >= edges.bottom)
    throw new DecisionError('malformed_response', `${path} has an edge out of order`); // labels-exempt: upstream contract error
  return edges;
}

/** A score's legend: text for every declared level. */
function legend(value: unknown, labels: string[], path: string): Record<string, string> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== labels.length ||
    labels.some((label) => !Object.hasOwn(value, label)) ||
    Object.values(value).some((text) => typeof text !== 'string' || !text.trim())
  ) {
    throw new DecisionError('malformed_response', `${path} is invalid`); // labels-exempt: upstream contract error
  }
  return value as Record<string, string>;
}

function validateAnswers(
  raw: unknown,
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionAnswer> {
  if (!isRecord(raw) || Object.keys(raw).length !== Object.keys(questions).length) {
    throw new DecisionError(
      'malformed_response',
      // labels-exempt: upstream contract error
      'Decision provider returned an incomplete answer set',
    );
  }
  const answers: Record<string, DecisionAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new DecisionError(
        'malformed_response',
        // labels-exempt: upstream contract error
        `Decision provider returned an invalid answer for '${id}'`,
      );
    }
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) {
        throw new DecisionError(
          'malformed_response',
          // labels-exempt: upstream contract error
          `Decision provider returned an undeclared choice for '${id}'`,
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
    } else if (question.type === 'box') {
      answers[id] = {
        type: 'box',
        box: box(answer.box, `${id}.box`),
        confidence: finite(answer.confidence, `${id}.confidence`),
      };
    } else {
      const labels = question.criteria.map((_, index) => String(index));
      answers[id] = {
        type: 'score',
        score: finite(answer.score, `${id}.score`, 0, Math.max(0, labels.length - 1)),
        confidence: finite(answer.confidence, `${id}.confidence`),
        legend: legend(answer.legend, labels, `${id}.legend`),
        probabilities: distribution(answer.probabilities, labels, `${id}.probabilities`),
      };
    }
  }
  return answers;
}

function isJson(value: unknown): value is DecisionJson {
  const ancestors = new Set<object>();
  const pending: { value: unknown; exit?: boolean }[] = [{ value }];
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const item = next.value;
    if (next.exit) {
      ancestors.delete(item as object);
      continue;
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(item).length) return false;
    ancestors.add(item);
    pending.push({ value: item, exit: true });
    const entries = Array.isArray(item) ? Array.from(item) : Object.values(item);
    for (const entry of entries) pending.push({ value: entry });
  }
  return true;
}

function validateQuestion(id: string, question: unknown): void {
  if (!isRecord(question) || !id.trim() || !isDecisionEntry(question.instructions)) {
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      `Decision question '${id}' must include instructions`,
    );
  }
  if ((question.type === 'noul' || question.type === 'box') && question.criteria === undefined)
    return;
  if (
    typeof question.type !== 'string' ||
    !['choice', 'noul', 'score'].includes(question.type) ||
    (question.type === 'score' ? !Array.isArray(question.criteria) : !isRecord(question.criteria))
  ) {
    throw new DecisionError('invalid_request', `Decision question '${id}' has invalid criteria`); // labels-exempt: developer contract error
  }
  const criteria = Array.isArray(question.criteria)
    ? question.criteria
    : Object.values(question.criteria as Record<string, unknown>);
  if (!criteria.length || !criteria.every(isDecisionEntry)) {
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      `Decision ${question.type} '${id}' must declare criteria`,
    );
  }
}

/** Check a decision before a host spends quota or dispatches it. Does not apply model-specific policy. */
export function validateDecisionRequest(
  request: Omit<DecisionRequest, 'state' | 'questions'> & { state: unknown; questions: unknown },
  profile: DecisionProfile,
): asserts request is DecisionRequest {
  throwIfAborted(request.signal);
  if ((request as DecisionRequest & { model?: unknown }).model !== undefined) {
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      'Decision requests do not select a model; the profile runs its one model',
    );
  }
  if (request.state === null || !isJson(request.state)) {
    throw new DecisionError('invalid_request', 'Decision state must be non-null JSON'); // labels-exempt: developer contract error
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(request.state);
  } catch {
    // labels-exempt: developer contract error
    throw new DecisionError('invalid_request', 'Decision state cannot be serialized as JSON');
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (profile.inputs.maxStateBytes !== undefined && bytes > profile.inputs.maxStateBytes) {
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      `Decision state exceeds ${profile.inputs.maxStateBytes} bytes`,
    );
  }
  if (
    !isRecord(request.questions) ||
    !isJson(request.questions) ||
    Object.keys(request.questions).length === 0
  ) {
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      'Decision request must declare at least one question',
    );
  }
  for (const [id, question] of Object.entries(request.questions)) validateQuestion(id, question);
  if (request.assets !== undefined) validateAssets(request.assets);
  for (const [id, question] of Object.entries(request.questions))
    validateBoxImage(id, question, request.state, request.assets);
}

function stateAt(state: unknown, path: string): unknown {
  let value = state;
  for (const step of path.split('.')) {
    if (!isRecord(value) && !Array.isArray(value)) return undefined;
    value = Array.isArray(value) ? value[Number(step)] : value[step];
  }
  return value;
}

/** A box's image names an image the request holds, itself or through the state field it gives. */
function validateBoxImage(
  id: string,
  question: DecisionJson,
  state: unknown,
  assets: DecisionRequest['assets'],
): void {
  if (!isRecord(question) || question.image === undefined) return;
  const image = question.image;
  const reference = typeof image === 'string' && !assets?.[image] ? stateAt(state, image) : image;
  if (question.type !== 'box' || typeof reference !== 'string' || assets?.[reference] === undefined)
    throw new DecisionError(
      'invalid_request',
      // labels-exempt: developer contract error
      `Decision question '${id}' has an image that is neither a held image nor a state field holding one`,
    );
}

/** The question as a provider reads it: a box's image said in its instructions, not as a field. */
function providerQuestion(
  question: DecisionQuestion,
  assets: DecisionRequest['assets'],
): DecisionQuestion {
  if (question.type !== 'box' || question.image === undefined) return question;
  const { image, instructions } = question;
  const hint = labelText('decision.box_image', {
    image: assets?.[image] ? image : `\`${image}\``,
  });
  return {
    type: 'box',
    instructions:
      typeof instructions === 'string' ? `${instructions} ${hint}` : [instructions, hint],
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Only what any provider needs: a known image type and bare, padded base64. The provider holds its own limits. */
function validateAssets(assets: unknown): void {
  if (!isRecord(assets) || Object.keys(assets).length === 0)
    throw new DecisionError('invalid_request', 'Decision assets must name at least one image'); // labels-exempt: developer contract error
  for (const [reference, asset] of Object.entries(assets)) {
    if (
      !reference.trim() ||
      !isRecord(asset) ||
      (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') ||
      typeof asset.data !== 'string' ||
      asset.data.length % 4 !== 0 ||
      !BASE64.test(asset.data)
    )
      throw new DecisionError(
        'invalid_request',
        // labels-exempt: developer contract error
        `Decision asset '${reference}' must be PNG or JPEG bytes as padded base64`,
      );
  }
}

function isDecisionEntry(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (!item.trim()) return false;
      continue;
    }
    if (!isRecord(item) && !Array.isArray(item)) return false;
    const entries = Object.values(item);
    if (!entries.length) return false;
    for (const entry of entries) pending.push(entry);
  }
  return true;
}

async function enforceDisclosure(
  profile: DecisionProfile,
  model: string,
  provider: DecisionProfile['models'][string]['provider'],
  request: DecisionRequest,
  assets: DecisionCall['assets'],
): Promise<void> {
  const verdict: DecisionDisclosureVerdict | undefined =
    await profile.guardrails?.disclosure?.enforce(request.state, {
      destination: provider,
      profileId: profile.id,
      model,
      questionIds: Object.keys(request.questions),
      ...(assets ? { assets } : {}),
    });
  if (verdict?.action === 'block') {
    throw new DecisionError('disclosure_blocked', 'Decision disclosure was blocked'); // labels-exempt: developer contract error
  }
}

function decisionSpanAttributes(
  profile: DecisionProfile,
  modelId: ModelId,
  binding: DecisionProfile['models'][string],
  request: DecisionRequest,
  assets: DecisionCall['assets'],
) {
  return {
    'gen_ai.operation.name': 'decide',
    'gen_ai.provider.name': binding.provider,
    'gen_ai.agent.name': profile.id,
    'gen_ai.request.model': binding.apiId,
    'theorem.model.id': modelId,
    'theorem.decision.contract': profile.decision.contract,
    'theorem.decision.state': traceJson(request.state),
    'theorem.decision.questions': traceJson(request.questions),
    ...(assets
      ? {
          // invariant: Image bytes never reach a trace; it keeps each image's type and size.
          'theorem.decision.assets': traceJson(
            Object.fromEntries(
              Object.entries(assets).map(([reference, { mimeType, data }]) => [
                reference,
                { mimeType, bytes: data.length },
              ]),
            ),
          ),
        }
      : {}),
  };
}

function recordResult(root: SpanHandle, result: DecisionResult): void {
  root.set({
    'gen_ai.response.model': result.model,
    'theorem.decision.answers': traceJson(result.answers),
    ...(result.usage
      ? {
          'gen_ai.usage.input_tokens': result.usage.inputTokens,
          'gen_ai.usage.output_tokens': result.usage.outputTokens,
          ...(result.usage.costUsd === undefined
            ? {}
            : { 'theorem.usage.cost_usd': result.usage.costUsd }),
        }
      : {}),
  });
}

function decisionProviderError(error: unknown): DecisionError {
  if (error instanceof DecisionError) return error;
  const kind = errorKind(error);
  const code =
    kind === 'auth' && isRecord(error) && error.status === 403
      ? 'permission'
      : DECISION_CODES[kind];
  return new DecisionError(
    code,
    // why: A framework failure's message holds no response body, and says what stopped the decision.
    error instanceof TheoremError ? error.message : labelText('provider.decision_failed'),
    isRecord(error) && typeof error.status === 'number' ? error.status : undefined,
    { cause: error },
  );
}

/** What the provider gets: each box's image said in its instructions, and only the images a string references. */
function sentCall(request: DecisionRequest): Omit<DecisionCall, 'apiId'> {
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [
      id,
      providerQuestion(question, request.assets),
    ]),
  );
  const assets = request.assets
    ? referencedAssets(
        [
          request.state,
          ...Object.values(questions).flatMap((question) => [
            question.instructions,
            'criteria' in question ? question.criteria : undefined,
          ]),
        ],
        request.assets,
      )
    : {};
  return {
    state: request.state,
    questions,
    ...(Object.keys(assets).length ? { assets } : {}),
  };
}

async function decide(
  registry: KernelRegistry,
  profile: DecisionProfile,
  [modelId, binding]: [ModelId, DecisionProfile['models'][string]],
  request: DecisionRequest,
  sent: Omit<DecisionCall, 'apiId'>,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  throwIfAborted(request.signal);
  const provider = registry.providers.require(binding.provider, binding.apiId);
  await enforceDisclosure(profile, modelId, binding.provider, request, sent.assets);
  throwIfAborted(request.signal);
  try {
    const call = guardedCall(provider, binding, 'decision', options, {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(binding.timeoutMs ? { timeoutMs: binding.timeoutMs } : {}),
    });
    const result = await call.decide({ apiId: binding.apiId, ...sent });
    if (typeof result.model !== 'string' || !result.model.trim())
      throw new DecisionError('malformed_response', labelText('provider.decision_model_missing'));
    return { ...result, answers: validateAnswers(result.answers, request.questions) };
  } catch (error) {
    if (request.signal?.aborted)
      throw new DecisionError('cancelled', labelText('provider.decision_ended'));
    throw decisionProviderError(error);
  }
}

/**
 * One decision, traced however it ends. A transient failure (408, 429, a 5xx gateway or a network
 * error) is retried within five seconds; a trace write failure never changes the decision's outcome.
 */
export async function runDecisionInRegistry(
  registry: KernelRegistry,
  request: DecisionRequest,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  const profile = requireDecisionProfile(registry, request.profile);
  validateDecisionRequest(request, profile);
  const model = decisionModel(profile);
  const [modelId, binding] = model;
  const sent = sentCall(request);
  return await tracedCall(
    {
      name: `decide ${binding.apiId}`,
      attributes: decisionSpanAttributes(profile, modelId, binding, request, sent.assets),
      traceparent: request.traceparent,
      metadata: request.metadata,
      writer: {
        override: options.sink,
        observability: profile.observability,
        guardrails: profile.guardrails,
      },
    },
    async (root) => {
      const result = await decide(registry, profile, model, request, sent, options);
      recordResult(root, result);
      return result;
    },
  );
}
