import type { PageToolResult } from '../react/src/server/page-dispatch.ts';
import type { LabelOverrides, LiveSession, TurnEvent } from '../mod.ts';
import { parseLiveClientMessage } from '../react/src/server/request-check.ts';
import { type ClientError, clientError, forClient, forClientEvents } from '../src/host/mod.ts';
import { STUDIO_READER } from './reader.ts';
import { issuedOperationId as requiredOperationId } from '../react/src/client/turn-client.ts';
import { bytesToBase64 } from '../src/kernel/mod.ts';
import type { StudioTraceRoute } from './traces.ts';

export type StudioLiveSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>;

function errorBody(err: unknown, labels?: LabelOverrides): ClientError {
  return clientError(err, labels, STUDIO_READER);
}

function errorEnvelope(err: unknown, labels?: LabelOverrides): string {
  return JSON.stringify({ type: 'error', ...errorBody(err, labels) });
}

/** Calls the model made that the browser has not yet run, each with a timer that settles it as unanswered. */
type CallWatch = {
  start(callId: string, operationId: string): void;
  stop(callId: string, operationId: string): void;
  stopAll(): void;
};

function callWatch(session: LiveSession, timeoutMs: number): CallWatch {
  const timers = new Map<string, { operationId: string; timer: ReturnType<typeof setTimeout> }>();
  const stop = (callId: string, operationId: string) => {
    const watched = timers.get(callId);
    if (watched?.operationId !== operationId) return;
    clearTimeout(watched.timer);
    timers.delete(callId);
  };
  return {
    start(callId, operationId) {
      const previous = timers.get(callId);
      if (previous) clearTimeout(previous.timer);
      timers.set(
        callId,
        { operationId, timer: setTimeout(() => {
          timers.delete(callId);
          // The kernel never times out an ungated held call; a refusal here means it already settled.
          session.executeTool({ callId, operationId, page: { timedOut: true } }).catch(() => {});
        }, timeoutMs) },
      );
    },
    stop,
    stopAll() {
      for (const watched of timers.values()) clearTimeout(watched.timer);
      timers.clear();
    },
  };
}

function pipeBrowserToSession(
  serverWs: StudioLiveSocket,
  session: LiveSession,
  watch: CallWatch,
  labels?: LabelOverrides,
  pageResult?: (result: PageToolResult) => Promise<boolean | void>,
): void {
  // A send the session refuses (a channel the profile turned off, a closed call) reaches the browser.
  const forward = (sent: Promise<void>): void => {
    sent.catch((err: unknown) => {
      serverWs.send(errorEnvelope(err, labels));
    });
  };
  serverWs.addEventListener('message', (event: MessageEvent) => {
    try {
      if (typeof event.data === 'string') {
        // A message that fails its check ends the call with a `request` error (the catch below).
        const msg = parseLiveClientMessage(event.data);
        switch (msg.type) {
          case 'audio':
            forward(
              session.sendAudio({
                data: msg.data,
                mimeType: 'audio/pcm;rate=16000',
              }),
            );
            return;
          case 'video':
            forward(session.sendVideo({ data: msg.data, mimeType: msg.mimeType }));
            return;
          case 'text':
            forward(session.sendText(msg.text));
            return;
          case 'context':
            forward(session.sendContext({ client: msg.context }));
            return;
          case 'executeTool': {
            const { type: _type, output, grantId, unanswered, ...call } = msg;
            if (grantId) {
              if (!pageResult) throw new Error('Page dispatch result is unavailable');
              forward(pageResult({ callId: call.callId, operationId: call.operationId, grantId,
                page: unanswered ? { unanswered: true } : { output } }).then((settled) => {
                  if (settled) serverWs.send(JSON.stringify({ type: 'executeToolResult', callId: call.callId, operationId: call.operationId, status: 'settled' }));
                }));
              return;
            }
            if (pageResult && output !== undefined) throw new Error('Page result requires a dispatch grant');
            watch.stop(call.callId, call.operationId);
            void answerExecuteTool(
              serverWs,
              session,
              output === undefined ? call : { ...call, page: { output } },
              labels,
            );
            return;
          }
        }
      }
      if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
        forward(
          session.sendAudio({
            data: bytesToBase64(
              event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data),
            ),
            mimeType: 'audio/pcm;rate=16000',
          }),
        );
      }
    } catch (err) {
      serverWs.send(errorEnvelope(err, labels));
    }
  });
}

