const OMIT_INJECTION = '[omitted - injection]';
const OMIT_SENSITIVE = '[omitted -sensitive]';

type RedactKind = 'injection' | 'sensitive';

interface RedactSpan {
  start: number;
  end: number;
  kind: RedactKind;
}

function tokenFor(kind: RedactKind): string {
  if (kind === 'injection') {
    return OMIT_INJECTION;
  }
  return OMIT_SENSITIVE;
}

function blobAt(match: RegExpMatchArray): { blob: string; index: number } | undefined {
  const [blob] = match;
  const { index } = match;
  if (blob && index !== undefined) {
    return { blob, index };
  }
  return undefined;
}

function mergeSpans(spans: RedactSpan[]): RedactSpan[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const out: RedactSpan[] = [];
  for (const span of sorted) {
    if (span.end > span.start) {
      const last = out.at(-1);
      if (!last || span.start >= last.end) {
        out.push(span);
      } else if (span.end > last.end) {
        last.end = span.end;
      }
    }
  }
  return out;
}

function applySpans(text: string, spans: RedactSpan[]): string {
  let out = text;
  const merged = mergeSpans(spans);
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const span = merged[i];
    if (span) {
      out = out.slice(0, span.start) + tokenFor(span.kind) + out.slice(span.end);
    }
  }
  return out;
}

function spansFromPatterns(text: string, patterns: RegExp[], kind: RedactKind): RedactSpan[] {
  const spans: RedactSpan[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const found = blobAt(match);
      if (found) {
        spans.push({ start: found.index, end: found.index + found.blob.length, kind });
      }
    }
  }
  return spans;
}

export type { RedactKind, RedactSpan };
export { applySpans, blobAt, mergeSpans, OMIT_INJECTION, OMIT_SENSITIVE, spansFromPatterns };
