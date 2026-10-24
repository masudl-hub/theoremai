import { z } from 'zod';
import {
  type ErrorCopies,
  type ErrorCopy,
  isAbortError,
  TheoremError,
  throwIfAborted,
} from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import {
  historyHash,
  type ProviderCheckpoint,
  type ProviderContinuationPolicy,
  type ProviderWarning,
  providerCheckpointSchema,
} from './checkpoint.ts';
import { stepReplyMessages } from './interaction-parts.ts';
import { type JsonValue, jsonObjectSchema, jsonValueSchema } from './json.ts';
import {
  type DecisionModelBinding,
  keySlotsOf,
  type ModelBinding,
  protocolOf,
} from './protocols/binding.ts';
import { providerLimitsSchema } from './protocols/limits.ts';
import {
  carriesTo,
  type DecisionCall,
  type EmbeddingCall,
  type EmbeddingResult,
  type ModelProfileType,
  type Protocol,
  type ProtocolEvent,
  type ProtocolRequest,
  type ProtocolSession,
} from './protocols/protocol.ts';
import type { RegisteredProvider } from './protocols/provider.ts';
import { callProtocol, type ProviderHostOptions, plainWebSocket } from './protocols/runtime.ts';
import { ProviderBudget } from './provider-budget.ts';
import {
  type ReasoningPart,
  reasoningPartSchema,
  type ToolCallRequest,
  turnEventSchema,
  turnStopSchema,
} from './turn-events.ts';
import type {
  DecisionResult,
  KeySlot,
  ModelEvent,
  ModelRequest,
  TurnHistoryMessage,
  TurnModel,
} from './types.ts';
import { isRecord } from './util/record.ts';

const toolCallSchema = z.strictObject({
  name: z.string().min(1),
  callId: z.string().min(1),
  wireCallId: z.string().min(1).optional(),
  arguments: z.record(z.string(), jsonValueSchema),
  stepId: z.string().min(1).optional(),
  stepCallCount: z.number().int().min(1).optional(),
});
const reasoningEventSchema = reasoningPartSchema.extend({ type: z.literal('reasoning') });
const contentTypes = new Set([
  'text',
  'thought',
  'structured',
  'media',
  'grounding',
  'citation',
  'evidence',
  'tokens',
  'session',
  'tool_draft',
  'error',
  'custom',
]);
function providerStop(raw: unknown) {
  const stop = turnStopSchema.parse(raw);
  if (stop.kind === 'gate')
    throw new TheoremError('bad_response', labelText('provider.kernel_gate'));
  return stop;
}

