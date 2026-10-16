import { z } from 'zod';
import {
  type ErrorCopies,
  type ErrorCopy,
  isAbortError,
  TheoremError,
  throwIfAborted,
} from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import { liveIngressEnabledFromSpec } from './engine/live-ingress.ts';
import { historyToolCalls } from './interaction-parts.ts';
import { ProviderBudget } from './provider-budget.ts';
import type {
  ProviderCheckpoint,
  ProviderContext,
  ProviderContinuationPolicy,
  ProviderHostOptions,
  ProviderModelEvent,
  ProviderOperations,
  ProviderWarning,
  RegisteredProvider,
} from './provider-contract.ts';
import {
  historyHash,
  jsonObjectSchema,
  jsonValueSchema,
  providerCheckpointSchema,
  resolveProviderLimits,
  validateProviderModel,
} from './provider-contract.ts';
import type { ToolCallRequest } from './turn-events.ts';
import { turnEventSchema, turnStopSchema } from './turn-events.ts';
import type {
  ModelBinding,
  ModelProvider,
  ProviderCompleteRequest,
  ProviderEvent,
  TurnHistoryMessage,
} from './types.ts';
import { isRecord } from './util/record.ts';

const toolRequestSchema = z.strictObject({
  name: z.string().min(1),
  callId: z.string().min(1),
  arguments: z.record(z.string(), jsonValueSchema),
  thoughtSignature: z.string().optional(),
  stepId: z.string().optional(),
  stepCallCount: z.number().int().min(1).optional(),
});
const modelContentTypes = new Set([
  'text',
  'thought',
  'structured',
  'media',
  'grounding',
  'citation',
  'evidence',
  'tokens',
  'session',
  'error',
]);
function providerStop(raw: unknown) {
  const stop = turnStopSchema.parse(raw);
  if (stop.kind === 'gate')
    throw new TheoremError('bad_response', labelText('provider.kernel_gate'));
  return stop;
}
export function validateProviderEvent(raw: unknown): ProviderModelEvent {
  if (!isRecord(raw) || typeof raw.type !== 'string')
    throw new TheoremError('bad_response', labelText('provider.event_invalid'));
  if (modelContentTypes.has(raw.type)) return turnEventSchema.parse(raw) as ProviderModelEvent;
  if (raw.type === 'tool_call')
    return { type: 'tool_call', call: toolRequestSchema.parse(raw.call) };
  if (raw.type === 'tool_cancel')
    return { type: 'tool_cancel', callId: z.string().min(1).parse(raw.callId) };
  if (raw.type === 'done') {
    return {
      type: 'done',
      stop: providerStop(raw.stop),
      interrupted: z.boolean().optional().parse(raw.interrupted),
      state: raw.state,
    };
  }
  if (raw.type === 'response') {
    if (!isRecord(raw.response))
      throw new TheoremError('bad_response', labelText('provider.response_identity'));
    return {
      type: 'response',
      response: z
        .strictObject({ id: z.string().optional(), model: z.string().optional() })
        .parse(raw.response),
    };
  }
  throw new TheoremError('bad_response', labelText('provider.event_type', { type: raw.type }));
}

