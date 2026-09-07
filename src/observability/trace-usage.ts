import { asRecord } from '../kernel/engine/record.ts';
import type { TurnEvent, TurnTokens } from '../kernel/types.ts';

function eventName(row: Record<string, unknown>): string {
  return String(row.event_type ?? row.eventType ?? '');
}

function upstreamRows(upstream: unknown): Record<string, unknown>[] {
  if (!Array.isArray(upstream)) {
    return [];
  }
  return upstream
    .map((item) => asRecord(item))
    .filter((row): row is Record<string, unknown> => row != null);
}

function lastUpstreamRow(
  upstream: unknown,
  pred: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const rows = upstreamRows(upstream);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (pred(rows[i])) {
      return rows[i];
    }
  }
  return undefined;
}

function firstUpstreamRow(
  upstream: unknown,
  pred: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const row of upstreamRows(upstream)) {
    if (pred(row)) {
      return row;
    }
  }
  return undefined;
}

function completedInteraction(upstream: unknown): Record<string, unknown> | undefined {
  const row = lastUpstreamRow(upstream, (r) => {
    const name = eventName(r);
    return name === 'interaction.completed' || name === 'interaction.complete';
  });
  return row ? (asRecord(row.interaction) ?? row) : undefined;
}

/** Extract the terminal stop kind from the TurnEvent stream (protocol-agnostic). */
function stopKindFromEvents(events: TurnEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type === 'done' && ev.stop) {
      return ev.stop.kind;
    }
  }
  return undefined;
}

/** Extract the last tokens snapshot from the TurnEvent stream. */
function tokensFromEvents(events: TurnEvent[]): TurnTokens | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type === 'tokens' && ev.tokens) {
      return ev.tokens;
    }
  }
  return undefined;
}

/** Extract finish_reason from OpenAI-compat upstream tap rows. */
function openAiFinishReason(upstream: unknown): string | undefined {
  const row = lastUpstreamRow(upstream, (r) => {
    const choices = r.choices;
    if (!Array.isArray(choices)) {
      return false;
    }
    return choices.some((choice) => asRecord(choice)?.finish_reason != null);
  });
  if (!row) {
    return undefined;
  }
  const choices = row.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  for (const choice of choices) {
    const c = asRecord(choice);
    if (c?.finish_reason != null) {
      return String(c.finish_reason);
    }
  }
  return undefined;
}

function httpStatus(upstream: unknown): unknown {
  const row = firstUpstreamRow(upstream, (r) => eventName(r) === 'http_response');
  return row?.status;
}

export {
  completedInteraction,
  httpStatus,
  openAiFinishReason,
  stopKindFromEvents,
  tokensFromEvents,
};
