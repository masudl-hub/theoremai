/** Hands a line on to whoever reads the stream. */
export type SendLine = (line: string) => void;

/**
 * A newline-delimited stream read a line at a time: `each` sees every line and sends on the ones
 * it keeps, and `end` runs after the last.
 */
export function eachLine(
  each: (line: string, send: SendLine) => void,
  end: (send: SendLine) => void = () => {},
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let partial = '';
  const sender = (controller: TransformStreamDefaultController<Uint8Array>): SendLine => (line) =>
    controller.enqueue(encoder.encode(`${line}\n`));
  return new TransformStream({
    transform(chunk, controller) {
      const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line) each(line, sender(controller));
    },
    flush(controller) {
      const rest = partial + decoder.decode();
      if (rest) each(rest, sender(controller));
      end(sender(controller));
    },
  });
}

/** The content type of a run's stream. */
export const NDJSON = 'application/x-ndjson';
