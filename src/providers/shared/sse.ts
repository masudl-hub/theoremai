const DATA_PREFIX = 'data: ';
const EVENT_PREFIX = 'event: ';
const DONE = '[DONE]';

export function asObject(parsed: unknown): Record<string, unknown> | undefined {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

export function dataRecord(raw: string, sseEvent: string): Record<string, unknown> {
  const data = raw.slice(DATA_PREFIX.length).trim();
  const row: Record<string, unknown> = {};
  if (sseEvent) {
    row.sseEvent = sseEvent;
  }
  if (!data || data === DONE) {
    row.eventType = 'sse_done';
    return row;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    const obj = asObject(parsed);
    if (obj) {
      return { ...obj, ...row };
    }
    row.eventType = 'sse_unparsed';
    row.data = parsed;
    return row;
  } catch {
    row.eventType = 'sse_unparsed';
    row.data = data;
    return row;
  }
}

export function takeSsePayloads(
  buffer: string,
  pendingEvent = '',
): { rest: string; payloads: Record<string, unknown>[]; pendingEvent: string } {
  const payloads: Record<string, unknown>[] = [];
  const chunks = buffer.split('\n');
  const rest = chunks.pop() ?? '';
  let sseEvent = pendingEvent;
  for (const line of chunks) {
    if (line.startsWith(EVENT_PREFIX)) {
      sseEvent = line.slice(EVENT_PREFIX.length).trim();
    } else if (line.startsWith(DATA_PREFIX)) {
      payloads.push(dataRecord(line, sseEvent));
      sseEvent = '';
    }
  }
  return { rest, payloads, pendingEvent: sseEvent };
}

/**
 * Async SSE stream chunk reader built on `takeSsePayloads`.
 * Yields every raw payload record (including `sse_done` and `sse_unparsed`).
 */
export async function* readSseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingEvent = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const result = takeSsePayloads(buffer, pendingEvent);
    buffer = result.rest;
    pendingEvent = result.pendingEvent;
    for (const payload of result.payloads) {
      yield payload;
    }
  }
}

/**
 * Generic async SSE stream parser built on `readSseChunks`.
 * Yields parsed JSON objects from `data:` lines; silently skips malformed
 * payloads and terminates on `[DONE]`.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const payload of readSseChunks(body)) {
    if (payload.eventType === 'sse_done') return;
    if (payload.eventType === 'sse_unparsed') continue;
    yield payload;
  }
}
