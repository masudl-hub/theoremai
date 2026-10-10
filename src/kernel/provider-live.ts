import { TheoremError } from '../guardrails/error.ts';
import { lexiconText } from '../guardrails/lexicon.ts';
import type { LiveConnection, LiveQueueItem } from '../providers/types.ts';
import type {
  ProviderCheckpoint,
  ProviderHostOptions,
  ProviderLiveConnection,
  ProviderModelEvent,
  RegisteredProvider,
} from './provider-contract.ts';
import {
  assertProviderRequirements,
  checkpointProviderState,
  createProviderOperations,
  providerTurnRequest,
  restoreProviderState,
  validateProviderEvent,
  withProviderAbort,
} from './provider-runtime.ts';
import type { ModelBinding, ProviderCompleteRequest, ProviderEvent } from './types.ts';

async function liveTerminalBatch(
  provider: RegisteredProvider,
  binding: ModelBinding,
  request: ProviderCompleteRequest,
  event: Extract<ProviderModelEvent, { type: 'done' }>,
  failed: boolean,
  pending: ProviderEvent[],
  boundary: ProviderEvent[],
): Promise<LiveQueueItem> {
  const success =
    !failed &&
    !event.interrupted &&
    (event.stop.kind === 'completed' || event.stop.kind === 'tool');
  const checkpoint = success
    ? await checkpointProviderState(provider, binding, event.state, request.history ?? [])
    : undefined;
  return {
    type: 'batch',
    row: {},
    turnPhase: success ? (event.stop.kind === 'tool' ? 'streaming' : 'complete') : 'abort',
    events: [
      ...(success ? pending : []),
      ...boundary,
      ...(checkpoint ? [{ type: 'provider_checkpoint' as const, providerState: checkpoint }] : []),
      ...(event.stop.kind === 'tool'
        ? []
        : [
            {
              type: 'done' as const,
              stop: event.stop,
              interrupted: event.interrupted,
              providerState: checkpoint,
            },
          ]),
    ],
  };
}

function liveClosedItem(
  closed: ReturnType<NonNullable<ProviderLiveConnection['closeInfo']>>,
): LiveQueueItem {
  return {
    type: 'closed',
    code: closed?.code ?? 1000,
    reason: closed?.reason ?? 'provider-closed',
    ...(closed?.error
      ? {
          error:
            closed.error instanceof TheoremError
              ? closed.error
              : new TheoremError('unavailable', lexiconText('provider.session_closed')),
        }
      : {}),
    ...(closed?.warning ? { goAway: closed.warning } : {}),
  };
}

function rememberLiveCall(
  call: Extract<ProviderModelEvent, { type: 'tool_call' }>['call'],
  callNames: Map<string, string>,
  history: ProviderCompleteRequest['history'],
): void {
  if (
    callNames.has(call.callId) ||
    history?.some((message) => message.role === 'tool' && message.tool_call_id === call.callId)
  )
    throw new TheoremError('bad_response', lexiconText('provider.settled_call'));
  callNames.set(call.callId, call.name);
}

