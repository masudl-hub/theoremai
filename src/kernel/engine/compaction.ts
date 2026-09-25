/**
 * Compaction helpers: history split + threshold metering.
 *
 * Pure and stateless. History lives on the request; the kernel does not store
 * cross-turn session state.
 *
 * @module
 */

import type {
  CompactionMeter,
  CompactionSpec,
  CompactionTriggerContext,
  TurnHistoryMessage,
  TurnInput,
  TurnTokens,
} from '../types.ts';
import { loadTokenEstimator, type MediaTokenFamily } from './token-estimate.ts';

/** Result of splitting history for compaction. */
export interface CompactionSplit {
  /** Messages to send to the compaction profile. */
  toCompact: TurnHistoryMessage[];
  /** Recent exchanges to preserve verbatim. */
  toRetain: TurnHistoryMessage[];
}

/** Resolved meter for a compaction decision. */
export interface CompactionTokens {
  meter: CompactionMeter;
  /** Token count compared to `compactAt * maxTokens`. */
  tokens: number;
  /**
   * Media parts left out of `tokens` because no verified rule counts them
   * for this model (see `token-estimate.ts`). Always 0 for host-supplied and
   * provider-reported counts.
   */
  unknownMedia: number;
}

/** Effective meter; defaults to `'history'`. */
export function compactionMeter(spec: CompactionSpec): CompactionMeter {
  return spec.meter ?? 'history';
}

/**
 * Find exchange boundaries in a history array.
 *
 * An exchange starts at each `user` message and includes all subsequent
 * messages until the next `user` message. System messages before the first
 * user message are not part of any exchange.
 *
 * Returns the indices of each `user` message that starts an exchange.
 */
function findExchangeBoundaries(history: TurnHistoryMessage[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/**
 * History token count for `meter: 'history'`.
 *
 * Prefers host-supplied `input.historyTokens`. Otherwise estimates
 * `input.history` with the one token estimator, counting media by the model
 * family's verified rule. Empty/missing → 0.
 */
export async function resolveHistoryTokens(
  input: TurnInput | undefined,
  family: MediaTokenFamily | undefined,
): Promise<Omit<CompactionTokens, 'meter'>> {
  if (input?.historyTokens != null) {
    return { tokens: input.historyTokens, unknownMedia: 0 };
  }
  const history = input?.history ?? [];
  if (history.length === 0) return { tokens: 0, unknownMedia: 0 };
  return await (await loadTokenEstimator()).messages(history, family);
}

/**
 * Resolve the token count used for the compaction threshold.
 *
 * - `meter: 'history'` (default) — `historyTokens` or estimate of `history`
 *   (media counted by `family`'s rule; unknown media reported, not guessed).
 * - `meter: 'input'` — prefer `prompt.input` (this turn's last model call,
 *   for `timing: 'after'`; the estimator's count when the provider reported
 *   none, with its uncounted prompt media), else host `input.inputTokens`
 *   (previous turn, for `timing: 'before'`). Missing/non-positive → undefined
 *   (do not fire).
 *
 * `meter: 'input'` never loads the history tokenizer.
 */
export async function resolveCompactionTokens(args: {
  spec: CompactionSpec;
  input?: TurnInput;
  /** Tokens of this turn's last model call, when one completed. */
  prompt?: TurnTokens;
  /** Media family of the turn's model binding (`mediaTokenFamily`). */
  family: MediaTokenFamily | undefined;
}): Promise<CompactionTokens | undefined> {
  const meter = compactionMeter(args.spec);
  if (meter === 'history') {
    return { meter, ...(await resolveHistoryTokens(args.input, args.family)) };
  }
  if (args.prompt && args.prompt.input > 0) {
    return { meter, tokens: args.prompt.input, unknownMedia: args.prompt.unknownMedia?.input ?? 0 };
  }
  const fromHost = args.input?.inputTokens;
  if (fromHost == null || fromHost <= 0) return undefined;
  return { meter, tokens: fromHost, unknownMedia: 0 };
}

/** Whether compaction should fire for a resolved token count (token-threshold only). */
export function compactionNeeded(tokens: number, spec: CompactionSpec): boolean {
  return tokens > spec.compactAt * spec.maxTokens;
}

/**
 * Whether compaction should fire, respecting a custom trigger when provided.
 *
 * When `spec.trigger` is set, it is called with full context and its result
 * is returned directly. Otherwise falls back to `compactionNeeded`.
 */
export async function shouldCompact(
  resolved: CompactionTokens,
  spec: CompactionSpec,
): Promise<boolean> {
  if (spec.trigger) {
    const ctx: CompactionTriggerContext = {
      tokens: resolved.tokens,
      maxTokens: spec.maxTokens,
      compactAt: spec.compactAt,
      meter: resolved.meter,
      unknownMedia: resolved.unknownMedia,
    };
    return await spec.trigger(ctx);
  }
  return compactionNeeded(resolved.tokens, spec);
}

/**
 * Split history into compactable and retained segments.
 *
 * `previousExchanges` semantics:
 * - `0` — compact everything, retain nothing.
 * - `≥ 1` (integer) — retain the last N exchanges.
 * - `(0, 1)` — retain exchanges that fit within this fraction of `maxTokens`,
 *   walking backwards from the most recent (token estimator; unknown media is
 *   not counted).
 */
export async function splitForCompaction(
  history: TurnHistoryMessage[],
  spec: CompactionSpec,
  family: MediaTokenFamily | undefined,
): Promise<CompactionSplit> {
  if (history.length === 0) {
    return { toCompact: [], toRetain: [] };
  }

  if (spec.previousExchanges === 0) {
    return { toCompact: [...history], toRetain: [] };
  }

  const boundaries = findExchangeBoundaries(history);

  if (boundaries.length === 0) {
    return { toCompact: [...history], toRetain: [] };
  }

  let cutIndex: number;

  if (spec.previousExchanges >= 1) {
    const keep = Math.min(spec.previousExchanges, boundaries.length);
    cutIndex = boundaries[boundaries.length - keep];
  } else {
    const budget = spec.previousExchanges * spec.maxTokens;
    const estimator = await loadTokenEstimator();
    let accumulated = 0;
    cutIndex = history.length;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      const exchangeStart = boundaries[i];
      const exchangeEnd = i < boundaries.length - 1 ? boundaries[i + 1] : history.length;
      const exchangeMessages = history.slice(exchangeStart, exchangeEnd);
      const exchangeTokens = (await estimator.messages(exchangeMessages, family)).tokens;
      if (accumulated + exchangeTokens > budget) {
        break;
      }
      accumulated += exchangeTokens;
      cutIndex = exchangeStart;
    }
  }

  if (cutIndex <= 0) {
    return { toCompact: [], toRetain: [...history] };
  }

  return {
    toCompact: history.slice(0, cutIndex),
    toRetain: history.slice(cutIndex),
  };
}
