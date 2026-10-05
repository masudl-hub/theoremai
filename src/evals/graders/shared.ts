import type { TraceAttributeValue, TraceSpan } from '../../observability/trace-span.ts';
import type { EvalGrader, EvalResult, Trial } from '../types.ts';

function passFail(name: string, passed: boolean, explanation: string): EvalResult {
  return {
    name,
    source: 'code',
    score: { value: passed ? 1 : 0, label: passed ? 'pass' : 'fail' },
    explanation,
    passed,
  };
}

function codeGrader(
  name: string,
  identity: string,
  needsExpect: boolean,
  grade: (trial: Trial) => EvalResult | Promise<EvalResult>,
): EvalGrader {
  return {
    name,
    identity,
    source: 'code',
    needsExpect,
    grade,
  };
}

function isObject(value: unknown): value is Record<string, TraceAttributeValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deliveredParts(trial: Trial): Record<string, TraceAttributeValue>[] {
  return trial.delivered().flatMap((message) => {
    const parts = message.parts;
    return Array.isArray(parts) ? parts.filter(isObject) : [];
  });
}

// why: Interim transcripts are skipped; the final one holds the whole.
function deliveredText(trial: Trial, source: string | undefined): string {
  return deliveredParts(trial)
    .filter(
      (part) =>
        part.type === 'text' &&
        part['theorem.source'] === source &&
        part['theorem.interim'] !== true,
    )
    .map((part) => trial.text(part) ?? '')
    .join('');
}

function deliveredJson(trial: Trial): unknown {
  const structured = deliveredParts(trial).find((part) => part.type === 'structured');
  const text = structured ? trial.text(structured.content) : deliveredText(trial, undefined);
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function startOf(span: TraceSpan): bigint {
  return BigInt(span.startTimeUnixNano ?? '0');
}

function modelCalls(trial: Trial): TraceSpan[] {
  return [...trial.spans('chat'), ...trial.spans('generate_content')].toSorted((a, b) =>
    Number(startOf(a) - startOf(b)),
  );
}

const NANOS_PER_MS = 1_000_000;

function spanDurationMs(span: TraceSpan): number {
  return Number(
    (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / BigInt(NANOS_PER_MS),
  );
}

function listOf(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

export {
  codeGrader,
  deliveredJson,
  deliveredText,
  listOf,
  modelCalls,
  passFail,
  spanDurationMs,
  startOf,
};
