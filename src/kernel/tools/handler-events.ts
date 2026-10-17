import type { ToolBoundary } from '../../guardrails/boundaries.ts';
import {
  createDraftGate,
  DraftReader,
  type ProgressiveYieldGate,
} from '../../guardrails/progressive-yield.ts';
import { guardShownValue, guardToolResult } from '../../guardrails/tool-result.ts';
import type { Provenance, ResolvedGuardrailPolicy } from '../../guardrails/types.ts';
import type { TurnEvent } from '../types.ts';
import { type ToolCallBase, toolEvent } from './events.ts';
import type { ToolStreamEvent } from './types.ts';

/** A handler's event as the tool phase it is, unchecked. */
export function* yieldHandlerSideEvent(
  base: ToolCallBase,
  event: Exclude<ToolStreamEvent, { kind: 'complete' }>,
): Generator<TurnEvent> {
  if (event.kind === 'progress') {
    yield toolEvent(base, { phase: 'progress', data: event.data });
  } else if (event.kind === 'draft') {
    yield toolEvent(base, { phase: 'draft', text: event.text });
  } else if (event.kind === 'trace') {
    yield toolEvent(base, { phase: 'trace', step: event.step });
  } else if (event.kind === 'artifact') {
    yield toolEvent(base, { phase: 'artifact', artifact: event.artifact });
  } else if (event.kind === 'warning') {
    yield toolEvent(base, { phase: 'warning', warning: event.warning });
  }
}

/** What a handler's events are read against: what its output is read against at the end. */
export interface HandlerEventChecks {
  profileId: string;
  provenance: Provenance;
  policy: ResolvedGuardrailPolicy;
  /** `tool_output_<kind>`. */
  boundary: ToolBoundary;
  /** `tool_shown_<kind>`: what its artifacts and trace are read at. */
  shown: ToolBoundary;
  callableTools: readonly string[];
  /** Whether the host sees the handler's drafts (`outputs.streaming.mode` `sse`). */
  drafts: boolean;
}

/**
 * A handler's events before its output, as the host may see them; an HTTP tool's body as it arrives
 * comes through here as drafts too. Its `progress` is read whole at
 * the output's boundary: one a check stops is not sent, and its guardrail event is. Its drafts are
 * read piece by piece there, as one text: a match stops the rest of them, and the output's own
 * check reports it.
 */
export class HandlerEvents {
  private readonly drafts: DraftReader | undefined;

  constructor(
    private readonly base: ToolCallBase,
    private readonly checks: HandlerEventChecks | undefined,
  ) {
    if (checks?.drafts) this.drafts = new DraftReader(() => draftGate(checks));
  }

  async *show(event: Exclude<ToolStreamEvent, { kind: 'complete' }>): AsyncGenerator<TurnEvent> {
    if (event.kind === 'draft') {
      yield* this.draft(event.text);
      return;
    }
    if (event.kind === 'progress' && (yield* this.progressStops(event.data))) return;
    if (event.kind === 'artifact') {
      const artifact = yield* this.shown(event.artifact);
      if (artifact.shown)
        yield* yieldHandlerSideEvent(this.base, { ...event, artifact: artifact.value });
      return;
    }
    if (event.kind === 'trace') {
      const step = yield* this.shown(event.step);
      if (step.shown) {
        yield* yieldHandlerSideEvent(this.base, {
          ...event,
          step: step.value as typeof event.step,
        });
      }
      return;
    }
    yield* yieldHandlerSideEvent(this.base, event);
  }

  /** The drafts' tail the gate still holds, once the handler has returned. */
  *end(): Generator<TurnEvent> {
    const text = this.drafts?.end();
    if (text) yield toolEvent(this.base, { phase: 'draft', text });
  }

  private async *draft(piece: string): AsyncGenerator<TurnEvent> {
    const text = await this.drafts?.read(piece);
    if (text) yield toolEvent(this.base, { phase: 'draft', text });
  }

  /** `value` as the person is shown it, read at `tool_shown_<kind>`; one a match blocks is not sent. */
  private *shown(value: unknown): Generator<TurnEvent, { shown: boolean; value?: unknown }> {
    const checks = this.checks;
    if (!checks) return { shown: true, value };
    const read = guardShownValue(value, checks.provenance, checks.policy, checks.shown);
    if (read.event) yield { type: 'guardrail', guardrail: read.event };
    return 'value' in read ? { shown: true, value: read.value } : { shown: false };
  }

  /** Whether a check at the output's boundary stops `data`; a flag lets it through unreported. */
  private *progressStops(data: unknown): Generator<TurnEvent, boolean> {
    const checks = this.checks;
    if (!checks) return false;
    const { event, text } = guardToolResult(
      '',
      data,
      checks.provenance,
      checks.policy,
      checks.boundary,
      checks.callableTools,
    );
    if (text !== undefined && (event === undefined || event.action === 'flag')) return false;
    if (event) yield { type: 'guardrail', guardrail: event };
    return true;
  }
}

/** The gate a handler's drafts are read through, at the output's boundary. */
function draftGate(checks: HandlerEventChecks): Promise<ProgressiveYieldGate | null> {
  return createDraftGate(
    checks.policy,
    {
      stage: 'tool_result',
      trust: 'untrusted',
      profileId: checks.profileId,
      provenance: checks.provenance,
    },
    checks.boundary,
    { callable: checks.callableTools },
  );
}
