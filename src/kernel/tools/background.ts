import { z } from 'zod';
import { TheoremError } from '../../guardrails/error.ts';
import { labelText } from '../../guardrails/labels.ts';
import type { SpanHandle, TraceAttributes } from '../../observability/trace-span.ts';
import type { HookName } from '../turn-events.ts';
import type { TurnEvent } from '../types.ts';
import type { AgentCaller } from './agent.ts';
import { type ToolCallBase, toolEvent } from './events.ts';
import { formatToolResult } from './model-text.ts';
import {
  operationWireValue,
  type ToolExecutionCoordinator,
  type ToolOperationReply,
  toolOperationReplySchema,
} from './operation.ts';
import type { ModelToolResult, RegisteredTool } from './types.ts';

/** When the model gets its reply: at the hand-off, past a time, if it asks, or when the body ends. */
export type ToolBackground =
  | 'always'
  | {
      /**
       * Milliseconds the body runs before the model gets its reply. A body that ends sooner answers
       * in the turn.
       */
      afterMs: number;
    }
  | 'ask'
  | 'never';

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
  /**
   * Tells the call's agent `text`, as a user message with `id`. It joins the agent's turn at the
   * next stage that takes an inject, or never if the call settles first.
   */
  steer(text: string, options: { id: string }): ToolSteerReceipt;
  /** Resolves when the call has settled or been marked. */
  done: Promise<ToolBackgroundSettled>;
}

/** Whether a steer waits for the agent's turn, or why it was refused at once. */
export type ToolSteerReceipt =
  | { queued: true }
  | { queued: false; reason: 'settled' | 'stopped' | ToolSteerRefusal };

/** Why a detached call takes no steers at all. */
export type ToolSteerRefusal = 'not_agent' | 'steering_off';

/** How a detached call ended, for its host. */
export interface ToolBackgroundSettled {
  /** Ids of steers that were queued and never landed. */
  unreadSteers: string[];
}

/** The host's service for detached calls. Without it every tool runs inline. */
export interface ToolBackgroundService {
  detached(call: ToolBackgroundHandle): void;
  event(event: TurnEvent, call: ToolBackgroundCall): void | Promise<void>;
}

/** A detached call's own trace record, joined to its turn through `traceparent`. */
export interface DetachedToolTrace {
  open: (name: string, attributes: TraceAttributes) => SpanHandle;
  /** Records a host hook's crash on the call's span, where no turn is left to read it. */
  hookFailed: (hook: HookName, err: unknown) => void;
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
  /** Why the call takes no steers; unset when its agent's turn reads them. */
  refuseSteers?: ToolSteerRefusal;
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

/** Why a detached call of `tool` takes no steers: only an agent whose profile allows injects does. */
function steerRefusal(
  tool: RegisteredTool,
  agents: AgentCaller | undefined,
): ToolSteerRefusal | undefined {
  if (tool.type !== 'agent') return 'not_agent';
  return agents?.takesSteers(tool) ? undefined : 'steering_off';
}

/** How this call detaches, or `undefined` when it runs inline. */
export function planDetach(args: {
  tool: RegisteredTool | undefined;
  input: unknown;
  support: ToolBackgroundSupport | undefined;
  agents: AgentCaller | undefined;
  base: ToolCallBase;
  labels: Parameters<typeof labelText>[2];
}): ToolDetach | undefined {
  const { tool, support, base, labels } = args;
  // why: A builtin runs at the provider, inside the model's call.
  if (!tool || tool.type === 'builtin' || !support) return undefined;
  const at = detachAt(tool, args.input);
  if (at === undefined) return undefined;
  const refuseSteers = steerRefusal(tool, args.agents);
  return {
    at,
    support,
    ...(refuseSteers ? { refuseSteers } : {}),
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
