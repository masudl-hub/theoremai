import type { TurnCost, TurnTokens } from '../turn-events.ts';

/** US dollars per million tokens. Thinking tokens are billed as output. */
export interface Rates {
  input: number;
  output: number;
  cachedInput?: number;
  /**
   * Rates for one modality's share of a side, keyed as `TurnTokens.byModality` keys it (`audio`,
   * `image`, …). A share with no rate here is billed at the side's own rate.
   */
  byModality?: {
    input?: Readonly<Record<string, number>>;
    output?: Readonly<Record<string, number>>;
  };
}

/** One model's rates, and the higher ones a prompt above `longContext.above` input tokens is billed at. */
export interface ModelPrice extends Rates {
  longContext?: Rates & { above: number };
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

/** Bills each priced modality's share at its rate, and the rest of the side at `rate`. */
function sideUsd(
  count: number,
  rate: number,
  modalityRates: Readonly<Record<string, number>> | undefined,
  shares: Record<string, number> | undefined,
): number {
  let rest = count;
  let usd = 0;
  for (const [modality, modalityRate] of Object.entries(modalityRates ?? {})) {
    const share = Math.min(shares?.[modality] ?? 0, rest);
    usd += share * modalityRate;
    rest -= share;
  }
  return usd + rest * rate;
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
  const usd =
    (cached * (rates.cachedInput ?? rates.input) +
      sideUsd(
        tokens.input - cached,
        rates.input,
        rates.byModality?.input,
        tokens.byModality?.input,
      ) +
      sideUsd(tokens.output, rates.output, rates.byModality?.output, tokens.byModality?.output)) /
    PER;
  return { usd, estimated: true };
}
