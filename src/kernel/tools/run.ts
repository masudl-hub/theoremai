/**
 * A call's end, for a host that wants how a call settled rather than its stream:
 * `settledCall` and `settledCalls` read a started `invokeTool` or `invokeToolStep` and give each
 * call's terminal `tool` event with every event it emitted. `runTool` and `runToolStep` use them.
 */

import { labelText } from '../../guardrails/labels.ts';
import type { ToolPhaseEvent, TurnEvent, TurnEventOf } from '../turn-events.ts';
import type { StartedInvoke, StartedStep } from './invoke.ts';
import type { InvokeToolStepRequest } from './types.ts';

/** The phase a call ends on: it completed, a gate held it, it failed, or it went on in the background. */
export type SettledToolCall = Extract<
  ToolPhaseEvent,
  { phase: 'complete' | 'gate' | 'error' | 'background' }
> & {
  /** Kernel-issued identity; a gate's resume carries it. */
  operationId?: string;
};

/** A settled call, every event it emitted in order, and the last activity label it ran under. */
export type ToolCallResult = SettledToolCall & {
  events: TurnEvent[];
  activity?: string;
};

/** A step's call, settled: its place in the step's `calls` beside its result. */
export type ToolStepCallResult = ToolCallResult & { index: number };

/** A step `runToolStep` runs, and what the host hears while it runs. */
export interface RunToolStepRequest extends InvokeToolStepRequest {
  /**
   * Your function that is given each of the step's events as it arrives, before the call it
   * belongs to settles, such as a call's progress. Left out, you get only each call's end. A throw
   * fails the step, as a throw from the invoke does.
   *
   * @remarks Called for every event the step emits, in order, before `runToolStep` yields the
   * call that event settles.
   */
  onEvent?: (event: TurnEvent) => void;
}

function isSettled(tool: TurnEventOf<'tool'>['tool']): tool is SettledToolCall {
  return (
    tool.phase === 'complete' ||
    tool.phase === 'gate' ||
    tool.phase === 'error' ||
    tool.phase === 'background'
  );
}

/** One call's end as its events arrive. */
interface CallFold {
  name: string;
  callId: string;
  settled?: SettledToolCall;
  activity?: string;
  events: TurnEvent[];
}

function foldTool(fold: CallFold, tool: TurnEventOf<'tool'>['tool']): void {
  if (tool.phase === 'running') fold.activity = tool.activity ?? fold.activity;
  if (isSettled(tool)) fold.settled = tool;
}

/** The call's result; a call that never settled failed as the invoke's own error says, else as not run. */
function settle(fold: CallFold, invokeError: TurnEventOf<'error'> | undefined): ToolCallResult {
  const settled: SettledToolCall = fold.settled ?? {
    phase: 'error',
    name: fold.name,
    callId: fold.callId,
    at: Date.now(),
    failure: {
      code: 'invoke_failed',
      kind: invokeError?.errorKind ?? 'internal',
      message:
        invokeError?.errorInternal ??
        invokeError?.error ??
        labelText('tool.did_not_run', { tool: fold.name }),
    },
  };
  return {
    ...settled,
    events: fold.events,
    ...(fold.activity ? { activity: fold.activity } : {}),
  };
}

/** Run one call to its end. */
async function settledCall(started: StartedInvoke): Promise<ToolCallResult> {
  const fold: CallFold = {
    name: started.name,
    callId: started.callId,
    events: [],
  };
  let invokeError: TurnEventOf<'error'> | undefined;
  for await (const event of started.events) {
    fold.events.push(event);
    if (event.type === 'error') invokeError = event;
    if (event.type === 'tool' && event.tool.callId === started.callId) {
      foldTool(fold, event.tool);
    }
  }
  return settle(fold, invokeError);
}

/**
 * Run a step's calls, yielding each one's result as it settles; a call the step never settled comes
 * last. `onEvent` hears each event first.
 */
async function* settledCalls(
  started: StartedStep,
  onEvent?: (event: TurnEvent) => void,
): AsyncGenerator<ToolStepCallResult> {
  const folds = started.calls.map(
    ({ name, callId }): CallFold => ({
      name,
      callId,
      events: [],
    }),
  );
  const byCallId = new Map(started.calls.map(({ callId }, index) => [callId, index]));
  const yielded = new Set<number>();
  let invokeError: TurnEventOf<'error'> | undefined;
  for await (const event of started.events) {
    onEvent?.(event);
    if (event.type === 'error') invokeError = event;
    if (event.type !== 'tool') continue;
    const index = byCallId.get(event.tool.callId);
    const fold = index === undefined ? undefined : folds[index];
    if (index === undefined || !fold) continue;
    fold.events.push(event);
    foldTool(fold, event.tool);
    if (fold.settled && !yielded.has(index)) {
      yielded.add(index);
      yield { ...settle(fold, invokeError), index };
    }
  }
  for (const [index, fold] of folds.entries()) {
    if (!yielded.has(index)) yield { ...settle(fold, invokeError), index };
  }
}

export { settledCall, settledCalls };
