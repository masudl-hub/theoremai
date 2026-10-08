/**
 * o200k is not every model's tokenizer, so text counts are an estimate for all families. Media is
 * counted only by a rule the family's billed usage was measured to follow; a family without one
 * reports media as `unknownMedia`, never a borrowed rate.
 *
 * The rules themselves are a provider's facts: each lives in that provider's preset, and the
 * estimator asks for the one that covers a binding.
 */

import { PROVIDER_FACTS } from '../../presets/facts.ts';
import { historyMessageParts } from '../interaction-parts.ts';
import type { Provider } from '../schema.ts';
import type { InteractionPart, TurnHistoryMessage } from '../types.ts';

/** The encoding the estimator counts text with. */
export const TOKEN_TEXT_ENCODING = 'o200k_base';

/** A media file to count: its MIME type and either inline base64 `data` or a `uri`. */
export type MediaPayload = { mimeType: string; data: string } | { mimeType: string; uri: string };

/** A model family whose billed media usage follows a measured rule. */
export interface MediaTokenFamily {
  /** The family's name, such as `gemini-3`. */
  name: string;
  /** Token count of one media payload by the family's rule, or `undefined` when it covers none. */
  media: (payload: MediaPayload, text: (value: string) => number) => Promise<number | undefined>;
}

/** A token count and the number of media parts left out of it. */
export interface TokenCount {
  tokens: number;
  /** Media parts left out of `tokens` because their count is unknown. */
  unknownMedia: number;
}

/** Loaded estimator. Text counting is synchronous; anything with media is not. */
export interface TokenEstimator {
  /** o200k token count of `text`. */
  text: (text: string) => number;
  /** Token count of one media payload, or `undefined` when unknown. */
  media: (
    payload: MediaPayload,
    family: MediaTokenFamily | undefined,
  ) => Promise<number | undefined>;
  parts: (parts: InteractionPart[], family: MediaTokenFamily | undefined) => Promise<TokenCount>;
  /** Content, parts, and tool-call arguments across history messages. */
  messages: (
    messages: TurnHistoryMessage[],
    family: MediaTokenFamily | undefined,
  ) => Promise<TokenCount>;
}

/**
 * Media family for a model binding — `undefined` when no verified rule covers
 * it. A provider that routes to another's models answers with the routed model's family.
 */
export function mediaTokenFamily(binding: {
  provider: Provider;
  apiId: string;
}): MediaTokenFamily | undefined {
  return PROVIDER_FACTS[binding.provider].mediaFamily?.(binding.apiId);
}

type EncodeFn = (text: string) => number[];

let encodePromise: Promise<EncodeFn> | null = null;

function buildEstimator(encode: EncodeFn): TokenEstimator {
  const text = (value: string): number => (value ? encode(value).length : 0);
  const media: TokenEstimator['media'] = async (payload, family) =>
    family ? await family.media(payload, text) : undefined;
  const parts: TokenEstimator['parts'] = async (list, family) => {
    const count: TokenCount = { tokens: 0, unknownMedia: 0 };
    for (const part of list) {
      if (part.type === 'text') {
        count.tokens += text(part.text);
        continue;
      }
      const n = await media(part, family);
      if (n === undefined) count.unknownMedia += 1;
      else count.tokens += n;
    }
    return count;
  };
  const messages: TokenEstimator['messages'] = async (list, family) => {
    const count: TokenCount = { tokens: 0, unknownMedia: 0 };
    for (const msg of list) {
      const fromParts = await parts(historyMessageParts(msg), family);
      count.tokens += fromParts.tokens;
      count.unknownMedia += fromParts.unknownMedia;
      for (const tc of msg.tool_calls ?? []) {
        count.tokens += text(tc.function.name) + text(tc.function.arguments);
      }
    }
    return count;
  };
  return { text, media, parts, messages };
}

// why: The ranks import lazily, so hosts that never estimate never pay for them.
/** Loads the token estimator; the `o200k_base` ranks are imported on the first call. */
export async function loadTokenEstimator(): Promise<TokenEstimator> {
  // why: A control token in text is counted as the text it is. The encoder's default throws on one.
  encodePromise ??= import('gpt-tokenizer/encoding/o200k_base').then(
    (m) => (value: string) => m.encode(value, { disallowedSpecial: new Set() }),
  );
  return buildEstimator(await encodePromise);
}