export function assertProviderRequirements(
  provider: RegisteredProvider,
  binding: ModelBinding,
  profileType: string,
  req: ProviderCompleteRequest,
): void {
  const cap = validateProviderModel(provider, binding, profileType);
  const assertFeature = (feature: keyof typeof cap.features, needed: boolean) => {
    if (needed && cap.features[feature] !== 'supported')
      throw new TheoremError(
        'unsupported',
        labelText('provider.feature', { provider: provider.id, feature }),
      );
  };
  assertFeature('streaming', req.stream !== false);
  assertFeature('clientTools', (req.wireTools?.length ?? 0) > 0);
  assertFeature(
    'parallelTools',
    (req.history ?? []).some((message) => (message.tool_calls?.length ?? 0) > 1),
  );
  assertFeature('structuredOutput', req.structured !== null);
  assertFeature('thinking', req.thinking !== undefined && req.thinking !== 'none');
  assertFeature('summaries', req.summaries !== undefined && req.summaries !== 'none');
  const parts = [...req.input, ...(req.history ?? []).flatMap((message) => message.parts ?? [])];
  for (const part of parts)
    if (!cap.inputKinds.includes(part.type))
      throw new TheoremError(
        'unsupported',
        labelText('provider.input_kind', { provider: provider.id, kind: part.type }),
      );
  if (profileType === 'live') {
    for (const kind of ['text', 'audio', 'video'] as const)
      if (liveIngressEnabledFromSpec(req.live?.ingress, kind) && !cap.inputKinds.includes(kind))
        throw new TheoremError(
          'unsupported',
          labelText('provider.input_kind', { provider: provider.id, kind }),
        );
  }
  const output =
    profileType === 'image'
      ? 'image'
      : profileType === 'speech' || profileType === 'live'
        ? 'audio'
        : 'text';
  if (profileType !== 'decision' && !cap.outputKinds.includes(output))
    throw new TheoremError(
      'unsupported',
      labelText('provider.output_kind', { provider: provider.id, kind: output }),
    );
  for (const builtin of req.builtins)
    if (!cap.builtins.includes(builtin.id))
      throw new TheoremError(
        'unsupported',
        labelText('provider.builtin', { provider: provider.id, builtin: builtin.id }),
      );
  provider.adapter.validateRequest(providerTurnRequest(req), {
    apiId: binding.apiId,
    connection: provider.connection,
    providerOptions: binding.providerOptions ?? {},
  });
}

export async function withProviderAbort<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return operation();
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function diagnosticCopy(
  copy: ErrorCopies | undefined,
  clean: (text: string) => string,
): ErrorCopies | undefined {
  if (!copy) return undefined;
  const line = (value: ErrorCopy): ErrorCopy => ({
    ...value,
    ...(value.params
      ? {
          params: Object.fromEntries(
            Object.entries(value.params).map(([key, parameter]) => [
              key,
              typeof parameter === 'string' ? clean(parameter) : parameter,
            ]),
          ),
        }
      : {}),
  });
  return 'key' in copy ? line(copy) : copy.map(line);
}
function diagnosticError(error: unknown, clean: (text: string) => string): Error {
  const message = clean(error instanceof Error ? error.message : String(error));
  if (error instanceof DOMException) return new DOMException(message, error.name);
  if (isAbortError(error)) return new DOMException(message, 'AbortError');
  const result =
    error instanceof TheoremError
      ? new TheoremError(error.kind, message, { copy: diagnosticCopy(error.copy, clean) })
      : error instanceof TypeError
        ? new TypeError(message)
        : new Error(message);
  if (isRecord(error) && typeof error.status === 'number')
    Object.assign(result, { status: error.status });
  return result;
}
async function safeProviderCall<T>(
  operation: () => Promise<T>,
  clean: (text: string) => string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw diagnosticError(error, clean);
  }
}
async function* safeModelEvents(
  events: () => AsyncIterable<ProviderModelEvent>,
  clean: (text: string) => string,
  budget: ProviderBudget,
  live = false,
): AsyncGenerator<ProviderModelEvent> {
  if (!live) budget.resumeOperation();
  let iterator: AsyncIterator<ProviderModelEvent> | undefined;
  try {
    iterator = events()[Symbol.asyncIterator]();
    for (;;) {
      const current = iterator;
      const next = await withProviderAbort(() => current.next(), budget.signal);
      if (next.done) break;
      const event = validateProviderEvent(next.value);
      if (live && (event.type !== 'session' || event.session.kind === 'working'))
        budget.startLiveStep();
      budget.event(event);
      if (event?.type === 'error')
        yield {
          ...event,
          ...(event.errorCopy ? { errorCopy: diagnosticCopy(event.errorCopy, clean) } : {}),
          ...(event.errorInternal ? { errorInternal: clean(event.errorInternal) } : {}),
          ...(event.error ? { error: clean(event.error) } : {}),
        };
      else yield event;
      if (live && event.type === 'done') budget.resetStep();
    }
  } catch (error) {
    throw diagnosticError(error, clean);
  } finally {
    budget.close();
    if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
  }
}
function protectedOperations(
  operations: ProviderOperations,
  clean: (text: string) => string,
  budget: ProviderBudget,
): ProviderOperations {
  const complete =
    typeof operations.complete === 'function' ? operations.complete.bind(operations) : undefined;
  const decide =
    typeof operations.decide === 'function' ? operations.decide.bind(operations) : undefined;
  const open =
    typeof operations.openSession === 'function'
      ? operations.openSession.bind(operations)
      : undefined;
  return {
    complete: complete
      ? (request) =>
          safeModelEvents(() => complete({ ...request, signal: budget.signal }), clean, budget)
      : undefined,
    decide: decide
      ? async (request) => {
          try {
            budget.resumeOperation();
            const result = await withProviderAbort(
              () => safeProviderCall(() => decide({ ...request, signal: budget.signal }), clean),
              budget.signal,
            );
            budget.value(result);
            return result;
          } finally {
            budget.close();
          }
        }
      : undefined,
    openSession: open
      ? async (request) => {
          budget.resumeOperation();
          const session = await withProviderAbort(
            () => safeProviderCall(() => open({ ...request, signal: budget.signal }), clean),
            budget.signal,
          )
            .catch((error) => {
              budget.close();
              throw error;
            })
            .finally(() => budget.stopTimer());
          return {
            events: () => safeModelEvents(() => session.events(), clean, budget, true),
            closeInfo: () => {
              const closed = session.closeInfo?.();
              return (
                closed && {
                  ...closed,
                  ...(closed.error ? { error: diagnosticError(closed.error, clean) } : {}),
                }
              );
            },
            sendText: (text) => {
              budget.startLiveStep();
              return safeProviderCall(() => session.sendText(text), clean);
            },
            sendAudio: (media) => safeProviderCall(() => session.sendAudio(media), clean),
            sendVideo: (media) => safeProviderCall(() => session.sendVideo(media), clean),
            sendContext: (context) => safeProviderCall(() => session.sendContext(context), clean),
            sendToolResult: (result) => {
              budget.startLiveStep();
              return safeProviderCall(() => session.sendToolResult(result), clean);
            },
            close: (reason) => {
              budget.stopTimer();
              return safeProviderCall(() => session.close(reason), clean).finally(() =>
                budget.dispose(),
              );
            },
          };
        }
      : undefined,
  };
}

