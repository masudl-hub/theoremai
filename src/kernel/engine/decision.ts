import { type ErrorKind, TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import { lexiconText } from '../../guardrails/lexicon.ts';
import type { DecisionDisclosureVerdict } from '../../guardrails/types.ts';
import { resolveTraceWriter } from '../../observability/policy.ts';
import { writeSpans } from '../../observability/trace.ts';
import type { TraceSink } from '../../observability/trace-sink.ts';
import { type SpanHandle, startTrace, traceJson } from '../../observability/trace-span.ts';
import type { ProviderHostOptions } from '../provider-contract.ts';
import { validateProviderModel } from '../provider-contract.ts';
import { createProviderOperations, withProviderAbort } from '../provider-runtime.ts';
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
import { endThrownSpan } from './turn-trace.ts';

/** Where the provider takes decision requests, as its preset states. */
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

/** Options for running a decision: the key vault, transport utilities and a trace sink that replaces the profile's. */
export interface RunDecisionOptions extends ProviderHostOptions {
  /** Replaces the profile's `observability.writeTo`; an explicit sink always records, unsampled. */
  sink?: TraceSink;
}

function requireDecisionProfile(registry: KernelRegistry, id: string): DecisionProfile {
  const profile = registry.profiles.get(id);
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
    labels.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new DecisionError('malformed_response', `${path} does not match declared labels`); // lexicon-exempt: upstream contract error
  }
  const out: Record<string, number> = Object.create(null);
  for (const label of labels) out[label] = finite(value[label], `${path}.${label}`);
  const total = Object.values(out).reduce((sum, item) => sum + item, 0);
  if (Math.abs(total - 1) > 0.001) {
    throw new DecisionError('malformed_response', `${path} must sum to one`); // lexicon-exempt: upstream contract error
  }
  return out;
}

/** A score's legend: text for every declared level. */
function legend(value: unknown, labels: string[], path: string): Record<string, string> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== labels.length ||
    labels.some((label) => !Object.hasOwn(value, label)) ||
    Object.values(value).some((text) => typeof text !== 'string' || !text.trim())
  ) {
    throw new DecisionError('malformed_response', `${path} is invalid`); // lexicon-exempt: upstream contract error
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
      // lexicon-exempt: upstream contract error
      'Decision provider returned an incomplete answer set',
    );
  }
  const answers: Record<string, DecisionAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new DecisionError(
        'malformed_response',
        // lexicon-exempt: upstream contract error
        `Decision provider returned an invalid answer for '${id}'`,
      );
    }
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) {
        throw new DecisionError(
          'malformed_response',
          // lexicon-exempt: upstream contract error
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
      // lexicon-exempt: developer contract error
      `Decision question '${id}' must include instructions`,
    );
  }
  if (question.type === 'noul' && question.criteria === undefined) return;
  if (
    typeof question.type !== 'string' ||
    !['choice', 'noul', 'score'].includes(question.type) ||
    (question.type === 'score' ? !Array.isArray(question.criteria) : !isRecord(question.criteria))
  ) {
    throw new DecisionError('invalid_request', `Decision question '${id}' has invalid criteria`); // lexicon-exempt: developer contract error
  }
  const criteria = Array.isArray(question.criteria)
    ? question.criteria
    : Object.values(question.criteria as Record<string, unknown>);
  if (!criteria.length || !criteria.every(isDecisionEntry)) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
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
      // lexicon-exempt: developer contract error
      'Decision requests do not select a model; the profile runs its one model',
    );
  }
  if (request.state === null || !isJson(request.state)) {
    throw new DecisionError('invalid_request', 'Decision state must be non-null JSON'); // lexicon-exempt: developer contract error
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(request.state);
  } catch {
    // lexicon-exempt: developer contract error
    throw new DecisionError('invalid_request', 'Decision state cannot be serialized as JSON');
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (profile.inputs.maxStateBytes !== undefined && bytes > profile.inputs.maxStateBytes) {
    throw new DecisionError(
      'invalid_request',
      // lexicon-exempt: developer contract error
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
      // lexicon-exempt: developer contract error
      'Decision request must declare at least one question',
    );
  }
  for (const [id, question] of Object.entries(request.questions)) validateQuestion(id, question);
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
): Promise<void> {
  const verdict: DecisionDisclosureVerdict | undefined =
    await profile.guardrails?.disclosure?.enforce(request.state, {
      destination: provider,
      profileId: profile.id,
      model,
      questionIds: Object.keys(request.questions),
    });
  if (verdict?.action === 'block') {
    throw new DecisionError('disclosure_blocked', 'Decision disclosure was blocked'); // lexicon-exempt: developer contract error
  }
}

