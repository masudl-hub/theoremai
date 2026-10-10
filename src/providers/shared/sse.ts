const DONE = '[DONE]';

function asObject(parsed: unknown): Record<string, unknown> | undefined {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function dataRecord(raw: string, sseEvent: string): Record<string, unknown> {
  const data = raw.startsWith('data:') ? raw.slice(5).replace(/^ /, '') : raw;
  const row: Record<string, unknown> = {};
  if (sseEvent) {
    row.sseEvent = sseEvent;
  }
  if (data === DONE) {
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
  let event = pendingEvent;
  let data: string[] = [];
  let hasData = false;
  let consumed = 0;
  const lineEnds = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = lineEnds.exec(buffer); match; match = lineEnds.exec(buffer)) {
    if (match[0] === '\r' && match.index === buffer.length - 1) break;
    const line = buffer.slice(start, match.index);
    start = match.index + match[0].length;
    if (!line) {
      if (hasData) payloads.push(dataRecord(data.join('\n'), event));
      event = '';
      data = [];
      hasData = false;
      consumed = start;
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') {
        data.push(value);
        hasData = true;
      }
    }
  }
  return { rest: buffer.slice(consumed), payloads, pendingEvent: '' };
}

export async function* readSseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const result = takeSsePayloads(buffer);
      buffer = result.rest;
      for (const payload of result.payloads) yield payload;
    }
  } finally {
    if (!ended) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Silently skips malformed payloads, unlike `readSseChunks`. */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const payload of readSseChunks(body)) {
    if (payload.eventType === 'sse_done') return;
    if (payload.eventType === 'sse_unparsed') continue;
    yield payload;
  }
}