export async function openRegisteredLiveSession(
  provider: RegisteredProvider,
  binding: ModelBinding,
  request: ProviderCompleteRequest,
  host: ProviderHostOptions,
  initial?: ProviderCheckpoint,
  onMismatch: 'rebuild' | 'error' = 'rebuild',
): Promise<LiveConnection> {
  provider = {
    ...provider,
    connection: structuredClone(provider.connection),
    adapter: {
      ...provider.adapter,
      ...(provider.adapter.continuation
        ? { continuation: { ...provider.adapter.continuation } }
        : {}),
    },
  };
  binding = { ...binding, providerOptions: structuredClone(binding.providerOptions ?? {}) };
  assertProviderRequirements(provider, binding, 'live', request);
  const restored = await restoreProviderState(
    provider,
    binding,
    initial,
    request.history ?? [],
    onMismatch,
  );
  const operations = await createProviderOperations(provider, binding, host, request);
  if (typeof operations.openSession !== 'function')
    throw new TheoremError('unsupported', lexiconText('provider.session_unavailable'));
  const session = await operations.openSession({
    ...providerTurnRequest(request),
    keySlot: binding.keySlot ?? provider.keySlot,
    fallbackKeySlot: binding.fallbackKeySlot ?? provider.fallbackKeySlot,
    state: restored.state,
  });
  let sends = Promise.resolve();
  const send = (fn: () => Promise<void>) => {
    sends = sends.then(() => withProviderAbort(fn, request.signal));
  };
  return {
    setup: {},
    flush: () => sends,
    sendInput(part) {
      if (part.type === 'text') send(() => session.sendText(part.text));
      else if (part.type === 'audio' && 'data' in part) send(() => session.sendAudio(part));
      else if (part.type === 'video' && 'data' in part) send(() => session.sendVideo(part));
      else throw new TheoremError('unsupported', lexiconText('provider.live_input'));
    },
    sendContext(text) {
      send(() => session.sendContext({ server: text }));
    },
    sendToolResponse(callId, name, output, parts) {
      send(() =>
        session.sendToolResult({
          callId,
          name,
          text: typeof output === 'string' ? output : JSON.stringify(output),
          ...(parts?.length ? { parts } : {}),
        }),
      );
    },
    close(_code, reason) {
      sends = sends.then(
        () => session.close(reason),
        () => session.close(reason),
      );
    },
    async *batches(): AsyncGenerator<LiveQueueItem> {
      if (restored.warning)
        yield {
          type: 'batch',
          row: {},
          turnPhase: 'streaming',
          events: [{ type: 'provider_warning', warning: restored.warning }],
        };
      const callNames = new Map<string, string>();
      let pending: ProviderEvent[] = [];
      let boundary: ProviderEvent[] = [];
      let failed = false;
      const iterator = session.events()[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await withProviderAbort(() => iterator.next(), request.signal);
          if (next.done) break;
          const raw = next.value;
          await withProviderAbort(() => sends, request.signal);
          const event = validateProviderEvent(raw);
          if (event.type === 'session' && event.session.kind === 'turn_complete') {
            boundary.push(event);
            continue;
          }
          if (
            event.type === 'session' &&
            boundary.length &&
            !pending.length &&
            (event.session.kind === 'working' || event.session.kind === 'idle')
          ) {
            yield { type: 'batch', row: {}, turnPhase: 'streaming', events: [...boundary, event] };
            boundary = [];
            continue;
          }
          if (event.type === 'tool_call') {
            rememberLiveCall(event.call, callNames, request.history);
            pending.push({ type: 'tool', tool: event.call });
            continue;
          }
          if (event.type === 'tool_cancel') {
            const name = callNames.get(event.callId);
            if (!name)
              throw new TheoremError('bad_response', lexiconText('provider.tool_cancel_missing'));
            pending = pending.filter(
              (item) => item.type !== 'tool' || item.tool.callId !== event.callId,
            );
            yield {
              type: 'batch',
              row: {},
              turnPhase: 'streaming',
              events: [
                {
                  type: 'tool',
                  tool: { callId: event.callId, name, at: Date.now(), phase: 'cancel' },
                },
              ],
            };
            continue;
          }
          if (event.type === 'error') failed = true;
          if (event.type === 'done') {
            if (event.stop.kind === 'generation_complete') {
              yield {
                type: 'batch',
                row: {},
                turnPhase: 'streaming',
                events: [{ type: 'done', stop: event.stop }],
              };
              continue;
            }
            yield await liveTerminalBatch(
              provider,
              binding,
              request,
              event,
              failed,
              pending,
              boundary,
            );
            pending = [];
            boundary = [];
            failed = false;
          } else yield { type: 'batch', row: {}, turnPhase: 'streaming', events: [event] };
        }
      } finally {
        const returned = iterator.return?.();
        if (returned) void returned.catch(() => {});
      }
      if (pending.length || boundary.length)
        yield {
          type: 'batch',
          row: {},
          turnPhase: 'abort',
          events: [{ type: 'done', stop: { kind: 'stream_incomplete' } }],
        };
      yield liveClosedItem(session.closeInfo?.());
    },
  };
}
