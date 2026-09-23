/**
 * One `tokens` event per model call.
 *
 * The runner holds the provider's usage while the call streams and emits one
 * event when it ends. A side the provider did not report (`estimated`) is
 * filled with the token estimator's count; a call with no usage at all is
 * estimated whole. A call that failed with no usage emits nothing: what was
 * billed is unknown, and an estimate would claim a completed read.
 *
 * Prompt estimate: the system prompt, wire tool declarations, and structured
 * output schema the call sends, plus the conversation the model reads — turn
 * history and opening input. An Interactions continuation step
 * (`previous_interaction_id`) sends only its tool results and stage injects,
 * but the model reads the stored interaction too, so its conversation is the
 * previous call's conversation, that call's replayed output (text, tool
 * calls, media — not thoughts), and the continuation messages. A Live
 * response reads the session the provider holds (`held`, counted as each
 * earlier response ended; see `heldAfter`) plus what was sent for it.
 *
 * Output estimate: streamed text (a structured result is parsed from it, so it
 * is not counted twice), thought text, and tool-call names and arguments.
 * Reasoning the provider does not stream (`summaries: 'none'`) cannot be
 * counted. Media no verified rule counts is reported per side in
 * `unknownMedia`; output media always is.
 *
 * @module
 */

import { getStructured } from '../../registry/schemas.ts';
import type {
  InteractionPart,
  ResolvedGeneration,
  TurnEvent,
  TurnHistoryMessage,
  TurnTokens,
} from '../../types.ts';
import { loadTokenEstimator, type MediaTokenFamily, type TokenCount } from '../token-estimate.ts';

/** What a call's model reads beyond the system prompt, tools, and schema. */
type CallConversation =
  | { history: TurnHistoryMessage[]; input: InteractionPart[] }
  | { previous: CallUsage; continuation: TurnHistoryMessage[] };

/** Usage observed across one model call. */
interface CallUsage {
  system: string;
  /** Copied before the stream: the runner mutates history as tools run. */
  conversation: CallConversation;
  /** Context the provider already holds from earlier calls (a Live session). */
  held?: TokenCount;
  /** Last usage the provider reported for this call. */
  reported?: TurnTokens;
  /** Output events the estimate counts. */
  output: TurnEvent[];
  failed: boolean;
}

function startCallUsage(
  system: string,
  conversation: CallConversation,
  held?: TokenCount,
): CallUsage {
  return {
    system,
    ...(held ? { held } : {}),
    conversation:
      'previous' in conversation
        ? { previous: conversation.previous, continuation: [...conversation.continuation] }
        : { history: [...conversation.history], input: [...conversation.input] },
    output: [],
    failed: false,
  };
}

/**
 * Record one provider event. Returns true for a `tokens` event, which the
 * runner holds instead of streaming; `callTokensEvent` emits it at call end.
 */
function observeCallEvent(usage: CallUsage, event: TurnEvent): boolean {
  switch (event.type) {
    case 'tokens':
      if (event.tokens) usage.reported = event.tokens;
      return true;
    case 'error':
      usage.failed = true;
      return false;
    case 'text':
    case 'thought':
    case 'tool':
    case 'media':
      usage.output.push(event);
      return false;
    default:
      return false;
  }
}

function addCounts(a: TokenCount, b: TokenCount): TokenCount {
  return { tokens: a.tokens + b.tokens, unknownMedia: a.unknownMedia + b.unknownMedia };
}

/** Output events counted; thoughts only when counting what the model wrote. */
async function countOutput(usage: CallUsage, thoughts: boolean): Promise<TokenCount> {
  const estimator = await loadTokenEstimator();
  const count: TokenCount = { tokens: 0, unknownMedia: 0 };
  for (const event of usage.output) {
    if (event.type === 'media') {
      count.unknownMedia += 1;
    } else if (event.type === 'tool' && event.tool) {
      count.tokens +=
        estimator.text(event.tool.name) +
        estimator.text(JSON.stringify(event.tool.arguments ?? {}));
    } else if (event.text && (thoughts || event.type !== 'thought')) {
      count.tokens += estimator.text(event.text);
    }
  }
  return count;
}

async function countConversation(
  usage: CallUsage,
  family: MediaTokenFamily | undefined,
): Promise<TokenCount> {
  const estimator = await loadTokenEstimator();
  const { conversation } = usage;
  if ('previous' in conversation) {
    const earlier = await countConversation(conversation.previous, family);
    const replayed = await countOutput(conversation.previous, false);
    const continuation = await estimator.messages(conversation.continuation, family);
    return addCounts(addCounts(earlier, replayed), continuation);
  }
  const history = await estimator.messages(conversation.history, family);
  const sent = addCounts(history, await estimator.parts(conversation.input, family));
  return usage.held ? addCounts(usage.held, sent) : sent;
}

/**
 * What the provider holds once `usage`'s call has ended: what it held before,
 * what was sent for the call, and the call's output (not thoughts), counted
 * as a continuation replays it.
 */
async function heldAfter(
  usage: CallUsage,
  family: MediaTokenFamily | undefined,
): Promise<TokenCount> {
  return addCounts(await countConversation(usage, family), await countOutput(usage, false));
}

async function countPrompt(
  usage: CallUsage,
  generation: ResolvedGeneration,
  family: MediaTokenFamily | undefined,
): Promise<TokenCount> {
  const estimator = await loadTokenEstimator();
  const wire = generation.tools.wire;
  const tools = wire.length > 0 ? estimator.text(JSON.stringify(wire)) : 0;
  const jsonSchema = generation.structured
    ? getStructured(generation.structured).jsonSchema
    : undefined;
  const schema = jsonSchema ? estimator.text(JSON.stringify(jsonSchema)) : 0;
  const conversation = await countConversation(usage, family);
  return {
    tokens: estimator.text(usage.system) + tools + schema + conversation.tokens,
    unknownMedia: conversation.unknownMedia,
  };
}

/** The call's one `tokens` event, or `undefined` when it failed with no usage. */
async function callTokensEvent(
  usage: CallUsage,
  generation: ResolvedGeneration,
  family: MediaTokenFamily | undefined,
): Promise<TurnEvent | undefined> {
  const reported = usage.reported;
  if (!reported && usage.failed) return undefined;
  const estimated = reported ? (reported.estimated ?? []) : (['input', 'output'] as const);
  if (reported && estimated.length === 0) return { type: 'tokens', tokens: reported };

  const prompt = estimated.includes('input')
    ? await countPrompt(usage, generation, family)
    : undefined;
  const written = estimated.includes('output') ? await countOutput(usage, true) : undefined;
  const input = prompt?.tokens ?? reported?.input ?? 0;
  const output = written?.tokens ?? reported?.output ?? 0;
  const unknownMedia = {
    ...(prompt?.unknownMedia ? { input: prompt.unknownMedia } : {}),
    ...(written?.unknownMedia ? { output: written.unknownMedia } : {}),
  };
  return {
    type: 'tokens',
    tokens: {
      ...reported,
      input,
      output,
      total: input + output,
      estimated: [...estimated],
      ...(Object.keys(unknownMedia).length > 0 ? { unknownMedia } : {}),
    },
  };
}

export type { CallConversation, CallUsage };
export { callTokensEvent, heldAfter, observeCallEvent, startCallUsage };
