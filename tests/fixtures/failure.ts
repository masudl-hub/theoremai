import type { ErrorKind } from '../../src/guardrails/theorem-error.ts';

/** The error event a call or turn ended with, read as the kind and message it carries. */
export function failureOf(events: readonly { type: string }[]): {
  kind: ErrorKind;
  message: string;
} {
  const failed = events.find((event) => event.type === 'error') as
    | { errorKind?: ErrorKind; error?: string }
    | undefined;
  if (!failed?.errorKind) throw new Error(`no error event in ${events.map((e) => e.type)}`);
  return { kind: failed.errorKind, message: failed.error ?? '' };
}