export async function createProviderOperations(
  provider: RegisteredProvider,
  binding: ModelBinding,
  host: ProviderHostOptions,
  req: {
    signal?: AbortSignal;
    tapUpstream?: (row: Record<string, unknown>) => void;
    liveConnection?: boolean;
  },
): Promise<ProviderOperations> {
  const limits = resolveProviderLimits(host.limits);
  const budget = new ProviderBudget(
    limits,
    req.signal,
    req.liveConnection ? limits.connectTimeoutMs : limits.operationTimeoutMs,
  );
  req = { ...req, signal: budget.signal };
  const secrets = new Set<string>();
  const remember = (value: unknown): void => {
    if (typeof value === 'string') secrets.add(value);
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) remember(item);
  };
  const scrub = (
    value: import('./provider-contract.ts').JsonValue,
  ): import('./provider-contract.ts').JsonValue => {
    if (typeof value === 'string') {
      let clean = value;
      for (const secret of secrets) {
        if (secret && (secret.length >= 4 || clean === secret))
          clean = clean.split(secret).join('[redacted]');
      }
      return clean;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          String(scrub(key)),
          /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|x-goog-api-key|secret|token|access[_-]?token|refresh[_-]?token|password)$/i.test(
            key,
          ) && typeof item === 'string'
            ? '[redacted]'
            : scrub(item),
        ]),
      );
    return value;
  };
  const resolveCredential: ProviderContext['resolveCredential'] = async (which) => {
    throwIfAborted(req.signal);
    const slot =
      which === 'primary'
        ? (binding.keySlot ?? provider.keySlot)
        : (binding.fallbackKeySlot ?? provider.fallbackKeySlot);
    if (!slot) return undefined;
    let entry: import('./provider-contract.ts').ProviderVault[string];
    try {
      entry = host.vault && Object.hasOwn(host.vault, slot) ? host.vault[slot] : undefined;
    } catch {
      throwIfAborted(req.signal);
      throw new TheoremError('auth', labelText('provider.credential_resolution'));
    }
    if (entry === undefined && which === 'fallback') return undefined;
    if (entry === undefined)
      throw new TheoremError('auth', labelText('provider.credential_missing', { slot }));
    let value: unknown;
    try {
      value =
        typeof entry === 'function'
          ? await withProviderAbort(
              () =>
                entry({
                  keySlot: slot,
                  providerId: provider.id,
                  apiId: binding.apiId,
                  signal: req.signal,
                }),
              req.signal,
            )
          : entry;
    } catch {
      throwIfAborted(req.signal);
      throw new TheoremError('auth', labelText('provider.credential_resolution'));
    }
    throwIfAborted(req.signal);
    try {
      const serializable = z.union([z.string(), jsonObjectSchema]).safeParse(value);
      if (!serializable.success)
        throw new TheoremError('auth', labelText('provider.credential_shape'));
      remember(serializable.data);
      const credential = await withProviderAbort(
        () => provider.adapter.credentialSchema.safeParseAsync(serializable.data),
        req.signal,
      );
      if (!credential.success)
        throw new TheoremError('auth', labelText('provider.credential_shape'));
      remember(credential.data);
      return credential.data;
    } catch {
      throwIfAborted(req.signal);
      throw new TheoremError('auth', labelText('provider.credential_shape'));
    }
  };
  const wait =
    host.wait ??
    ((ms: number, signal?: AbortSignal | null) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
      }));
  const clean = (text: string): string => String(scrub(text));
  let operations: ProviderOperations;
  try {
    operations = await safeProviderCall(
      () =>
        withProviderAbort(
          () =>
            provider.adapter.create({
              apiId: binding.apiId,
              connection: provider.connection,
              providerOptions: provider.adapter.optionsSchema.parse(binding.providerOptions ?? {}),
              resolveCredential,
              signal: req.signal,
              limits,
              fetch: budget.fetch(host.fetch ?? globalThis.fetch),
              wait,
              openWebSocket: budget.socket(host.openWebSocket),
              tapUpstream: (row) => req.tapUpstream?.(jsonObjectSchema.parse(scrub(row))),
            }),
          req.signal,
        ),
      clean,
    );
  } catch (error) {
    budget.close();
    throw error;
  }
  budget.stopTimer();
  return protectedOperations(operations, clean, budget);
}

