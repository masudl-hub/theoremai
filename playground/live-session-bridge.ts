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

function pipeBrowserToSession(
  serverWs: PlaygroundLiveSocket,
  session: LiveSession,
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
            const { type: _type, ...call } = msg;
            void answerExecuteTool(serverWs, session, call, lexicon);
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
      serverWs.send(JSON.stringify({ type: 'events', events: forClientEvents([event]) }));
    }
  } catch (err) {
    serverWs.send(errorEnvelope(err, lexicon));
  } finally {
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

export function attachPlaygroundLiveSession(
  socket: PlaygroundLiveSocket,
  session: LiveSession,
  profileId: string,
  sessionId: string,
  traces: PlaygroundTraceRoute,
  lexicon?: LexiconOverrides,
): Promise<void> {
  pipeBrowserToSession(socket, session, lexicon);
  socket.addEventListener('close', () => {
    void session.close('client disconnected');
  });
  return pipeSessionToBrowser(socket, session, profileId, sessionId, traces, lexicon);
}