async function pipeSessionToBrowser(
  serverWs: StudioLiveSocket,
  session: LiveSession,
  profileId: string,
  sessionId: string,
  traces: StudioTraceRoute,
  watch: CallWatch,
  labels: LabelOverrides | undefined,
  beforeEvent?: (event: TurnEvent) => void | Promise<void>,
): Promise<void> {
  serverWs.send(JSON.stringify({ type: 'ready', profile: profileId, sessionId }));
  try {
    for await (const event of session.events()) {
      await beforeEvent?.(event);
      if (event.type === 'error') {
        serverWs.send(JSON.stringify(forClient(event, STUDIO_READER)));
        try {
          serverWs.close(1011, 'session error');
        } catch {
          /* ignore */
        }
        return;
      }
      if (event.type === 'tool') {
        const { tool } = event;
        if (tool.phase === 'dispatch') {
          watch.stop(tool.callId, requiredOperationId(tool));
          serverWs.send(JSON.stringify({ type: 'executeToolResult', callId: tool.callId,
            operationId: requiredOperationId(tool), status: 'dispatched', grantId: tool.grantId, arguments: tool.arguments }));
        }
        if (tool.phase === undefined) watch.start(tool.callId, requiredOperationId(tool));
        else if (tool.phase === 'complete' || tool.phase === 'error' || tool.phase === 'cancel') {
          watch.stop(tool.callId, requiredOperationId(tool));
        }
      }
      serverWs.send(JSON.stringify({ type: 'events', events: forClientEvents([event], STUDIO_READER) }));
    }
  } catch (err) {
    serverWs.send(errorEnvelope(err, labels));
  } finally {
    watch.stopAll();
    // The events loop ends after the session's root record is written.
    traces.close();
    try {
      serverWs.close(1000, 'session ended');
    } catch {
      /* ignore */
    }
  }
}

/** Run the browser's `executeTool` on the session and tell the browser what became of the call. */
async function answerExecuteTool(
  serverWs: StudioLiveSocket,
  session: LiveSession,
  call: Parameters<LiveSession['executeTool']>[0] & { operationId: string },
  labels?: LabelOverrides,
): Promise<void> {
  try {
    const result = await session.executeTool(call);
    serverWs.send(
      JSON.stringify(
        result.gated
          ? {
              type: 'executeToolResult',
              callId: call.callId,
              operationId: call.operationId,
              status: 'gated',
              gate: result.gated,
            }
          : {
              type: 'executeToolResult',
              callId: call.callId,
              operationId: call.operationId,
              status: 'settled',
            },
      ),
    );
  } catch (err) {
    // The session refused it (an unknown call, a decision it takes no more): the browser reads why.
    serverWs.send(
      JSON.stringify({
        type: 'executeToolResult',
        callId: call.callId,
        operationId: call.operationId,
        status: 'refused',
        body: errorBody(err, labels),
      }),
    );
  }
}

export type StudioLiveBridgeOptions = {
  pageResult?: (result: PageToolResult) => Promise<boolean | void>;
  /** Save trusted checkpoint ownership before the bridge exposes the event. */
  beforeEvent?: (event: TurnEvent) => void | Promise<void>;
  /** How long the browser has to run a call the model made before the bridge settles it as unanswered. */
  clientCallTimeoutMs?: number;
};

const CLIENT_CALL_TIMEOUT_MS = 20_000;

export function attachStudioLiveSession(
  socket: StudioLiveSocket,
  session: LiveSession,
  profileId: string,
  sessionId: string,
  traces: StudioTraceRoute,
  labels?: LabelOverrides,
  options: StudioLiveBridgeOptions = {},
): Promise<void> {
  const watch = callWatch(session, options.clientCallTimeoutMs ?? CLIENT_CALL_TIMEOUT_MS);
  pipeBrowserToSession(socket, session, watch, labels, options.pageResult);
  socket.addEventListener('close', () => {
    void session.close('client disconnected');
  });
  return pipeSessionToBrowser(socket, session, profileId, sessionId, traces, watch, labels, options.beforeEvent);
}
