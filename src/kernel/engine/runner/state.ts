import { type TurnDestinations, turnDestinations } from '../../../guardrails/destinations.ts';
import { type GivenUrlSets, givenUrlSets } from '../../../guardrails/egress-urls.ts';
import type { OwnTools } from '../../../guardrails/tool-leak.ts';
import type { GuardrailHit, TurnTaint } from '../../../guardrails/types.ts';
import type { SpanHandle } from '../../../observability/trace-span.ts';
import type { AgentCaller } from '../../tools/agent.ts';
import { ownToolsOf } from '../../tools/project.ts';
import type { ToolRegistry } from '../../tools/registry.ts';
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
import type { MediaTokenFamily } from '../token-estimate.ts';
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
  trace: TurnTraceState;
  currentHistory: TurnHistoryMessage[];
  stepCount: number;
  /** Model calls sent again this turn under the profile's resumption (`executeResumedStep`). */
  resumes: number;
  /** Media family of the turn's model binding, for estimating unreported usage. */
  mediaFamily: MediaTokenFamily | undefined;
  allEmittedEvents: TurnEvent[];
  attemptEvents: TurnEvent[];
  /**
   * If the mid-stream window tripped but the final verdict on the whole text passes, nothing was
   * streamed, so the attempt gate must release the buffered text rather than drop it.
   */
  withheldVisible?: boolean;
  /** The reply text the stream's gate released this attempt, as it released it. */
  released: string;
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
  providerState?: import('../../provider-contract.ts').ProviderCheckpoint;
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
  trace: TurnTraceState;
  mediaFamily: MediaTokenFamily | undefined;
  allEmittedEvents?: TurnEvent[];
  agents?: AgentCaller;
}): StepExecutionState {
  const { profile, generation } = args;
  const ownTools = ownToolsOf(args.tools, profile);
  const state: StepExecutionState = {
    tools: args.tools,
    trace: args.trace,
    currentHistory: [...(generation.history ?? [])],
    stepCount: 0,
    resumes: 0,
    toolResults: [],
    mediaFamily: args.mediaFamily,
    allEmittedEvents: args.allEmittedEvents ?? [],
    attemptEvents: [],
    released: '',
    givenUrls: givenUrlSets(),
    destinations: turnDestinations(),
    canaryGiven: false,
    canaryScanned: new WeakSet(),
    ...(ownTools ? { ownTools } : {}),
    ...(args.agents ? { agents: args.agents } : {}),
  };
  if (profile.type === 'text') {
    appendUserInput(state, generation.input);
    generation.input = [];
  }
  return state;
}

export type { AttemptFlowState, PendingItemFix, StepExecutionState, TurnTraceState };
export { appendUserInput, openTurnState, recordStepEvent };
