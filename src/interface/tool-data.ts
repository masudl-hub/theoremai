import { profileToolsShowData } from '../kernel/tools/resolve.ts';
import type { ToolCallEvent, ToolOutputPart, ToolPhaseEvent } from '../kernel/turn-events.ts';
import type { Profile, TurnEvent } from '../kernel/types.ts';
import type {
  ComposerProfileInterface,
  ToolCall,
  ToolCallState,
  TranscriptBlock,
} from './types.ts';

/**
 * A call's state as a person may have it when the profile sets `tools.showData: false`: its labels
 * and where it stands stay, what it ran with and what it returned go.
 */
function stateWithoutData(state: ToolCallState): ToolCallState {
  switch (state.phase) {
    case 'running': {
      const { edited: _edited, ...rest } = state;
      return rest;
    }
    case 'complete': {
      const { readBack: _readBack, parts, ...rest } = state;
      const shown = parts?.filter(isShownPart) ?? [];
      return { ...rest, output: null, ...(shown.length > 0 ? { parts: shown } : {}) };
    }
    case 'gate': {
      const { readBack: _readBack, gate, ...rest } = state;
      const { preparedArguments: _prepared, ...shownGate } = gate;
      return { ...rest, gate: shownGate };
    }
    case 'background':
      return { ...state, readBack: '' };
    case 'error': {
      const { readBack: _readBack, ...rest } = state;
      return rest;
    }
    case 'cancel':
      return state;
  }
}

/**
 * A tool call's phase by `stateWithoutData`'s rule, or `undefined` for a phase that is only data
 * (`progress`, `trace`, `draft`): the person is sent nothing for it.
 *
 * invariant: `dispatch` keeps its arguments: the page runs that call, and cannot run it without them.
 */
function phaseWithoutData(phase: ToolPhaseEvent): ToolPhaseEvent | undefined {
  switch (phase.phase) {
    case 'progress':
    case 'trace':
    case 'draft':
      return undefined;
    case 'dispatch':
    case 'warning':
      return phase;
    default:
      return stateWithoutData(phase);
  }
}

/** A part the person is shown: media sent to them, or a reference (only the person sees those). */
function isShownPart(part: ToolOutputPart): boolean {
  if (part.type === 'text') return false;
  return 'uri' in part || ('sent' in part && part.sent === true);
}

function callEventWithoutData(tool: ToolCallEvent): ToolCallEvent | undefined {
  if (tool.phase === undefined) return { ...tool, arguments: {} };
  return phaseWithoutData(tool);
}

/**
 * A turn event as a person reads it when the profile sets `tools.showData: false`, or `undefined`
 * when the event is only a tool's data. Under that setting a request's `arguments` is `{}`, a
 * completed call's `output` is `null`, and a background call's `readBack` is `''`: the interface's
 * `tools.showData` says so, and a page reads it there, not from the empty values.
 */
export function eventWithoutToolData(event: TurnEvent): TurnEvent | undefined {
  switch (event.type) {
    case 'tool': {
      const tool = callEventWithoutData(event.tool);
      return tool ? { ...event, tool } : undefined;
    }
    case 'tool_draft':
    case 'late_results':
      return undefined;
    default:
      return event;
  }
}

function callWithoutData(call: ToolCall): ToolCall {
  const {
    draft: _draft,
    edited: _edited,
    outputDraft: _outputDraft,
    steps: _steps,
    state,
    ...rest
  } = call;
  return { ...rest, arguments: {}, ...(state ? { state: stateWithoutData(state) } : {}) };
}

/**
 * A transcript block as a person reads it when the profile sets `tools.showData: false`, or
 * `undefined` for a block that is only tools' data (`late-results`). By `eventWithoutToolData`'s rule.
 */
export function blockWithoutToolData(block: TranscriptBlock): TranscriptBlock | undefined {
  switch (block.kind) {
    case 'tool':
      return { ...block, tool: callWithoutData(block.tool) };
    case 'late-results':
      return undefined;
    default:
      return block;
  }
}

/** Whether the people in a profile's chat may read a tool call's input and output (`tools.showData`). */
export function profileShowsToolData(profile: Profile): boolean {
  return profileToolsShowData(profile) !== false;
}

/** Whether a profile's interface lets the people in its chat read a tool call's input and output. */
export function interfaceShowsToolData(iface: ComposerProfileInterface): boolean {
  return !('tools' in iface) || iface.tools.showData !== false;
}
