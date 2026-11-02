import {
  addFencedDestinations,
  addGivenDestinations,
  addResultDestinations,
  type TurnDestinations,
  turnDestinations,
} from '../../../guardrails/destinations.ts';
import { addSeenUrls, type GivenUrlSets, givenUrlSets } from '../../../guardrails/egress-urls.ts';
import { labelText } from '../../../guardrails/labels.ts';
import { isLateResult, readToolData } from '../../../guardrails/tool-fence.ts';
import type { OwnTools } from '../../../guardrails/tool-leak.ts';
import { isRemoteOrigin, recordTaint, wrapToolData } from '../../../guardrails/tool-result.ts';
import type { GuardrailHit, TurnTaint } from '../../../guardrails/types.ts';
import type { SpanHandle } from '../../../observability/trace-span.ts';
import type { AgentCaller } from '../../tools/agent.ts';
import type { ToolBackgroundSupport } from '../../tools/background.ts';
import { originOfTool } from '../../tools/execute.ts';
import type { ToolOperationOutcome } from '../../tools/operation.ts';
import { ownToolsOf } from '../../tools/project.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
import type { MediaRefused } from '../../turn-events.ts';
import type {
  InteractionPart,
  ModelBinding,
  Profile,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnRequest,
  TurnStop,
  TurnToolResult,
} from '../../types.ts';
import type { ItemFailure } from './schema-validation.ts';
import type { CallUsage } from './usage.ts';

interface TurnTraceState {
  /** The turn's `invoke_agent` span; model calls and tools open under it. */
  root: SpanHandle;
  /** Validation / egress attempt the next model call belongs to (0-based). */
  attempt: number;
  calls: number;
  binding: ModelBinding | undefined;
}

interface StepExecutionState {
  /** The turn's scope's tools: calls and provider builtins are looked up here. */
  tools: ToolRegistry;
  /** Runs the turn's agent tools; absent where none can run (a compactor's own turn). */
  agents?: AgentCaller;
  /** Absent where every tool runs inline: a nested turn, or no background service. */
  background?: ToolBackgroundSupport;
  trace: TurnTraceState;
  currentHistory: TurnHistoryMessage[];
  /** Where this turn begins in `currentHistory`: what came before is the conversation the host passed. */
  turnStart: number;
  /** Set by a retry: from then on the model reads this turn only, from `turnStart`. */
  turnOnly?: boolean;
  stepCount: number;
  /** Model calls sent again this turn under the profile's resumption (`executeResumedStep`). */
  resumes: number;
  /** A refused call was sent without its files this turn; a turn tries that once. */
  triedWithoutMedia?: boolean;
  mediaRefused?: MediaRefused;
  allEmittedEvents: TurnEvent[];
  attemptEvents: TurnEvent[];
  /**
   * If the mid-stream window tripped but the final verdict on the whole text passes, nothing was
   * streamed, so the attempt gate must release the buffered text rather than drop it.
   */
  withheldVisible?: boolean;
  /** The reply text the stream's gate released this attempt, as it released it. */
  released: string;
  /**
   * The attempt's reply text as the host has it, across `before_end` re-entries, less any draft an
   * inject dropped (`InjectUnit.released`).
   */
  replyText: string;
  /**
   * The messages in `currentHistory` that hold the model's text of `replyText`, each with where its
   * text begins there: what an inject's drop cuts.
   */
  replyMessages: { message: TurnHistoryMessage; at: number }[];
  /** The canary opening the last provider call ended on, read in front of the next call's reply. */
  canaryCarry?: string;
  /** What the last provider call's thoughts ended on, read in front of the next call's thoughts. */
  thoughtCarry?: string;
  /** System-prompt leaks withheld under a host policy; they pin the end-of-attempt verdict to block. */
  promptLeaks?: GuardrailHit[];
  /** Untrusted content read so far, so a later tool call is judged against all the turn ingested. */
  taint?: TurnTaint;
  /** The destinations the turn has read, by who wrote them, so a tool call's own are judged against them. */
  destinations: TurnDestinations;
  /** Every URL the model has been given this turn (`GuardrailContext.givenUrls`). */
  givenUrls: GivenUrlSets;
  /** The names of the profile's tools and of their parameters (`GuardrailContext.ownTools`). */
  ownTools?: OwnTools;
  /** Set once the model is given the canary this turn (`GuardrailContext.canaryGiven`). */
  canaryGiven: boolean;
  /** What the canary scan already read this turn (`requestGivesCanary`). */
  canaryScanned: WeakSet<object>;
  /** Every tool call the turn completed, for the checks on a reply's items (`ItemCheckTurn`). */
  toolResults: TurnToolResult[];
  /** Last provider stop from a discarded provider `done` event. */
  lastStop?: TurnStop;
  providerState?: import('../../checkpoint.ts').ProviderCheckpoint;
  /** Usage of the last model call; a continuation's prompt estimate extends it. */
  lastCall?: CallUsage;
}

/** A reply waiting on its refused items: the attempt under way is rewriting only those. */
interface PendingItemFix {
  /** The reply the items were refused in; the rewritten ones go back into it. */
  reply: unknown;
  refused: ItemFailure[];
  /** The profile's own structured schema, put back once the rewrite returns. */
  structured: ResolvedGeneration['structured'];
}

interface AttemptFlowState {
  currentAttempt: number;
  currentReq: TurnRequest;
  currentGen: ResolvedGeneration;
  pendingItemFix?: PendingItemFix;
}

function recordStepEvent(event: TurnEvent, state: StepExecutionState): void {
  state.allEmittedEvents.push(event);
  state.attemptEvents.push(event);
}