/** Checks one event a protocol streamed has the shape its type promises. */
function validateProtocolEvent(raw: unknown): ProtocolEvent {
  if (!isRecord(raw) || typeof raw.type !== 'string')
    throw new TheoremError('bad_response', labelText('provider.event_invalid'));
  if (contentTypes.has(raw.type)) return turnEventSchema.parse(raw) as ProtocolEvent;
  switch (raw.type) {
    case 'tool_call':
      return { type: 'tool_call', call: toolCallSchema.parse(raw.call) };
    case 'tool_cancel':
      return { type: 'tool_cancel', callId: z.string().min(1).parse(raw.callId) };
    case 'reasoning':
      return reasoningEventSchema.parse(raw) as ProtocolEvent;
    case 'raw':
      return { type: 'raw', row: jsonObjectSchema.parse(raw.row) };
    case 'done':
      return {
        type: 'done',
        stop: providerStop(raw.stop),
        interrupted: z.boolean().optional().parse(raw.interrupted),
        state: raw.state,
      };
    case 'response':
      if (!isRecord(raw.response))
        throw new TheoremError('bad_response', labelText('provider.response_identity'));
      return {
        type: 'response',
        response: z
          .strictObject({ id: z.string().optional(), model: z.string().optional() })
          .parse(raw.response),
      };
    default:
      throw new TheoremError('bad_response', labelText('provider.event_type', { type: raw.type }));
  }
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
async function* guardedEvents(
  events: () => AsyncIterable<ProtocolEvent>,
  clean: (text: string) => string,
  budget: ProviderBudget,
  live = false,
): AsyncGenerator<ProtocolEvent> {
  if (!live) budget.resumeOperation();
  let iterator: AsyncIterator<ProtocolEvent> | undefined;
  try {
    iterator = events()[Symbol.asyncIterator]();
    for (;;) {
      const current = iterator;
      const next = await withProviderAbort(() => current.next(), budget.signal);
      if (next.done) break;
      const event = validateProtocolEvent(next.value);
      if (live && (event.type !== 'session' || event.session.kind === 'working'))
        budget.startLiveStep();
      budget.event(event);
      if (event.type === 'error')
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

/** One binding's calls with the kernel's guards: its budget, its key redaction, and event checks. */
export interface GuardedCall {
  complete(request: ProtocolRequest): AsyncIterable<ProtocolEvent>;
  openSession(request: ProtocolRequest): Promise<ProtocolSession>;
  decide(request: DecisionCall): Promise<DecisionResult>;
  embed(request: EmbeddingCall): Promise<EmbeddingResult>;
  /** The slot the last attempt signed with: the fallback's after a quota refusal. */
  keySlot(): KeySlot | undefined;
}

const SECRET_FIELD =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|x-goog-api-key|secret|token|access[_-]?token|refresh[_-]?token|password)$/i;

/**
 * One binding's call as the kernel runs it: the protocol runtime's keys, retries, and ids, inside
 * the host's budgets, with every key it signs with kept out of errors and traces.
 */
export function guardedCall(
  provider: RegisteredProvider,
  binding: ModelBinding | DecisionModelBinding,
  profileType: ModelProfileType,
  host: ProviderHostOptions,
  req: {
    signal?: AbortSignal;
    tapUpstream?: (row: Record<string, unknown>) => void;
    liveConnection?: boolean;
    /** The call's own deadline, in place of the limits' operation timeout. */
    timeoutMs?: number;
  },
): GuardedCall {
  const limits = Object.freeze(providerLimitsSchema.parse({ ...binding.limits, ...host.limits }));
  const budget = new ProviderBudget(
    limits,
    req.signal,
    req.timeoutMs ?? (req.liveConnection ? limits.connectTimeoutMs : limits.operationTimeoutMs),
  );
  const secrets = new Set<string>();
  const remember = (value: unknown): void => {
    if (typeof value === 'string') secrets.add(value);
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) remember(item);
  };
  const scrub = (value: JsonValue): JsonValue => {
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
          SECRET_FIELD.test(key) && typeof item === 'string' ? '[redacted]' : scrub(item),
        ]),
      );
    return value;
  };
  const clean = (text: string): string => String(scrub(text));
  let slot = keySlotsOf(provider, binding).keySlot;
  const call = callProtocol({
    provider,
    binding,
    profileType,
    limits,
    signal: budget.signal,
    fetch: budget.fetch(host.fetch ?? globalThis.fetch),
    openWebSocket: budget.socket(host.openWebSocket ?? plainWebSocket(provider.id)),
    ...(host.vault ? { vault: host.vault } : {}),
    ...(host.wait ? { wait: host.wait } : {}),
    timeLeft: () => budget.timeLeft(),
    ...(req.tapUpstream
      ? {
          tapUpstream: (row) => req.tapUpstream?.(jsonObjectSchema.parse(scrub(row as JsonValue))),
        }
      : {}),
    onKey(used, key) {
      slot = used;
      remember(key);
    },
  });
  budget.stopTimer();
  /** One request with one answer, inside the budget and its abort. */
  const once = async <R>(run: () => Promise<R>): Promise<R> => {
    try {
      budget.resumeOperation();
      const result = await withProviderAbort(() => safeProviderCall(run, clean), budget.signal);
      budget.value(result);
      return result;
    } finally {
      budget.close();
    }
  };
  return {
    keySlot: () => slot,
    complete: (request) =>
      guardedEvents(() => call.complete({ ...request, signal: budget.signal }), clean, budget),
    decide: (request) => once(() => call.decide({ ...request, signal: budget.signal })),
    embed: (request) => once(() => call.embed({ ...request, signal: budget.signal })),
    async openSession(request) {
      budget.resumeOperation();
      const session = await withProviderAbort(
        () =>
          safeProviderCall(() => call.openSession({ ...request, signal: budget.signal }), clean),
        budget.signal,
      )
        .catch((error) => {
          budget.close();
          throw error;
        })
        .finally(() => budget.stopTimer());
      return {
        events: () => guardedEvents(() => session.events(), clean, budget, true),
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
    },
  };
}

