import { errorKind, publicError } from '@theoremjs/agents';
import type { HostTransport } from './host-transport.ts';
import type { PageTools } from './live/live-page-tool.ts';
import type { TheoremTransport, TurnEventSink } from './transport.ts';

export type PageDispatchResult = {
  callId: string;
  operationId: string;
  grantId: string;
  page: { output: unknown } | { unanswered: true };
};

export function withPageToolDispatch(
  transport: TheoremTransport,
  tools?: PageTools,
): TheoremTransport;
export function withPageToolDispatch(transport: HostTransport, tools?: PageTools): HostTransport;
export function withPageToolDispatch(
  transport: TheoremTransport | HostTransport,
  tools?: PageTools,
): TheoremTransport | HostTransport {
  const sink = (onEvent: TurnEventSink, signal?: AbortSignal): TurnEventSink => {
    const dispatched = new Set<string>();
    return (event) => {
      onEvent(event);
      if (event.type !== 'tool' || event.tool.phase !== 'dispatch') return;
      const { tool } = event;
      if (!transport.pageResult || !tool.operationId || signal?.aborted) return;
      const key = JSON.stringify([tool.operationId, tool.grantId]);
      if (dispatched.has(key)) return;
      dispatched.add(key);
      const callback = tools && Object.hasOwn(tools, tool.name) ? tools[tool.name] : undefined;
      const reference = {
        callId: tool.callId,
        operationId: tool.operationId,
        grantId: tool.grantId,
      };
      void Promise.resolve()
        .then(async () => {
          if (signal?.aborted) return;
          const page = callback
            ? await Promise.resolve()
                .then(() => callback(tool.arguments, reference))
                .catch(() => ({ unanswered: true }) as const)
            : ({ unanswered: true } as const);
          await transport.pageResult?.({ ...reference, page }, signal);
        })
        .catch((error: unknown) => {
          if (!signal?.aborted)
            onEvent({ type: 'error', errorKind: errorKind(error), error: publicError(error) });
        });
    };
  };
  const shared = {
    ...transport,
    describe: transport.describe.bind(transport),
    invoke: (
      request: Parameters<HostTransport['invoke']>[0],
      onEvent: TurnEventSink,
      signal?: AbortSignal,
    ) => transport.invoke(request, sink(onEvent, signal), signal),
  };
  if ('call' in transport)
    return {
      ...shared,
      describe: transport.describe.bind(transport),
      call: (request, onEvent, signal) => transport.call(request, sink(onEvent, signal), signal),
    };
  return {
    ...shared,
    describe: transport.describe.bind(transport),
    turn: (request, onEvent, signal) => transport.turn(request, sink(onEvent, signal), signal),
    steer: transport.steer.bind(transport),
  };
}