function decisionSpanAttributes(
  profile: DecisionProfile,
  modelId: ModelId,
  binding: DecisionProfile['models'][string],
  request: DecisionRequest,
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
  const kind =
    error instanceof TheoremError
      ? error.kind
      : error instanceof TypeError
        ? 'network'
        : 'bad_response';
  const codes: Partial<Record<ErrorKind, keyof typeof DECISION_ERROR_KINDS>> = {
    auth: 'authentication',
    rate_limit: 'rate_limited',
    network: 'network',
    unavailable: 'unavailable',
    timeout: 'timeout',
    cancelled: 'cancelled',
    request: 'invalid_request',
    unsupported: 'invalid_request',
  };
  const code =
    kind === 'auth' && isRecord(error) && error.status === 403
      ? 'permission'
      : (codes[kind] ?? 'malformed_response');
  return new DecisionError(
    code,
    lexiconText('provider.decision_failed'),
    isRecord(error) && typeof error.status === 'number' ? error.status : undefined,
  );
}

async function decide(
  registry: KernelRegistry,
  profile: DecisionProfile,
  [modelId, binding]: [ModelId, DecisionProfile['models'][string]],
  request: DecisionRequest,
  options: RunDecisionOptions,
): Promise<DecisionResult> {
  throwIfAborted(request.signal);
  const selected = registry.providers.require(binding.provider);
  const provider = {
    ...selected,
    connection: structuredClone(selected.connection),
    adapter: { ...selected.adapter },
  };
  binding = { ...binding, providerOptions: structuredClone(binding.providerOptions ?? {}) };
  await enforceDisclosure(profile, modelId, binding.provider, request);
  throwIfAborted(request.signal);
  validateProviderModel(provider, binding, 'decision');
  provider.adapter.validateRequest(
    {
      apiId: binding.apiId,
      state: request.state,
      questions: request.questions,
      signal: request.signal,
    },
    {
      apiId: binding.apiId,
      connection: provider.connection,
      providerOptions: binding.providerOptions ?? {},
    },
  );
  const controller = new AbortController();
  const timeout = binding.timeoutMs
    ? setTimeout(() => controller.abort(), binding.timeoutMs)
    : undefined;
  const abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const operations = await createProviderOperations(provider, binding, options, {
      signal: controller.signal,
    });
    const operation = operations.decide;
    if (typeof operation !== 'function')
      throw new DecisionError('invalid_request', lexiconText('provider.decision_unavailable'));
    const payload = {
      apiId: binding.apiId,
      state: request.state,
      questions: request.questions,
      signal: controller.signal,
    };
    provider.adapter.validateRequest(payload, {
      apiId: binding.apiId,
      connection: provider.connection,
      providerOptions: binding.providerOptions ?? {},
    });
    const result = await withProviderAbort(() => operation(payload), controller.signal);
    if (typeof result.model !== 'string' || !result.model.trim())
      throw new DecisionError('malformed_response', lexiconText('provider.decision_model_missing'));
    return { ...result, answers: validateAnswers(result.answers, request.questions) };
  } catch (error) {
    if (controller.signal.aborted)
      throw new DecisionError(
        request.signal?.aborted ? 'cancelled' : 'timeout',
        lexiconText('provider.decision_ended'),
      );
    throw decisionProviderError(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Exactly one decision request, traced however it ends. An ambiguous POST is never retried,
 * and a trace write failure never changes the decision's outcome.
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
  const tree = startTrace(`decide ${binding.apiId}`, {
    kind: 'CLIENT',
    attributes: decisionSpanAttributes(profile, modelId, binding, request),
    ...(request.traceparent ? { traceparent: request.traceparent } : {}),
  });
  const { sink, policy } = resolveTraceWriter({
    override: options.sink,
    observability: profile.observability,
    guardrails: profile.guardrails,
  });
  try {
    const result = await decide(registry, profile, model, request, options);
    recordResult(tree.root, result);
    tree.root.end({ code: 'OK' });
    return result;
  } catch (error) {
    endThrownSpan(tree.root, error);
    throw error;
  } finally {
    await writeSpans(sink, tree.collect(), policy, request.metadata);
  }
}