/** What saved state was written for besides the model: the connection and the keyed options. */
function compatibilityKey(
  provider: RegisteredProvider,
  binding: ModelBinding,
  protocol: Protocol,
): string {
  const options = binding.options ?? {};
  const keyed = [...(protocol.continuation?.keyOptions ?? [])]
    .sort()
    .map((name) => [name, options[name] ?? null]);
  return JSON.stringify({ connection: provider.connection ?? null, options: keyed });
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

/**
 * The protocol's saved state when the checkpoint was written for this exact call, or a warning
 * that it was not and the conversation goes from the transcript.
 */
export async function restoreProviderState(
  provider: RegisteredProvider,
  binding: ModelBinding,
  raw: ProviderCheckpoint | undefined,
  history: readonly TurnHistoryMessage[],
  policy: ProviderContinuationPolicy = {},
): Promise<{
  state?: unknown;
  covered?: number;
  wireCallIds?: Record<string, string>;
  warning?: ProviderWarning;
}> {
  if (!raw) return {};
  const checkpoint = providerCheckpointSchema.parse(raw);
  const protocol = protocolOf(provider, binding);
  const contract = protocol.continuation;
  let reason: ProviderWarning['reason'] | undefined;
  if (checkpoint.protocol !== protocol.id || checkpoint.provider !== provider.id)
    reason = 'provider_changed';
  else if (checkpoint.apiId !== binding.apiId) reason = 'model_changed';
  else if (!contract || checkpoint.version !== contract.version) reason = 'version_changed';
  else if (checkpoint.compatibilityKey !== compatibilityKey(provider, binding, protocol))
    reason = 'connection_changed';
  else if (checkpoint.keySlot !== keySlotsOf(provider, binding).keySlot) reason = 'key_changed';
  else if (
    policy.history === 'provider'
      ? history.length > 0
      : checkpoint.coveredHistoryLength > history.length ||
        checkpoint.coveredHistoryHash !==
          (await historyHash(history.slice(0, checkpoint.coveredHistoryLength)))
  )
    reason = 'history_changed';
  if (reason) return { warning: { code: 'provider_state_rebuilt', reason } };
  return {
    state: contract?.schema.parse(checkpoint.data),
    covered: policy.history === 'provider' ? 0 : checkpoint.coveredHistoryLength,
    ...(checkpoint.wireCallIds ? { wireCallIds: checkpoint.wireCallIds } : {}),
  };
}

/** Saves a protocol's state with what it was written for, or nothing when it kept none. */
export async function checkpointProviderState(
  provider: RegisteredProvider,
  binding: ModelBinding,
  keySlot: KeySlot | undefined,
  state: unknown,
  history: readonly TurnHistoryMessage[],
  wireCallIds: Record<string, string> = {},
): Promise<ProviderCheckpoint | undefined> {
  if (state === undefined) return undefined;
  const protocol = protocolOf(provider, binding);
  const contract = protocol.continuation;
  if (!contract)
    throw new TheoremError('bad_response', labelText('provider.continuation_contract'));
  return {
    protocol: protocol.id,
    provider: provider.id,
    version: contract.version,
    apiId: binding.apiId,
    ...(keySlot ? { keySlot } : {}),
    compatibilityKey: compatibilityKey(provider, binding, protocol),
    coveredHistoryLength: history.length,
    coveredHistoryHash: await historyHash(history),
    data: jsonValueSchema.parse(contract.schema.parse(state)),
    ...(Object.keys(wireCallIds).length ? { wireCallIds } : {}),
  };
}

/** Each message's reasoning, kept only where the target protocol can read it back. */
function carriedHistory(
  history: readonly TurnHistoryMessage[] | undefined,
  protocol: Protocol,
): TurnHistoryMessage[] | undefined {
  return history?.map((message) => {
    if (!message.reasoning) return message;
    const { reasoning, ...rest } = message;
    const carried = reasoning.filter((part) => carriesTo(part.origin.protocol, protocol));
    return carried.length ? { ...rest, reasoning: carried } : rest;
  });
}

/** History with each call the saved state holds under the wire's own id, as the wire knows it. */
function wireHistory(
  history: TurnHistoryMessage[] | undefined,
  wireCallIds: Record<string, string> | undefined,
): TurnHistoryMessage[] | undefined {
  if (!history || !wireCallIds) return history;
  const wire = (id: string) => wireCallIds[id] ?? id;
  return history.map((message) => ({
    ...message,
    ...(message.tool_calls
      ? { tool_calls: message.tool_calls.map((call) => ({ ...call, id: wire(call.id) })) }
      : {}),
    ...(message.tool_call_id ? { tool_call_id: wire(message.tool_call_id) } : {}),
  }));
}

/** The engine's request as the protocol gets it, with its saved state when reused. */
export function protocolRequest(
  request: ModelRequest,
  protocol: Protocol,
  restored: { state?: unknown; covered?: number; wireCallIds?: Record<string, string> },
): ProtocolRequest {
  const { providerState: _checkpoint, tapUpstream: _tap, history, ...portable } = request;
  const carried = wireHistory(carriedHistory(history, protocol), restored.wireCallIds);
  return {
    ...portable,
    ...(carried ? { history: carried } : {}),
    ...(restored.state !== undefined
      ? { state: restored.state, stateHistoryLength: restored.covered }
      : {}),
  };
}

/** A call the kernel hands on: its Theorem id, never the wire's. */
export function kernelCall(
  call: Extract<ProtocolEvent, { type: 'tool_call' }>['call'],
): ToolCallRequest {
  const { wireCallId: _wire, ...rest } = call;
  return rest;
}

async function* consumeModelStep(
  events: AsyncIterable<ProtocolEvent>,
  signal?: AbortSignal,
): AsyncGenerator<
  ModelEvent,
  {
    terminal?: Extract<ProtocolEvent, { type: 'done' }>;
    failed: boolean;
    pending: ToolCallRequest[];
    reasoning: ReasoningPart[];
    text: string;
    structured?: unknown;
    wireCallIds: Record<string, string>;
  }
> {
  const wireCallIds: Record<string, string> = {};
  let terminal: Extract<ProtocolEvent, { type: 'done' }> | undefined;
  let failed = false;
  const pending: ToolCallRequest[] = [];
  const reasoning: ReasoningPart[] = [];
  let text = '';
  let structured: unknown;
  const iterator = events[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const next = await withProviderAbort(() => iterator.next(), signal);
      if (next.done) {
        exhausted = true;
        break;
      }
      throwIfAborted(signal);
      const event = next.value;
      if (terminal)
        throw new TheoremError('bad_response', labelText('provider.events_after_completion'));
      switch (event.type) {
        case 'raw':
          continue;
        case 'text':
          text += event.text;
          break;
        case 'structured':
          structured = event.structured;
          break;
        case 'reasoning': {
          const { type: _type, ...part } = event;
          reasoning.push(part as ReasoningPart);
          break;
        }
        case 'tool_call':
          if (pending.some((call) => call.callId === event.call.callId))
            throw new TheoremError('bad_response', labelText('provider.duplicate_call'));
          if (event.call.wireCallId) wireCallIds[event.call.callId] = event.call.wireCallId;
          pending.push(kernelCall(event.call));
          continue;
        case 'tool_cancel':
          throw new TheoremError('bad_response', labelText('provider.tool_cancel_live'));
        case 'error':
          failed = true;
          break;
        case 'done':
          terminal = event;
          continue;
      }
      yield event as ModelEvent;
    }
  } finally {
    if (!exhausted && iterator.return)
      void Promise.resolve(iterator.return()).catch(() => undefined);
  }

  return {
    terminal,
    failed,
    pending,
    reasoning,
    text,
    ...(structured !== undefined ? { structured } : {}),
    wireCallIds,
  };
}

