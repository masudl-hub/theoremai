import { browserExecution } from './browser-execution.ts';
import type { StudioLiveBridgeOptions } from './live-session-bridge.ts';
import { TheoremError } from '../mod.ts';
import { clientError } from '../src/host/mod.ts';
import { STUDIO_READER } from './reader.ts';
import type { LiveConnection, LiveSocket } from '../react/src/client/live-messages.ts';
import type { LiveSession, LabelOverrides } from '../mod.ts';
import type { StudioTraceRoute } from './traces.ts';
import type { StudioBrowserRuntime } from './browser-transport.ts';
import { parseLiveOpenMessage } from '../react/src/server/request-check.ts';
import { liveSessionOpen } from '../react/src/server/turn-input.ts';
import { attachStudioLiveSession } from './live-session-bridge.ts';
import type { StudioRunPayload } from './run-payload.ts';
import { studioTraces } from './runtime.ts';
import { studioScope } from './runtime-scope.ts';

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

  constructor(payload: StudioRunPayload, runtime: StudioBrowserRuntime, local?: ReturnType<typeof browserExecution>) {
    // Install the UI's handlers before the first ready/error message.
    queueMicrotask(() => {
      void this.open(payload, runtime, local);
    });
  }
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.readyState !== 1) {
      throw new TheoremError('network', 'Live connection is closed'); // labels-exempt: internal diagnostic
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
    payload: StudioRunPayload,
    runtime: StudioBrowserRuntime,
    local?: ReturnType<typeof browserExecution>,
  ): Promise<void> {
    if (this.readyState === 3) return;
    this.readyState = 1;
    this.emit('onopen', new Event('open'));
    const traces = studioTraces.route((record) => this.receive({ type: 'trace', record }));
    try {
      const { scope, profile } = await studioScope(
        payload.profile,
        payload.customTools,
        payload.structured,
        runtime,
      );
      if (!runtime.providers?.vault) {
        throw new TheoremError('auth', 'Fill the vault slot this model names.'); // labels-exempt: builder diagnostic
      }
      // The client sends its open message as the socket opens: the call's slots, context and resume.
      const [first] = this.queued.splice(0, 1);
      if (typeof first !== 'string') {
        throw new TheoremError('request', 'A live call must open with its open message'); // labels-exempt: internal diagnostic
      }
      const session = await scope.runSession(
        {
          ...await (local ? (await local.boundary).prepareLiveOpen(parseLiveOpenMessage(first)) : Promise.resolve(liveSessionOpen(parseLiveOpenMessage(first)))),
          profile: profile.id,
          metadata: traces.metadata,
          signal: runtime.signal,
        },
        { execution: runtime.execution ?? local?.execution, pageExecution: runtime.pageExecution ?? local?.pageExecution, vault: runtime.providers.vault, fetch: runtime.providers.fetch ?? runtime.providers.gemini?.fetch, wait: runtime.providers.wait ?? runtime.providers.gemini?.wait, openWebSocket: runtime.providers.openWebSocket },
      );
      this.closeSession = () => session.close('client disconnected');
      if (this.readyState !== 1) {
        await this.closeSession();
        traces.close();
        return;
      }
      await this.attach(session, profile.id, traces, profile.labels, local ? { pageResult: local.pageResult,
        beforeEvent: async (event) => {
          if ((event.type === 'done' || event.type === 'provider_checkpoint') && event.providerState)
            await (await local.boundary).recordCheckpoint(event.providerState);
        } } : {});
    } catch (err) {
      traces.close();
      this.receive({ type: 'error', ...clientError(err, payload.profile.labels, STUDIO_READER) });
      this.close();
    }
  }
  private async attach(session: LiveSession, profileId: string, traces: StudioTraceRoute, labels?: LabelOverrides, options: StudioLiveBridgeOptions = {}): Promise<void> {
      const socket = {
        send: (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === 'string') this.receive(JSON.parse(data));
        },
        close: () => this.close(),
        addEventListener: this.outbound.addEventListener.bind(this.outbound),
      };
      const ended = attachStudioLiveSession(
        socket,
        session,
        profileId,
        crypto.randomUUID(),
        traces,
        labels,
        { ...options, clientEvents: STUDIO_READER },
      );
      this.closeSession = undefined;
      this.listening = true;
      for (const data of this.queued.splice(0)) {
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

export function browserStudioLiveConnection(
  payload: StudioRunPayload,
  runtime: StudioBrowserRuntime,
): LiveConnection {
  // The in-process connection knows its draft, so its open message carries none.
  const local = runtime.execution ? undefined : browserExecution();
  return { createSocket: () => new BrowserLiveSocket(payload, runtime, local) };
}