function requireStoredContinuation(provider: RegisteredProvider, binding: ModelBinding): void {
  const cap = provider.adapter.capabilities({
    apiId: binding.apiId,
    connection: provider.connection,
    providerOptions: binding.providerOptions ?? {},
  });
  if (cap.features.storedContinuation !== 'supported')
    throw new TheoremError('unsupported', labelText('provider.stored_continuation'));
}

/** `history: 'stateless'`: every request stands alone, so one that carries a conversation is refused. */
export function assertHistoryKept(
  policy: ProviderContinuationPolicy | undefined,
  checkpoint: ProviderCheckpoint | undefined,
  history: readonly TurnHistoryMessage[] | undefined,
): void {
  if (policy?.history === 'stateless' && (checkpoint || history?.length))
    throw new TheoremError('request', labelText('provider.stateless_history'));
}

export async function restoreProviderState(
  provider: RegisteredProvider,
  binding: ModelBinding,
  raw: ProviderCheckpoint | undefined,
  history: readonly TurnHistoryMessage[],
  policy: ProviderContinuationPolicy = { onMismatch: 'rebuild' },
): Promise<{ state?: unknown; covered?: number; warning?: ProviderWarning }> {
  if (!raw) return {};
  const checkpoint = providerCheckpointSchema.parse(raw);
  const contract = provider.adapter.continuation;
  const key = contract?.compatibilityKey({
    apiId: binding.apiId,
    connection: provider.connection,
    providerOptions: binding.providerOptions ?? {},
  });
  let reason: ProviderWarning['reason'] | undefined;
  if (checkpoint.providerId !== provider.id || checkpoint.adapterId !== provider.adapter.id)
    reason = 'provider_changed';
  else if (checkpoint.apiId !== binding.apiId) reason = 'model_changed';
  else if (!contract || checkpoint.version !== contract.version) reason = 'version_changed';
  else if (checkpoint.compatibilityKey !== key) reason = 'connection_changed';
  else if (
    policy.history === 'provider'
      ? history.length > 0
      : checkpoint.coveredHistoryLength > history.length ||
        checkpoint.coveredHistoryHash !==
          (await historyHash(history.slice(0, checkpoint.coveredHistoryLength)))
  )
    reason = 'history_changed';
  if (reason) {
    if (policy.onMismatch === 'error')
      throw new TheoremError('request', labelText('provider.continuation_mismatch'));
    return { warning: { code: 'provider_state_rebuilt', reason } };
  }
  requireStoredContinuation(provider, binding);
  return {
    state: contract?.schema.parse(checkpoint.data),
    covered: policy.history === 'provider' ? 0 : checkpoint.coveredHistoryLength,
  };
}

