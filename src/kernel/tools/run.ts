/**
 * A call's end, for a host that wants how a call settled rather than its stream:
 * `runTool` and `runToolStep` run `invokeTool` and `invokeToolStep` and give each
 * call's terminal `tool` event with every event it emitted.
 */

import { labelText } from '../../guardrails/labels.ts';
import type { ToolPhaseEvent, TurnEvent, TurnEventOf } from '../turn-events.ts';
import type { StartedInvoke, StartedStep } from './invoke.ts';

/** The phase a call ends on: it completed, a gate held it, or it failed. */
export type SettledToolCall = Extract<ToolPhaseEvent, { phase: 'complete' | 'gate' | 'error' }> & {
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

function isSettled(tool: TurnEventOf<'tool'>['tool']): tool is SettledToolCall {
  return tool.phase === 'complete' || tool.phase === 'gate' || tool.phase === 'error';
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
async function runTool(started: StartedInvoke): Promise<ToolCallResult> {
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

/** Run a step's calls, yielding each one's result as it settles; a call the step never settled comes last. */
async function* runToolStep(started: StartedStep): AsyncGenerator<ToolStepCallResult> {
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

export { runTool, runToolStep };