/**
 * A profile's model as the engine calls it: each step one guarded protocol call, with the
 * protocol's saved state reused while it still fits and rebuilt, with a warning, when it does not.
 */
export function registeredTurnModel(
  provider: RegisteredProvider,
  binding: ModelBinding,
  profileType: ModelProfileType,
  host: ProviderHostOptions,
  initial?: ProviderCheckpoint,
  policy: ProviderContinuationPolicy = {},
  hostHistory: readonly TurnHistoryMessage[] = [],
): TurnModel {
  const protocol = protocolOf(provider, binding);
  let active = initial;
  return {
    async *complete(req): AsyncGenerator<ModelEvent> {
      // invariant: Only the checkpoint the host handed in follows the profile's history holder,
      // judged against the history the host passed. A checkpoint from an earlier step of this
      // turn always covers this turn's own history.
      const providerHeld = active === initial && policy.history === 'provider';
      const restored = await restoreProviderState(
        provider,
        binding,
        active,
        providerHeld ? hostHistory : (req.history ?? []),
        providerHeld ? policy : {},
      );
      if (restored.warning) {
        active = undefined;
        yield { type: 'provider_warning', warning: restored.warning };
      }
      const call = guardedCall(provider, binding, profileType, host, req);
      const { terminal, failed, pending, reasoning, text, structured, wireCallIds } =
        yield* consumeModelStep(
          call.complete(protocolRequest(req, protocol, restored)),
          req.signal,
        );
      throwIfAborted(req.signal);
      if (!terminal) {
        yield { type: 'done', stop: { kind: failed ? 'provider_error' : 'stream_incomplete' } };
        return;
      }
      if (
        failed ||
        terminal.interrupted ||
        (terminal.stop.kind !== 'tool' && terminal.stop.kind !== 'completed')
      ) {
        yield { type: 'done', stop: terminal.stop };
        return;
      }
      const history = [...(req.history ?? [])];
      if (req.input.length)
        history.push(
          req.input.every((part) => part.type === 'text')
            ? {
                role: 'user',
                content: req.input.map((part) => (part.type === 'text' ? part.text : '')).join(''),
              }
            : { role: 'user', parts: req.input },
        );
      const checkpoint = await checkpointProviderState(
        provider,
        binding,
        call.keySlot(),
        terminal.state,
        [
          ...history,
          ...stepReplyMessages({
            text,
            structured,
            calls: pending.map((entry, index) => (index === 0 ? { ...entry, reasoning } : entry)),
          }),
        ],
        { ...restored.wireCallIds, ...wireCallIds },
      );
      active = checkpoint;
      for (const entry of pending) yield { type: 'tool', tool: entry };
      yield { type: 'done', stop: terminal.stop, providerState: checkpoint };
    },
  };
}