export async function checkpointProviderState(
  provider: RegisteredProvider,
  binding: ModelBinding,
  state: unknown,
  history: readonly TurnHistoryMessage[],
): Promise<ProviderCheckpoint | undefined> {
  if (state === undefined) return undefined;
  if (!provider.adapter.continuation)
    throw new TheoremError('bad_response', labelText('provider.continuation_contract'));
  requireStoredContinuation(provider, binding);
  const contract = provider.adapter.continuation;
  const data = jsonValueSchema.parse(contract.schema.parse(state));
  return {
    providerId: provider.id,
    adapterId: provider.adapter.id,
    version: contract.version,
    apiId: binding.apiId,
    compatibilityKey: contract.compatibilityKey({
      apiId: binding.apiId,
      connection: provider.connection,
      providerOptions: binding.providerOptions ?? {},
    }),
    coveredHistoryLength: history.length,
    coveredHistoryHash: await historyHash(history),
    data,
  };
}

export function providerTurnRequest(request: ProviderCompleteRequest) {
  const {
    previousInteractionId: _previous,
    continuation: _continuation,
    store: _store,
    cache: _cache,
    sessionResumptionHandle: _handle,
    providerState: _checkpoint,
    state: _state,
    ...portable
  } = request;
  return portable;
}

async function* consumeModelStep(
  events: AsyncIterable<ProviderModelEvent>,
  signal?: AbortSignal,
): AsyncGenerator<
  ProviderEvent,
  {
    terminal?: Extract<ProviderModelEvent, { type: 'done' }>;
    failed: boolean;
    pending: ToolCallRequest[];
    outputs: TurnHistoryMessage[];
  }
> {
  let terminal: Extract<ProviderModelEvent, { type: 'done' }> | undefined;
  let failed = false;
  const pending: ToolCallRequest[] = [];
  let text = '';
  const outputs: TurnHistoryMessage[] = [];
  const flushText = () => {
    if (text) outputs.push({ role: 'assistant', content: text });
    text = '';
  };
  const iterator = events[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const next = await withProviderAbort(() => iterator.next(), signal);
      if (next.done) {
        exhausted = true;
        break;
      }
      const raw = next.value;
      throwIfAborted(signal);
      const event = validateProviderEvent(raw);
      if (terminal)
        throw new TheoremError('bad_response', labelText('provider.events_after_completion'));
      if (event.type === 'text') text += event.text;
      if (event.type === 'structured') {
        flushText();
        outputs.push({ role: 'assistant', content: JSON.stringify(event.structured) });
      }
      if (event.type === 'tool_call') {
        if (pending.some((call) => call.callId === event.call.callId))
          throw new TheoremError('bad_response', labelText('provider.duplicate_call'));
        flushText();
        pending.push(event.call);
        continue;
      }
      if (event.type === 'tool_cancel')
        throw new TheoremError('bad_response', labelText('provider.tool_cancel_live'));
      if (event.type === 'error') failed = true;
      if (event.type === 'done') {
        terminal = event;
      } else yield event;
    }
  } finally {
    if (!exhausted && iterator.return)
      void Promise.resolve(iterator.return()).catch(() => undefined);
  }

  flushText();
  return { terminal, failed, pending, outputs };
}
export function snapshotRegisteredProvider(provider: RegisteredProvider): RegisteredProvider {
  const adapter = provider.adapter;
  const continuation = adapter.continuation;
  return {
    ...provider,
    connection: structuredClone(provider.connection),
    adapter: {
      apiVersion: adapter.apiVersion,
      id: adapter.id,
      ...(adapter.builtins ? { builtins: adapter.builtins } : {}),
      connectionSchema: adapter.connectionSchema,
      optionsSchema: adapter.optionsSchema,
      credentialSchema: adapter.credentialSchema,
      capabilities: adapter.capabilities.bind(adapter),
      validateRequest: adapter.validateRequest.bind(adapter),
      create: adapter.create.bind(adapter),
      ...(continuation
        ? {
            continuation: {
              version: continuation.version,
              schema: continuation.schema,
              compatibilityKey: continuation.compatibilityKey.bind(continuation),
            },
          }
        : {}),
    },
  };
}

