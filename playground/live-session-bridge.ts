import { errorKind, type LexiconOverrides, type LiveSession, publicError } from '../mod.ts';
import { parseLiveClientMessage } from '../react/src/server/request-check.ts';
import { forClient, forClientEvents } from '../src/host/mod.ts';
import { bytesToBase64 } from '../src/kernel/mod.ts';
import type { PlaygroundTraceRoute } from './traces.ts';

export type PlaygroundLiveSocket = Pick<WebSocket, 'send' | 'close' | 'addEventListener'>;

function errorBody(err: unknown, lexicon?: LexiconOverrides): { error: string; errorKind: string } {
  return { error: publicError(err, lexicon), errorKind: errorKind(err) };
}

function errorEnvelope(err: unknown, lexicon?: LexiconOverrides): string {
  return JSON.stringify({ type: 'error', ...errorBody(err, lexicon) });
}

/** Calls the model made that the browser has not yet run, each with a timer that settles it as unanswered. */
type CallWatch = {
  start(callId: string): void;
  stop(callId: string): void;
  stopAll(): void;
};

function callWatch(session: LiveSession, timeoutMs: number): CallWatch {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = (callId: string) => {
    clearTimeout(timers.get(callId));
    timers.delete(callId);
  };
  return {
    start(callId) {
      stop(callId);
      timers.set(
        callId,
        setTimeout(() => {
          timers.delete(callId);
          // The kernel never times out an ungated held call; a refusal here means it already settled.
          session.executeTool({ callId, host: { clientTimedOut: true } }).catch(() => {});
        }, timeoutMs),
      );
    },
    stop,
    stopAll() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

function pipeBrowserToSession(
  serverWs: PlaygroundLiveSocket,
  session: LiveSession,
  watch: CallWatch,
  lexicon?: LexiconOverrides,
): void {
  // A send the session refuses (a channel the profile turned off, a closed call) reaches the browser.
  const forward = (sent: Promise<void>): void => {
    sent.catch((err: unknown) => {
      serverWs.send(errorEnvelope(err, lexicon));
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
            forward(session.sendContext(msg.text));
            return;
          case 'executeTool': {
            const { type: _type, output, ...call } = msg;
            watch.stop(call.callId);
            void answerExecuteTool(
              serverWs,
              session,
              output === undefined ? call : { ...call, host: { clientOutput: output } },
              lexicon,
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
      serverWs.send(errorEnvelope(err, lexicon));
    }
  });
}

async function pipeSessionToBrowser(
  serverWs: PlaygroundLiveSocket,
  session: LiveSession,
  profileId: string,
  sessionId: string,
  traces: PlaygroundTraceRoute,
  watch: CallWatch,
  lexicon?: LexiconOverrides,
): Promise<void> {
  serverWs.send(JSON.stringify({ type: 'ready', profile: profileId, sessionId }));
  try {
    for await (const event of session.events()) {
      if (event.type === 'error') {
        // The session worded it with the profile's lexicon; forClient drops the builder detail.
        serverWs.send(JSON.stringify(forClient(event)));
        try {
          serverWs.close(1011, 'session error');
        } catch {
          /* ignore */
        }
        return;
      }
      if (event.type === 'tool') {
        const { tool } = event;
        if (tool.phase === undefined) watch.start(tool.callId);
        else if (tool.phase === 'complete' || tool.phase === 'error' || tool.phase === 'cancel') {
          watch.stop(tool.callId);
        }
      }
      serverWs.send(JSON.stringify({ type: 'events', events: forClientEvents([event]) }));
    }
  } catch (err) {
    serverWs.send(errorEnvelope(err, lexicon));
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
  serverWs: PlaygroundLiveSocket,
  session: LiveSession,
  call: Parameters<LiveSession['executeTool']>[0],
  lexicon?: LexiconOverrides,
): Promise<void> {
  try {
    const result = await session.executeTool(call);
    serverWs.send(
      JSON.stringify(
        result.gated
          ? {
              type: 'executeToolResult',
              callId: call.callId,
              status: 'gated',
              gate: result.gated,
            }
          : {
              type: 'executeToolResult',
              callId: call.callId,
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
        status: 'refused',
        body: errorBody(err, lexicon),
      }),
    );
  }
}

export type PlaygroundLiveBridgeOptions = {
  /** How long the browser has to run a call the model made before the bridge settles it as unanswered. */
  clientCallTimeoutMs?: number;
};

const CLIENT_CALL_TIMEOUT_MS = 20_000;

export function attachPlaygroundLiveSession(
  socket: PlaygroundLiveSocket,
  session: LiveSession,
  profileId: string,
  sessionId: string,
  traces: PlaygroundTraceRoute,
  lexicon?: LexiconOverrides,
  options: PlaygroundLiveBridgeOptions = {},
): Promise<void> {
  const watch = callWatch(session, options.clientCallTimeoutMs ?? CLIENT_CALL_TIMEOUT_MS);
  pipeBrowserToSession(socket, session, watch, lexicon);
  socket.addEventListener('close', () => {
    void session.close('client disconnected');
  });
  return pipeSessionToBrowser(socket, session, profileId, sessionId, traces, watch, lexicon);
}
