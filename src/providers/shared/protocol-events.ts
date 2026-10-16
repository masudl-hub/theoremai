import type { ProtocolEvent } from '../../kernel/protocols/mod.ts';
import type { ProviderEvent } from '../../kernel/types.ts';

/**
 * One event from the shared Gemini and Chat Completions readers, as a protocol event: a finished
 * call is a `tool_call`, a cancelled one a `tool_cancel`, and a broken one an error. A `done` keeps
 * only its stop; the protocol adds its own state.
 */
export function asProtocolEvent<S>(event: ProviderEvent): ProtocolEvent<S> | undefined {
  if (event.type === 'done')
    return {
      type: 'done',
      stop: event.stop,
      ...(event.interrupted === undefined ? {} : { interrupted: event.interrupted }),
    };
  if (event.type !== 'tool') return event as ProtocolEvent<S>;
  if (event.tool.phase === undefined) return { type: 'tool_call', call: event.tool };
  if (event.tool.phase === 'cancel') return { type: 'tool_cancel', callId: event.tool.callId };
  return event.tool.phase === 'error' ? { type: 'error', errorKind: 'bad_response' } : undefined;
}