export function registeredTurnProvider(
  provider: RegisteredProvider,
  binding: ModelBinding,
  profileType: string,
  host: ProviderHostOptions,
  initial?: ProviderCheckpoint,
  policy: ProviderContinuationPolicy = { onMismatch: 'rebuild' },
  hostHistory: readonly TurnHistoryMessage[] = [],
): ModelProvider {
  let active = initial;
  return {
    async *complete(req): AsyncGenerator<ProviderEvent> {
      assertProviderRequirements(provider, binding, profileType, req);
      // invariant: Only the checkpoint the host handed in follows the profile's history holder,
      // judged against the history the host passed. A checkpoint from an earlier step of this
      // turn always covers this turn's own history.
      const providerHeld = active === initial && policy.history === 'provider';
      const restored = await restoreProviderState(
        provider,
        binding,
        active,
        providerHeld ? hostHistory : (req.history ?? []),
        providerHeld ? policy : { onMismatch: policy.onMismatch },
      );
      if (restored.warning) {
        active = undefined;
        yield { type: 'provider_warning', warning: restored.warning };
      }
      const native = restored.state;
      const operations = await createProviderOperations(provider, binding, host, req);
      if (typeof operations.complete !== 'function')
        throw new TheoremError('unsupported', labelText('provider.complete_unavailable'));
      const { terminal, failed, pending, outputs } = yield* consumeModelStep(
        operations.complete({
          ...providerTurnRequest(req),
          keySlot: binding.keySlot ?? provider.keySlot,
          fallbackKeySlot: binding.fallbackKeySlot ?? provider.fallbackKeySlot,
          state: native,
          stateHistoryLength: restored.covered,
        }),
        req.signal,
      );
      throwIfAborted(req.signal);
      if (!terminal) {
        yield { type: 'done', stop: { kind: failed ? 'provider_error' : 'stream_incomplete' } };
        return;
      }
      if (
        !failed &&
        !terminal.interrupted &&
        (terminal.stop.kind === 'tool' || terminal.stop.kind === 'completed')
      ) {
        if (
          pending.length > 1 &&
          validateProviderModel(provider, binding, profileType).features.parallelTools !==
            'supported'
        )
          throw new TheoremError('unsupported', labelText('provider.parallel_tools'));
        if (pending.length) outputs.push(historyToolCalls(pending));
        const history = [...(req.history ?? [])];
        if (req.input.length)
          history.push(
            req.input.every((part) => part.type === 'text')
              ? {
                  role: 'user',
                  content: req.input
                    .map((part) => (part.type === 'text' ? part.text : ''))
                    .join(''),
                }
              : { role: 'user', parts: req.input },
          );
        const checkpoint = await checkpointProviderState(provider, binding, terminal.state, [
          ...history,
          ...(pending.length ? outputs.filter((message) => message.tool_calls) : outputs),
        ]);
        active = checkpoint;
        for (const call of pending) yield { type: 'tool', tool: call };
        yield { type: 'done', stop: terminal.stop, providerState: checkpoint };
      } else yield { type: 'done', stop: terminal.stop };
    },
  };
}
