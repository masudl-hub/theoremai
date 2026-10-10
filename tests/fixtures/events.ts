import { applyToolEvent, toolCallsOf } from '../../src/interface/tool-calls.ts';
import type { ToolCall, ToolCallState } from '../../src/interface/types.ts';
import type { TurnStop } from '../../src/kernel/stop.ts';
import {
  type ToolCallBase,
  type ToolPhasePatch,
  toolCallRequestEvent,
  toolEvent,
} from '../../src/kernel/tools/events.ts';
import type {
  GuardrailEvent,
  SessionEventKind,
  SessionEventOf,
  ToolCallPhase,
  ToolCallRequest,
  TurnEventOf,
  TurnToolSnapshot,
} from '../../src/kernel/turn-events.ts';
import type {
  ProviderEvent,
  ToolCallEvent,
  ToolFailure,
  ToolGate,
  TurnEvent,
} from '../../src/kernel/types.ts';

export type Typed = { type: string };
export type Of<E extends Typed, K extends E['type']> = Extract<E, { type: K }>;

function isOf<E extends Typed, K extends E['type']>(event: E, type: K): event is Of<E, K> {
  return event.type === type;
}

export function eventsOf<E extends Typed, K extends E['type']>(
  events: readonly E[],
  type: K,
): Of<E, K>[] {
  return events.filter((event): event is Of<E, K> => isOf(event, type));
}

export function firstOf<E extends Typed, K extends E['type']>(
  events: readonly E[],
  type: K,
): Of<E, K> | undefined {
  return events.find((event): event is Of<E, K> => isOf(event, type));
}

export function lastOf<E extends Typed, K extends E['type']>(
  events: readonly E[],
  type: K,
): Of<E, K> | undefined {
  return events.findLast((event): event is Of<E, K> => isOf(event, type));
}

/** The event at `index` (negative counts from the end), if it is of `type`. */
export function eventAt<E extends Typed, K extends E['type']>(
  events: readonly E[],
  index: number,
  type: K,
): Of<E, K> | undefined {
  const event = events.at(index);
  return event !== undefined && isOf(event, type) ? event : undefined;
}

export function citedUris(events: readonly Typed[]): string[] {
  return events.flatMap((event) =>
    isCitation(event) ? event.sources.map((source) => source.uri) : [],
  );
}

function isCitation(event: Typed): event is TurnEventOf<'citation'> {
  return event.type === 'citation';
}

export type SessionOf<K extends SessionEventKind> = TurnEventOf<'session'> & {
  session: SessionEventOf<K>;
};

function isSessionOf<K extends SessionEventKind>(event: TurnEvent, kind: K): event is SessionOf<K> {
  return event.type === 'session' && event.session.kind === kind;
}

/** The first session signal of one kind, with the event that carried it. */
export function sessionEventOf<K extends SessionEventKind>(
  events: readonly TurnEvent[],
  kind: K,
): SessionOf<K> | undefined {
  return events.find((event): event is SessionOf<K> => isSessionOf(event, kind));
}

export function guardrailAt(
  events: readonly TurnEvent[],
  stage: GuardrailEvent['stage'],
): GuardrailEvent | undefined {
  return eventsOf(events, 'guardrail').find((event) => event.guardrail.stage === stage)?.guardrail;
}

/** How the turn ended: its `done`'s stop (post-turn stage events may follow it). */
export function finalStop(events: readonly TurnEvent[]): TurnStop | undefined {
  return lastOf(events, 'done')?.stop;
}

export type PhaseOf<P extends ToolCallPhase> = Extract<ToolCallEvent, { phase: P }>;

function isPhase<P extends ToolCallPhase>(tool: ToolCallEvent, phase: P): tool is PhaseOf<P> {
  return tool.phase === phase;
}

/** Every tool event of one phase, across calls, in order (host or provider stream). */
export function toolEventsOf<P extends ToolCallPhase>(
  events: readonly (TurnEvent | ProviderEvent)[],
  phase: P,
): PhaseOf<P>[] {
  return events.flatMap((event) =>
    event.type === 'tool' && isPhase(event.tool, phase) ? [event.tool] : [],
  );
}

export function lastTool(events: readonly TurnEvent[], name: string): ToolCallState | undefined {
  return toolCallsOf(events).findLast((call) => call.name === name)?.state;
}

export function failureOf(state: ToolCallState | undefined): ToolFailure | undefined {
  return state?.phase === 'error' ? state.failure : undefined;
}

export function gateOf(state: ToolCallState | undefined): ToolGate | undefined {
  return state?.phase === 'gate' ? state.gate : undefined;
}

export function outputOf(state: ToolCallState | undefined): unknown {
  return state?.phase === 'complete' ? state.output : undefined;
}

/** Every raw call the model made, in order (host or provider stream). */
export function rawCallsOf(events: readonly (TurnEvent | ProviderEvent)[]): ToolCallRequest[] {
  return events.flatMap((event) =>
    event.type === 'tool' && event.tool.phase === undefined ? [event.tool] : [],
  );
}

export function toolPhases(events: readonly TurnEvent[], name: string): string[] {
  return events.flatMap((event) =>
    event.type === 'tool' && event.tool.name === name && event.tool.phase !== undefined
      ? [event.tool.phase]
      : [],
  );
}

/** One call's events: the model's raw call, then each phase through the kernel's constructor. */
export function callEvents(
  base: ToolCallBase,
  args: Record<string, unknown>,
  ...phases: ToolPhasePatch[]
): TurnEventOf<'tool'>[] {
  return [toolCallRequestEvent(base, args), ...phases.map((phase) => toolEvent(base, phase))];
}

/** One call as the transcript holds it: `callEvents` folded through the interface's own join. */
export function foldedCall(
  base: ToolCallBase,
  args: Record<string, unknown>,
  ...phases: ToolPhasePatch[]
): ToolCall {
  let call: ToolCall | undefined;
  for (const { tool } of callEvents(base, args, ...phases)) call = applyToolEvent(call, tool);
  if (!call) throw new Error('a call always has its raw event');
  return call;
}

/** A turn's tool snapshot where `tools` are eligible, visible and executable. */
export function toolSnapshot(...tools: string[]): TurnToolSnapshot {
  return { builtins: [], gated: tools, visible: tools, executable: tools, wire: [] };
}
