/**
 * A voice call with one of the project's live profiles: the page's socket on one side, the
 * project's own session on the other. The call opens with the page's open message, as a call to
 * the application's relay does.
 *
 * @module
 */

import {
  errorKind,
  type LiveSession,
  type Profile,
  type ProviderHostOptions,
  publicError,
  resolveObservabilityPolicy,
  runSession,
  TheoremError,
  type TraceSink,
} from '../../mod.ts';
import { liveSessionOpen, parseLiveOpenMessage } from '../../react/src/server/mod.ts';
import { attachStudioLiveSession } from '../live-session-bridge.ts';
import type { StudioTraceLine } from '../traces.ts';

/** The server's end of the page's socket, and the answer that completes the upgrade. */
export type StudioUpgrade = (request: Request) => { socket: WebSocket; response: Response };

/** The call's records reach the page through its own sink, so the bridge has no route to close. */
const NO_ROUTE = { metadata: {}, close: () => {} };

/**
 * Where a call's trace goes: to the page, as each record is written. A call made in the studio is
 * a test, so its records stay out of the store the profile writes to. A profile that records
 * nothing sends nothing, and what the profile keeps private stays out, as in any trace.
 */
function pageSink(socket: WebSocket, profile: Profile): TraceSink | undefined {
  if (!resolveObservabilityPolicy(profile.observability).record) return undefined;
  return {
    write: (record) => {
      const line: StudioTraceLine = { type: 'trace', record };
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(line));
      return Promise.resolve();
    },
  };
}

/** The page's first message. A failure when it is malformed, or the page leaves before it. */
function openMessage(socket: WebSocket) {
  return new Promise<ReturnType<typeof parseLiveOpenMessage>>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      socket.removeEventListener('close', onClose);
      try {
        resolve(parseLiveOpenMessage(typeof event.data === 'string' ? event.data : ''));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onClose = () => {
      socket.removeEventListener('message', onMessage);
      // lexicon-exempt: internal diagnostic; the user reads error.network
      reject(new TheoremError('network', 'Live socket closed before its first message'));
    };
    socket.addEventListener('message', onMessage, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  });
}

/** Runs the call until either side ends it. A failure to open reaches the page worded, with its kind. */
async function relay(socket: WebSocket, profile: Profile, provider: ProviderHostOptions): Promise<void> {
  let session: LiveSession;
  try {
    // Listen before anything waits: the page sends its open message as the socket opens.
    const open = await openMessage(socket);
    session = await runSession({ ...liveSessionOpen(open), profile: profile.id }, provider, pageSink(socket, profile));
  } catch (error) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ type: 'error', error: publicError(error, profile.lexicon), errorKind: errorKind(error) }),
    );
    socket.close(1011, 'session error');
    return;
  }
  // The page may have left while the session opened; its close event has already fired.
  if (socket.readyState !== WebSocket.OPEN) {
    await session.close('client disconnected');
    return;
  }
  await attachStudioLiveSession(socket, session, profile.id, crypto.randomUUID(), NO_ROUTE, profile.lexicon);
}

/** Serves a live profile: a socket upgrade starts a call, and anything else is told to upgrade. */
export function createStudioLiveHandler(
  profile: Profile,
  provider: ProviderHostOptions,
  upgrade: StudioUpgrade,
): (request: Request) => Promise<Response> {
  return (request) => {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Promise.resolve(new Response(null, { status: 426, headers: { upgrade: 'websocket' } }));
    }
    const { socket, response } = upgrade(request);
    void relay(socket, profile, provider);
    return Promise.resolve(response);
  };
}
