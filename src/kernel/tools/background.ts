import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { SpanHandle, TraceAttributes } from '../../observability/trace-span.ts';
import type { TurnEvent } from '../types.ts';
import { type ToolCallBase, toolEvent } from './events.ts';
import { formatToolResult } from './model-text.ts';
import {
  operationWireValue,
  type ToolExecutionCoordinator,
  type ToolOperationReply,
  toolOperationReplySchema,
} from './operation.ts';
import type { ModelToolResult } from './types.ts';

/** When the model gets its reply: at the hand-off, past a time, if it asks, or when the body ends. */
export type ToolBackground = 'always' | { afterMs: number } | 'ask' | 'never';

const toolBackgroundSchema: z.ZodType<ToolBackground> = z.union([
  z.enum(['always', 'ask', 'never']),
  z.strictObject({ afterMs: z.number().finite().nonnegative() }),
]);

/** The call a detached event belongs to. */
export interface ToolBackgroundCall {
  operationId: string;
  callId: string;
  toolId: string;
}

/** The host's hold on one detached call. */
export interface ToolBackgroundHandle extends ToolBackgroundCall {
  /**
   * Stops the call. It settles as a `cancelled` failure with `reason` as its code, whatever the
   * body does. With no reason this is a shutdown: the call ends `execution_interrupted`. With
   * `graceMs`, a body that ignores its signal past that time settles anyway.
   */
  stop(reason?: string, options?: { graceMs?: number }): void;
  /** Resolves when the call has settled or been marked. */
  done: Promise<void>;
}

/** The host's service for detached calls. Without it every tool runs inline. */
export interface ToolBackgroundService {
  detached(call: ToolBackgroundHandle): void;
  event(event: TurnEvent, call: ToolBackgroundCall): void | Promise<void>;
}

/** A detached call's own trace record, joined to its turn through `traceparent`. */
export interface DetachedToolTrace {
  open: (name: string, attributes: TraceAttributes) => SpanHandle;
  end: () => void | Promise<void>;
}

/** The service with what a request adds: its event projection and where a detached trace goes. */
export interface ToolBackgroundSupport {
  service: ToolBackgroundService;
  project: (event: TurnEvent) => TurnEvent;
  openTrace: (callId: string) => DetachedToolTrace;
}

export interface ToolDetach {
  at: 'claim' | { afterMs: number };
  support: ToolBackgroundSupport;
  trace: DetachedToolTrace;
  reply: () => ToolOperationReply;
}

const FIELD = 'background';

/** The `ask` argument, as the model reads it. */
export function backgroundField() {
  return z.boolean().optional().describe(labelText('tool.background_field'));
}

/** The call's input without `background`, and whether the model asked for it. */
export function splitBackground(
  tool: { background?: ToolBackground } | undefined,
  input: unknown,
): { input: unknown; asked: boolean } {
  if (tool?.background !== 'ask' || typeof input !== 'object' || input === null) {
    return { input, asked: false };
  }
  const { [FIELD]: asked, ...rest } = input as Record<string, unknown>;
  return { input: rest, asked: asked === true };
}

function detachAt(
  tool: { background?: ToolBackground },
  input: unknown,
): ToolDetach['at'] | undefined {
  const { background } = tool;
  if (background === undefined || background === 'never') return undefined;
  if (background === 'always') return 'claim';
  if (background === 'ask') return splitBackground(tool, input).asked ? 'claim' : undefined;
  return background;
}

/** How this call detaches, or `undefined` when it runs inline. */
export function planDetach(args: {
  tool: { background?: ToolBackground; name: string } | undefined;
  input: unknown;
  support: ToolBackgroundSupport | undefined;
  base: ToolCallBase;
  labels: Parameters<typeof labelText>[2];
}): ToolDetach | undefined {
  const { tool, support, base, labels } = args;
  if (!tool || !support) return undefined;
  const at = detachAt(tool, args.input);
  if (at === undefined) return undefined;
  return {
    at,
    support,
    trace: support.openTrace(base.callId),
    reply: () => {
      const modelResult: ModelToolResult = {
        finding: labelText('tool.background_started', { tool: tool.name }, labels),
      };
      const readBack = formatToolResult(modelResult);
      const event = toolEvent(base, { phase: 'background', readBack });
      return toolOperationReplySchema.parse(operationWireValue({ event, replay: { modelResult } }));
    },
  };
}

/** A late result needs a coordinator to keep it. */
export function assertBackgroundCoordinator(
  service: ToolBackgroundService | undefined,
  execution: ToolExecutionCoordinator | undefined,
): void {
  if (service && !execution?.detach) {
    throw new TheoremError(
      'config',
      'A request with a background service needs a coordinator with detach', // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
}

/** A tool that must answer in an open turn cannot detach; only an object input takes `background`. */
export function assertBackgroundSetting(tool: {
  name: string;
  background?: ToolBackground;
  answeredBy?: string;
}): void {
  const { name, background } = tool;
  if (background === undefined || background === 'never') return;
  if (tool.answeredBy === 'page') {
    throw new TheoremError(
      'config',
      `Tool '${name}' sets background, which a tool answered by the page cannot`, // labels-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
    );
  }
  if (toolBackgroundSchema.safeParse(background).success) return;
  throw new TheoremError(
    'config',
    typeof background === 'object'
      ? `Tool '${name}' sets background.afterMs, which must be a time in milliseconds` // labels-exempt: developer contract / internal diagnostic
      : `Tool '${name}' sets background to ${JSON.stringify(background)}; it takes 'always', 'ask', 'never' or { afterMs }`, // labels-exempt: developer contract / internal diagnostic
  );
}
