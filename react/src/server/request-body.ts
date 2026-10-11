import { lexiconText, TheoremError, throwIfAborted } from '@theoremjs/agents';

const DEFAULT_REQUEST_BYTES = 16 * 1024 * 1024;

export function requestByteLimit(bytes = DEFAULT_REQUEST_BYTES): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new TheoremError('config', lexiconText('error.config'));
  }
  return bytes;
}

export async function boundedRequestJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maxBytes || !request.body) {
    throw new TheoremError('request', lexiconText('error.request'));
  }
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel(request.signal.reason).catch(() => undefined);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  const text: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      throwIfAborted(request.signal);
      const next = await reader.read();
      throwIfAborted(request.signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new TheoremError('request', lexiconText('error.request'));
      if (next.value.byteLength) text.push(decoder.decode(next.value, { stream: true }));
    }
    text.push(decoder.decode());
    return JSON.parse(text.join(''));
  } finally {
    request.signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
