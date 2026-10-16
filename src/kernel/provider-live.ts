import { TheoremError } from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import type { LiveConnection, LiveQueueItem } from '../providers/types.ts';
import type { ProviderCheckpoint, ProviderContinuationPolicy } from './checkpoint.ts';
import { type ModelBinding, protocolOf } from './protocols/binding.ts';
import type { ProtocolEvent, ProtocolSession } from './protocols/protocol.ts';
import type { RegisteredProvider } from './protocols/provider.ts';
import type { ProviderHostOptions } from './protocols/runtime.ts';
import {
  checkpointProviderState,
  guardedCall,
  kernelCall,
  protocolRequest,
  restoreProviderState,
  withProviderAbort,
} from './provider-runtime.ts';
import type { ReasoningPart } from './turn-events.ts';
import type { KeySlot, ModelEvent, ModelRequest } from './types.ts';

async function liveTerminalBatch(
  provider: RegisteredProvider,
  binding: ModelBinding,
  keySlot: KeySlot | undefined,
  request: ModelRequest,
  event: Extract<ProtocolEvent, { type: 'done' }>,
  failed: boolean,
  pending: ModelEvent[],
  boundary: ModelEvent[],
): Promise<LiveQueueItem> {
  const success =
    !failed &&
    !event.interrupted &&
    (event.stop.kind === 'completed' || event.stop.kind === 'tool');
  const checkpoint = success
    ? await checkpointProviderState(provider, binding, keySlot, event.state, request.history ?? [])
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
  closed: ReturnType<NonNullable<ProtocolSession['closeInfo']>>,
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
              : new TheoremError('unavailable', labelText('provider.session_closed')),
        }
      : {}),
    ...(closed?.warning ? { goAway: closed.warning } : {}),
  };
}

function rememberLiveCall(
  call: { callId: string; name: string },
  callNames: Map<string, string>,
  history: ModelRequest['history'],
): void {
  if (
    callNames.has(call.callId) ||
    history?.some((message) => message.role === 'tool' && message.tool_call_id === call.callId)
  )
    throw new TheoremError('bad_response', labelText('provider.settled_call'));
  callNames.set(call.callId, call.name);
}

function streamingBatch(events: ModelEvent[]): LiveQueueItem {
  return { type: 'batch', row: {}, turnPhase: 'streaming', events };
}

/** A call the model made, for the step; a step's signed reasoning rides on its first call, as in a turn. */
function queuedCall(
  call: Parameters<typeof kernelCall>[0],
  pending: readonly ModelEvent[],
  reasoning: ReasoningPart[],
): ModelEvent {
  const tool = kernelCall(call);
  const first = !pending.some((item) => item.type === 'tool');
  return {
    type: 'tool',
    tool: first && reasoning.length ? { ...tool, reasoning: reasoning.splice(0) } : tool,
  };
}

/** The batch saying the model cancelled one of its calls. */
function cancelBatch(callId: string, callNames: ReadonlyMap<string, string>): LiveQueueItem {
  const name = callNames.get(callId);
  if (!name) throw new TheoremError('bad_response', labelText('provider.tool_cancel_missing'));
  return streamingBatch([
    { type: 'tool', tool: { callId, name, at: Date.now(), phase: 'cancel' } },
  ]);
}

export async function openRegisteredLiveSession(
  provider: RegisteredProvider,
  binding: ModelBinding,
  request: ModelRequest,
  host: ProviderHostOptions,
  initial?: ProviderCheckpoint,
  policy: ProviderContinuationPolicy = {},
): Promise<LiveConnection> {
  const restored = await restoreProviderState(
    provider,
    binding,
    initial,
    request.history ?? [],
    policy,
  );
  const call = guardedCall(provider, binding, 'live', host, { ...request, liveConnection: true });
  const session = await call.openSession(
    protocolRequest(request, protocolOf(provider, binding), restored),
  );
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
      else throw new TheoremError('unsupported', labelText('provider.live_input'));
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
        yield streamingBatch([{ type: 'provider_warning', warning: restored.warning }]);
      const callNames = new Map<string, string>();
      let pending: ModelEvent[] = [];
      let boundary: ModelEvent[] = [];
      let reasoning: ReasoningPart[] = [];
      let failed = false;
      const iterator = session.events()[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await withProviderAbort(() => iterator.next(), request.signal);
          if (next.done) break;
          const raw = next.value;
          await withProviderAbort(() => sends, request.signal);
          const event = raw;
          if (event.type === 'raw') continue;
          if (event.type === 'reasoning') {
            const { type: _type, ...part } = event;
            reasoning.push(part as ReasoningPart);
            continue;
          }
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
            yield streamingBatch([...boundary, event]);
            boundary = [];
            continue;
          }
          if (event.type === 'tool_call') {
            rememberLiveCall(event.call, callNames, request.history);
            pending.push(queuedCall(event.call, pending, reasoning));
            continue;
          }
          if (event.type === 'tool_cancel') {
            const cancelled = cancelBatch(event.callId, callNames);
            pending = pending.filter(
              (item) => item.type !== 'tool' || item.tool.callId !== event.callId,
            );
            yield cancelled;
            continue;
          }
          if (event.type === 'error') failed = true;
          if (event.type === 'done') {
            if (event.stop.kind === 'generation_complete') {
              yield streamingBatch([{ type: 'done', stop: event.stop }]);
              continue;
            }
            yield await liveTerminalBatch(
              provider,
              binding,
              call.keySlot(),
              request,
              event,
              failed,
              pending,
              boundary,
            );
            pending = [];
            boundary = [];
            reasoning = [];
            failed = false;
          } else yield streamingBatch([event as ModelEvent]);
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
