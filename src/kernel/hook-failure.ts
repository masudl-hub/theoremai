import { describeError, errorKind } from '../guardrails/error.ts';
import type { TraceSpan, TraceSpanEvent } from '../observability/trace-schema.ts';
import type { SpanHandle } from '../observability/trace-span.ts';
import type { TurnStage } from './schema.ts';
import type { HookName, ToolFailure, TurnEventOf } from './turn-events.ts';

/** The report of a host hook that threw: the one the host reads, with its copy on the span. */
export function hookFailed(
  hook: HookName,
  err: unknown,
  at: { stage?: TurnStage; callId?: string; span?: SpanHandle | undefined } = {},
): TurnEventOf<'hook_failed'> {
  const { span, ...where } = at;
  const event: TurnEventOf<'hook_failed'> = {
    type: 'hook_failed',
    hook,
    ...where,
    errorKind: errorKind(err),
    errorInternal: describeError(err),
  };
  span?.event('theorem.hook_failed', {
    hook,
    ...(where.stage ? { stage: where.stage } : {}),
    error_kind: event.errorKind,
    reason: event.errorInternal ?? '',
  });
  return event;
}

/** A call a host hook could not approve, start or keep: it fails, and the model reads why. */
export function hookCrashFailure(err: unknown): ToolFailure {
  return { code: 'hook_failed', kind: errorKind(err), message: describeError(err) };
}

/**
 * The crash reports of a call that runs past its turn, on its own trace. Its span ends when the
 * call answers, so a crash after that, such as a failed late save, is kept and added to the span
 * when the record is written.
 */
export function detachedCrashes(root: () => SpanHandle | undefined) {
  const late: TraceSpanEvent[] = [];
  return {
    report(hook: HookName, err: unknown): void {
      const span = root();
      if (!span?.ended) {
        hookFailed(hook, err, { span });
        return;
      }
      const keep: SpanHandle['event'] = (name, attributes = {}, timeUnixNano) => {
        late.push({ name, timeUnixNano: timeUnixNano ?? span.nowUnixNano(), attributes });
      };
      hookFailed(hook, err, { span: { ...span, event: keep } });
    },
    /** The written spans, root first, with the late reports on the root. */
    into(spans: TraceSpan[]): TraceSpan[] {
      spans[0]?.events.push(...late.splice(0));
      return spans;
    },
  };
}
