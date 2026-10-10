/**
 * A host call's standing, read from its folded state: the phase it's in, and
 * what to say when it failed.
 *
 * @module
 */

import type { TranscriptBlock } from '@theoremjs/agents/interface';
import type { ClientFailure } from './failure.ts';
import { type JsonSchema, sampleFromSchema } from './schema-fields.ts';
import { json } from './shaped-data.ts';

export type ToolCall = Extract<TranscriptBlock, { kind: 'tool' }>['tool'];

export type HostCallStatus = 'running' | 'gate' | 'complete' | 'error' | 'cancel';

/** What a call's standing reads from. */
export type HostCallState = {
  call: ToolCall | null;
  failure: ClientFailure | null;
  isRunning: boolean;
};

const SETTLED: ReadonlySet<string> = new Set<HostCallStatus>([
  'gate',
  'complete',
  'error',
  'cancel',
]);

/** The phase a call is in; a stream that broke is an error, one that stopped short a cancel. */
export function hostCallStatus({ call, failure, isRunning }: HostCallState): HostCallStatus {
  const phase = call?.state?.phase;
  if (phase !== undefined && SETTLED.has(phase)) return phase as HostCallStatus;
  if (failure) return 'error';
  return isRunning ? 'running' : 'cancel';
}

/** Why a call failed, as a banner reads it: it never reached its tool, or the tool failed. */
export function hostCallFailure({
  call,
  failure,
}: HostCallState): { title: string; description?: string } | null {
  if (failure) return { title: failure.error };
  const state = call?.state;
  if (state?.phase !== 'error') return null;
  const { error, message } = state.failure;
  if (!error) return { title: message };
  return error === message ? { title: error } : { title: error, description: message };
}

/** What the console shows: the picked tool, its request text, its call on show, and the calls before it. */
export type HostConsoleView<Tool, Call> = {
  tool: Tool | undefined;
  text: string;
  shown: Call | null;
  earlier: Call[];
};

/**
 * The console's view of its state. An unknown pick falls back to the first
 * tool; a tool's request is its draft, else a sample of its schema; the call on
 * show is the one opened from history, else the tool's latest.
 */
export function hostConsoleView<
  Tool extends { name: string; inputSchema: JsonSchema },
  Call extends { id: string; name: string },
>(args: {
  tools: readonly Tool[];
  picked: string | undefined;
  drafts: Readonly<Record<string, string>>;
  calls: readonly Call[];
  shownId: string | null;
}): HostConsoleView<Tool, Call> {
  const tool = args.tools.find((candidate) => candidate.name === args.picked) ?? args.tools[0];
  const text = tool ? (args.drafts[tool.name] ?? json(sampleFromSchema(tool.inputSchema))) : '';
  const ofTool = args.calls.filter((call) => call.name === tool?.name);
  const shown = ofTool.find((call) => call.id === args.shownId) ?? ofTool[0] ?? null;
  return { tool, text, shown, earlier: args.calls.filter((call) => call !== shown) };
}