/** Append user parts to turn history as one user message (plain text stays a string). */
function appendUserInput(state: StepExecutionState, parts: readonly InteractionPart[]): void {
  if (parts.length === 0) return;
  const textOnly = parts.every((p) => p.type === 'text');
  state.currentHistory.push(
    textOnly
      ? { role: 'user', content: parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }
      : { role: 'user', parts: [...parts] },
  );
}

/** Whether this run goes on with a reply that an earlier run began, not with a new message. */
function continuesReply({ continueFrom, input }: TurnRequest): boolean {
  if (continueFrom) return true;
  if (input?.text || input?.attachments?.length || input?.voice?.length) return false;
  return input?.history?.at(-1)?.role === 'tool';
}

/** The reply's part of the history. Late results that opened it stand before its first message. */
function replyTail(history: readonly TurnHistoryMessage[]): readonly TurnHistoryMessage[] {
  let start = history.findLastIndex((message) => message.role === 'user');
  while (start > 0 && isLateResult(history[start - 1] as TurnHistoryMessage)) start -= 1;
  return history.slice(Math.max(start, 0));
}

/**
 * invariant: Taint lasts for the reply that first read the text, and a pause does not end a reply.
 * The run after a pause reads the marks back from the tool results of that reply, in the history the
 * request sent, because compaction can rewrite those results.
 */
function carryReplyReads(state: StepExecutionState, history: readonly TurnHistoryMessage[]): void {
  for (const message of replyTail(history)) {
    if (message.content === undefined) continue;
    if (message.role !== 'tool' && !isLateResult(message)) continue;
    const reads = readToolData(message.content);
    for (const read of reads) {
      state.taint = recordTaint(state.taint, read.provenance, read.suspicious);
      addFencedDestinations(state.destinations, read.text, read.provenance);
    }
    if (reads.length > 0) continue;
    const tool = message.name ? state.tools.get(message.name) : undefined;
    if (tool && !isRemoteOrigin(originOfTool(tool, state.tools))) {
      addGivenDestinations(state.destinations, message.content);
    }
  }
}

/** A late result is read as a tool's result, so its message is no one's word to the model. */
function openLateResults(
  state: StepExecutionState,
  outcomes: readonly ToolOperationOutcome[],
  labels: Profile['labels'],
): void {
  if (outcomes.length === 0) return;
  const blocks = outcomes.map(({ event, replay }) => {
    const { name, readBack = '' } = event.tool;
    const result = replay.modelResult;
    const provenance = result?.provenance ?? { origin: 'local' as const, tool: name, depth: 1 };
    if (result?.provenance) {
      state.taint = recordTaint(state.taint, result.provenance, result.suspicious);
      addResultDestinations(state.destinations, result, result.provenance);
    }
    addSeenUrls(state.givenUrls.tools, readBack);
    const fenced =
      readToolData(readBack).length > 0 ? readBack : wrapToolData(readBack, provenance);
    return `${labelText('tool.late_result', { tool: name }, labels)}\n${fenced}`;
  });
  const message: TurnHistoryMessage = { role: 'user', content: blocks.join('\n\n') };
  state.givenUrls.own.add(message);
  state.currentHistory.push(message);
}

/**
 * Step state for one turn. A text turn's history grows inside the turn (tool
 * steps, stage injects, repair retries), so its opening input moves into turn
 * history here and everything later lands after it; `generation.input` is then
 * empty. Image and speech turns are one call that reads only the input, so
 * theirs stays put.
 */
function openTurnState(args: {
  tools: ToolRegistry;
  profile: Profile;
  generation: ResolvedGeneration;
  /** The request, on the run that opens the turn. */
  request?: TurnRequest;
  trace: TurnTraceState;
  allEmittedEvents?: TurnEvent[];
  agents?: AgentCaller;
  background?: ToolBackgroundSupport;
}): StepExecutionState {
  const { profile, generation } = args;
  const ownTools = ownToolsOf(args.tools, profile);
  const state: StepExecutionState = {
    tools: args.tools,
    trace: args.trace,
    currentHistory: [...(generation.history ?? [])],
    turnStart: generation.history?.length ?? 0,
    stepCount: 0,
    resumes: 0,
    toolResults: [],
    allEmittedEvents: args.allEmittedEvents ?? [],
    attemptEvents: [],
    released: '',
    replyText: '',
    replyMessages: [],
    givenUrls: givenUrlSets(),
    destinations: turnDestinations(),
    canaryGiven: false,
    canaryScanned: new WeakSet(),
    ...(ownTools ? { ownTools } : {}),
    ...(args.agents ? { agents: args.agents } : {}),
    ...(args.background ? { background: args.background } : {}),
  };
  if (profile.type === 'text') {
    if (args.request && continuesReply(args.request)) {
      carryReplyReads(state, args.request.input?.history ?? []);
    }
    openLateResults(state, args.request?.input?.lateResults ?? [], profile.labels);
    appendUserInput(state, generation.input);
    generation.input = [];
  }
  return state;
}

/** The history the next model call reads: this turn alone once a retry has cut it. */
function modelHistory(state: StepExecutionState): TurnHistoryMessage[] {
  return state.turnOnly ? state.currentHistory.slice(state.turnStart) : state.currentHistory;
}

/** Whether the turn's checkpoint covers less than the conversation the host keeps. */
function cutConversation(state: StepExecutionState): boolean {
  return state.turnOnly === true && state.turnStart > 0;
}

export type { AttemptFlowState, PendingItemFix, StepExecutionState, TurnTraceState };
export { appendUserInput, cutConversation, modelHistory, openTurnState, recordStepEvent };
