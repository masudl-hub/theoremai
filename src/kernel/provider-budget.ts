import { TheoremError, throwIfAborted } from '../guardrails/error.ts';
import { labelText } from '../guardrails/labels.ts';
import type {
  OpenProviderWebSocket,
  ProviderLimits,
  ProviderModelEvent,
} from './provider-contract.ts';

function combinedSignal(signals: AbortSignal[]) {
  const controller = new AbortController();
  const releases: (() => void)[] = [];
  const dispose = () => {
    for (const release of releases.splice(0)) release();
  };
  for (const signal of signals) {
    const abort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    releases.push(() => signal.removeEventListener('abort', abort));
  }
  return { signal: controller.signal, dispose };
}

export class ProviderBudget {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private timerDeadline?: number;
  private wireBytes = 0;
  private stepBytes = 0;
  private stepEvents = 0;
  private calls = new Set<string>();
  private deadline: number;
  private releaseSignal: () => void;

  constructor(
    readonly limits: ProviderLimits,
    caller?: AbortSignal,
    timeoutMs = limits.operationTimeoutMs,
  ) {
    const effective = combinedSignal(
      caller ? [caller, this.controller.signal] : [this.controller.signal],
    );
    this.signal = effective.signal;
    this.releaseSignal = effective.dispose;
    this.startTimer(timeoutMs);
    this.deadline = performance.now() + timeoutMs;
  }

  resumeOperation(): void {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) {
      this.controller.abort(new TheoremError('timeout', labelText('error.timeout')));
      throwIfAborted(this.signal);
    }
    this.startTimer(remaining);
  }

  startTimer(ms: number): void {
    this.stopTimer();
    this.timerDeadline = performance.now() + ms;
    this.timer = setTimeout(
      () => this.controller.abort(new TheoremError('timeout', labelText('error.timeout'))),
      ms,
    );
  }

  stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDeadline = undefined;
  }

  close(): void {
    this.controller.abort();
    this.dispose();
  }

  dispose(): void {
    this.stopTimer();
    this.releaseSignal();
  }

  startLiveStep(): void {
    if (this.timer === undefined) this.startTimer(this.limits.liveStepTimeoutMs);
  }

  fail(): never {
    const error = new TheoremError('bad_response', labelText('provider.budget_exhausted'), {
      copy: { key: 'provider.budget_exhausted' },
    });
    this.controller.abort(error);
    throw error;
  }

  private checkDeadline(): void {
    if (this.timerDeadline !== undefined && performance.now() >= this.timerDeadline) {
      this.controller.abort(new TheoremError('timeout', labelText('error.timeout')));
    }
    throwIfAborted(this.signal);
  }

  value(value: unknown): void {
    this.checkDeadline();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    this.checkDeadline();
    this.stepBytes += bytes;
    this.stepEvents++;
    if (
      bytes > this.limits.maxEventBytes ||
      this.stepBytes > this.limits.maxStepBytes ||
      this.stepEvents > this.limits.maxStepEvents
    )
      this.fail();
  }

  event(event: ProviderModelEvent): void {
    this.value(event);
    if (event.type === 'tool_call') this.calls.add(event.call.callId);
    if (event.type === 'tool_cancel') this.calls.delete(event.callId);
    if (this.calls.size > this.limits.maxPendingToolCalls) this.fail();
  }

  resetStep(): void {
    this.stepBytes = 0;
    this.stepEvents = 0;
    this.calls.clear();
    this.wireBytes = 0;
    this.stopTimer();
  }

  socket(open?: OpenProviderWebSocket): OpenProviderWebSocket {
    return async (url) => {
      const ws = open
        ? await open(url)
        : await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url);
            const abort = () => {
              socket.close();
              reject(this.signal.reason);
            };
            this.signal.addEventListener('abort', abort, { once: true });
            socket.addEventListener(
              'open',
              () => {
                this.signal.removeEventListener('abort', abort);
                resolve(socket);
              },
              { once: true },
            );
            socket.addEventListener(
              'error',
              () => {
                this.signal.removeEventListener('abort', abort);
                reject(new TheoremError('unavailable', labelText('error.unavailable')));
              },
              { once: true },
            );
          });
      if (this.signal.aborted) {
        ws.close();
        throwIfAborted(this.signal);
      }
      const abort = () => ws.close();
      this.signal.addEventListener('abort', abort, { once: true });
      ws.addEventListener('close', () => this.signal.removeEventListener('abort', abort), {
        once: true,
      });
      ws.addEventListener('message', (event: MessageEvent) => {
        const data: unknown = event.data;
        const bytes =
          typeof data === 'string'
            ? new TextEncoder().encode(data).byteLength
            : data instanceof Blob
              ? data.size
              : data instanceof ArrayBuffer || ArrayBuffer.isView(data)
                ? data.byteLength
                : 0;
        if (bytes <= this.limits.maxWireRecordBytes) return;
        event.stopImmediatePropagation();
        try {
          this.fail();
        } catch {
          ws.close(1009, 'response limit');
        }
      });
      return ws;
    };
  }

  fetch(upstream: typeof fetch): typeof fetch {
    return async (input, init) => {
      const supplied = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const effective = combinedSignal(supplied ? [this.signal, supplied] : [this.signal]);
      const signal = effective.signal;
      throwIfAborted(signal);
      const response = await upstream(input, { ...init, signal }).catch((error) => {
        effective.dispose();
        throw error;
      });
      throwIfAborted(signal);
      if (!response.body) {
        effective.dispose();
        return response;
      }
      const reader = response.body.getReader();
      let responseBytes = 0;
      const record = response.headers.get('content-type')?.includes('text/event-stream')
        ? new SseRecordBudget(this)
        : undefined;
      const abort = () => {
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            throwIfAborted(signal);
            const next = await reader.read();
            throwIfAborted(signal);
            if (next.done) {
              controller.close();
              signal.removeEventListener('abort', abort);
              effective.dispose();
              reader.releaseLock();
              return;
            }
            responseBytes += next.value.byteLength;
            this.wireBytes += next.value.byteLength;
            if (
              responseBytes > this.limits.maxWireResponseBytes ||
              this.wireBytes > this.limits.maxWireResponseBytes
            )
              this.fail();
            record?.accept(next.value);
            controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            signal.removeEventListener('abort', abort);
            effective.dispose();
            void reader.cancel(error).catch(() => undefined);
          }
        },
        cancel: (reason) => {
          signal.removeEventListener('abort', abort);
          effective.dispose();
          return reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }
}

class SseRecordBudget {
  private recordBytes = 0;
  private lineBytes = 0;
  private previousCR = false;
  private emptyCR = false;
  constructor(private budget: ProviderBudget) {}
  accept(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.emptyCR && byte !== 10) {
        this.recordBytes = 0;
        this.emptyCR = false;
      }
      this.recordBytes++;
      if (this.recordBytes > this.budget.limits.maxWireRecordBytes) this.budget.fail();
      if (this.emptyCR) {
        this.recordBytes = 0;
        this.emptyCR = false;
        this.previousCR = false;
        continue;
      }
      if (byte === 10 && this.previousCR) {
        this.previousCR = false;
        continue;
      }
      if (byte === 10 || byte === 13) {
        if (this.lineBytes === 0) {
          if (byte === 13) this.emptyCR = true;
          else this.recordBytes = 0;
        }
        this.lineBytes = 0;
      } else this.lineBytes++;
      this.previousCR = byte === 13;
    }
  }
}
