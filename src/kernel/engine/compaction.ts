import type {
  CompactionMeter,
  CompactionSpec,
  CompactionTriggerContext,
  TurnHistoryMessage,
  TurnInput,
  TurnTokens,
} from '../types.ts';
import { loadTokenEstimator, type MediaTokenFamily } from './token-estimate.ts';

export interface CompactionSplit {
  toCompact: TurnHistoryMessage[];
  toRetain: TurnHistoryMessage[];
}

export interface CompactionTokens {
  meter: CompactionMeter;
  /** Token count compared to `compactAt * maxTokens`. */
  tokens: number;
  /**
   * Media parts left out of `tokens` because no verified rule counts them for this model.
   * Always 0 for host-supplied and provider-reported counts.
   */
  unknownMedia: number;
}

/** Effective meter; defaults to `'history'`. */
export function compactionMeter(spec: CompactionSpec): CompactionMeter {
  return spec.meter ?? 'history';
}

// An exchange starts at each `user` message; system messages before the first one belong to none.
function findExchangeBoundaries(history: TurnHistoryMessage[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/** Prefers host-supplied `input.historyTokens`; otherwise estimates `input.history`. */
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
 * `meter: 'input'` prefers this turn's last model call (`timing: 'after'`), else the host's
 * `input.inputTokens` from the previous turn (`timing: 'before'`); `undefined` (do not fire) when
 * neither is positive. It never loads the history tokenizer.
 */
export async function resolveCompactionTokens(args: {
  spec: CompactionSpec;
  input?: TurnInput;
  /** Tokens of this turn's last model call, when one completed. */
  prompt?: TurnTokens;
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

export function compactionNeeded(tokens: number, spec: CompactionSpec): boolean {
  return tokens > spec.compactAt * spec.maxTokens;
}

/** `spec.trigger`, when set, decides alone; otherwise the token threshold does. */
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
