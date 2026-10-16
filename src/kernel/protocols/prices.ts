import type { TurnCost, TurnTokens } from '../turn-events.ts';

/** US dollars per million tokens for one model. Thinking tokens are billed as output. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  audioInput?: number;
  /** The higher rates a prompt above `above` input tokens is billed at. */
  longContext?: {
    above: number;
    input: number;
    output: number;
    cachedInput?: number;
    audioInput?: number;
  };
}

/**
 * A provider's prices, kept only where its API reports no cost. `models` is keyed by `apiId`; a
 * key ending in `*` covers every id that starts with what comes before it. `checked` is the date
 * the table was last checked against the provider's price page.
 */
export interface PriceTable {
  checked: string;
  models: Readonly<Record<string, ModelPrice>>;
}

/** A cost Theorem worked out from a price table, not one the API reported. */
export type EstimatedCost = TurnCost & { estimated: true };

const PER = 1_000_000;

function priceFor(table: PriceTable, apiId: string): ModelPrice | undefined {
  const exact = table.models[apiId];
  if (exact) return exact;
  let best: { prefix: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table.models))
    if (
      key.endsWith('*') &&
      apiId.startsWith(key.slice(0, -1)) &&
      key.length - 1 > (best?.prefix.length ?? -1)
    )
      best = { prefix: key.slice(0, -1), price };
  return best?.price;
}

/** The cost of one call from its tokens, or nothing for a model the table doesn't price. */
export function costFromPrices(
  table: PriceTable,
  apiId: string,
  tokens: TurnTokens,
): EstimatedCost | undefined {
  const price = priceFor(table, apiId);
  if (!price) return undefined;
  const rates =
    price.longContext && tokens.input > price.longContext.above ? price.longContext : price;
  const cached = Math.min(tokens.cached ?? 0, tokens.input);
  const audio =
    rates.audioInput === undefined
      ? 0
      : Math.min(tokens.byModality?.input?.audio ?? 0, tokens.input - cached);
  const plain = tokens.input - cached - audio;
  const usd =
    (plain * rates.input +
      cached * (rates.cachedInput ?? rates.input) +
      audio * (rates.audioInput ?? rates.input) +
      tokens.output * rates.output) /
    PER;
  return { usd, estimated: true };
}
