import { errorKind, publicError, TheoremError } from '../mod.ts';
import type { LiveConnection, LiveSocket } from '../react/src/client/live-messages.ts';
import type { LiveSession, LexiconOverrides } from '../mod.ts';
import type { PlaygroundTraceRoute } from './traces.ts';
import type { PlaygroundBrowserRuntime } from './browser-transport.ts';
import { attachPlaygroundLiveSession } from './live-session-bridge.ts';
import type { PlaygroundRunPayload } from './run-payload.ts';
import { playgroundTraces } from './runtime.ts';
import { playgroundScope } from './runtime-scope.ts';

/** The Live UI's existing relay protocol, carried in memory instead of over a site socket. */
class BrowserLiveSocket implements LiveSocket {
  readyState: LiveSocket['readyState'] = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: LiveSocket['onopen'] = null;
  onmessage: LiveSocket['onmessage'] = null;
  onclose: LiveSocket['onclose'] = null;
  onerror: LiveSocket['onerror'] = null;
  private outbound = new EventTarget();
  private closeSession?: () => Promise<void>;
  private queued: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  private listening = false;

  constructor(payload: PlaygroundRunPayload, runtime: PlaygroundBrowserRuntime) {
    // Install the UI's handlers before the first ready/error message.
    queueMicrotask(() => {
      void this.open(payload, runtime);
    });
  }
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== 1) {
      throw new TheoremError('network', 'Live connection is closed'); // lexicon-exempt: internal diagnostic
    }
    if (!this.listening) this.queued.push(data);
    else this.outbound.dispatchEvent(new MessageEvent('message', { data }));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.queued = [];
    this.outbound.dispatchEvent(new Event('close'));
    void this.closeSession?.();
    this.emit('onclose', new CloseEvent('close'));
  }
  private emit(kind: 'onopen' | 'onmessage' | 'onclose' | 'onerror', event: Event): void {
    // Native socket callbacks carry a WebSocket `this`; these callbacks only read the event.
    const callback = this[kind] as ((event: Event) => void) | null;
    callback?.(event);
  }
  private async open(
    payload: PlaygroundRunPayload,
    runtime: PlaygroundBrowserRuntime,
  ): Promise<void> {
    if (this.readyState === 3) return;
    this.readyState = 1;
    this.emit('onopen', new Event('open'));
    const traces = playgroundTraces.route((record) => this.receive({ type: 'trace', record }));
    try {
      const { scope, profile } = playgroundScope(
        payload.profile,
        payload.customTools,
        payload.structured,
        runtime,
      );
      if (!runtime.providers?.vault) {
        throw new TheoremError('auth', 'Fill the vault slot this model names.'); // lexicon-exempt: builder diagnostic
      }
      const session = await scope.runSession(
        {
          profile: profile.id,
          metadata: traces.metadata,
          signal: runtime.signal,
        },
        { vault: runtime.providers.vault, gemini: runtime.providers.gemini },
      );
      this.closeSession = () => session.close('client disconnected');
      if (this.readyState !== 1) {
        await this.closeSession();
        traces.close();
        return;
      }
      await this.attach(session, profile.id, traces, profile.lexicon);
    } catch (err) {
      traces.close();
      this.receive({
        type: 'error',
        error: publicError(err, payload.profile.lexicon),
        errorKind: errorKind(err),
      });
      this.close();
    }
  }
  private async attach(session: LiveSession, profileId: string, traces: PlaygroundTraceRoute, lexicon?: LexiconOverrides): Promise<void> {
      const socket = {
        send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === 'string') this.receive(JSON.parse(data));
        },
        close: () => this.close(),
        addEventListener: this.outbound.addEventListener.bind(this.outbound),
      };
      const ended = attachPlaygroundLiveSession(
        socket,
        session,
        profileId,
        crypto.randomUUID(),
        traces,
        lexicon,
      );
      this.closeSession = undefined;
      this.listening = true;
      // The in-process connection knows its draft; discard the relay's opening draft message.
      for (const data of this.queued.splice(0)) {
        if (typeof data === 'string' && JSON.parse(data).type === 'draft') {
          continue;
        }
        this.outbound.dispatchEvent(new MessageEvent('message', { data }));
      }
      await ended;
  }
  private receive(message: unknown): void {
    if (this.readyState === 1) {
      this.emit('onmessage', new MessageEvent('message', { data: JSON.stringify(message) }));
    }
  }
}

export function browserPlaygroundLiveConnection(
  payload: PlaygroundRunPayload,
  runtime: PlaygroundBrowserRuntime,
): LiveConnection {
  return {
    openMessage: { type: 'draft' },
    createSocket: () => new BrowserLiveSocket(payload, runtime),
  };
}
