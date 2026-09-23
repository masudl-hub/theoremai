/**
 * A WebSocket stand-in for Gemini Live: completes setup and accepts scripted
 * server frames.
 */
class MockLiveWebSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
    if (data.includes('"setup"')) {
      queueMicrotask(() => {
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ setupComplete: true }) }),
        );
      });
    }
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason }));
    this.dispatchEvent(new CloseEvent('close', { code, reason }));
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.dispatchEvent(new Event('open'));
  }

  deliver(payload: unknown): void {
    const data = JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

export { MockLiveWebSocket };
