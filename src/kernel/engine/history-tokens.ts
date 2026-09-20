/**
 * Local estimate of conversational history tokens (compaction `meter: 'history'`).
 *
 * **Text** — tiktoken `o200k_base` via `gpt-tokenizer` (GPT-4o / GPT-5 / o-series
 * default encoding). This is THEOREM's declared local BPE counter. Gemini has
 * no open JS tokenizer; hosts that need Gemini `countTokens` pass
 * `TurnInput.historyTokens`.
 *
 * The BPE ranks are loaded lazily on first text encode — not at module import.
 * Hosts that pass `historyTokens`, use `meter: 'input'`, or never estimate
 * history text never pay for the import.
 *
 * **Media** — not payload bytes. Current-turn files belong on `attachments` /
 * `voice` and are outside this meter. History media parts use published
 * Gemini multimodal *rates as minimum stubs* when dimensions / duration are
 * not on the part:
 * - image / document: one still-image tile (258) — Gemini 2.x small-image /
 *   one-page unit. Larger images are 258×tiles; Gemini 3 uses
 *   `media_resolution` budgets (often 560–1120), not a flat 258.
 * - audio: 32 tokens (1s @ 32/s). Longer clips scale with seconds.
 * - video: 263 tokens (1s @ 263/s). Longer clips scale with seconds.
 *
 * These stubs are intentional minima for “media is present in history,” not
 * billing-grade multimodal accounting. Prefer `historyTokens` when the host
 * knows better.
 *
 * @module
 */

import type { InteractionPart, MediaInputKind, TurnHistoryMessage } from '../types.ts';

/** Tiktoken encoding used for history text. */
export const HISTORY_TEXT_ENCODING = 'o200k_base';

/**
 * Minimum media stubs when size/duration are unknown.
 * See module doc — not “every image costs 258 forever.”
 */
export const HISTORY_MEDIA_TOKENS = {
  image: 258,
  document: 258,
  audio: 32,
  video: 263,
} as const satisfies Record<MediaInputKind, number>;

type EncodeFn = (text: string) => number[];

let encodePromise: Promise<EncodeFn> | null = null;

function loadEncode(): Promise<EncodeFn> {
  encodePromise ??= import('gpt-tokenizer/encoding/o200k_base').then((m) => m.encode);
  return encodePromise;
}

function mediaTokens(kind: MediaInputKind): number {
  return HISTORY_MEDIA_TOKENS[kind];
}

function partNeedsText(part: InteractionPart): boolean {
  return part.type === 'text' && Boolean(part.text);
}

function messageNeedsText(msg: TurnHistoryMessage): boolean {
  if (msg.content) return true;
  if (msg.parts?.some(partNeedsText)) return true;
  return Boolean(msg.tool_calls?.some((tc) => tc.function.arguments));
}

function needsTextEncode(messages: TurnHistoryMessage[]): boolean {
  return messages.some(messageNeedsText);
}

function sumMediaStubs(messages: TurnHistoryMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type !== 'text') tokens += mediaTokens(part.type);
    }
  }
  return tokens;
}

async function countMessageTokens(
  msg: TurnHistoryMessage,
  countText: (text: string) => Promise<number>,
): Promise<number> {
  let tokens = 0;
  if (msg.content) tokens += await countText(msg.content);
  for (const part of msg.parts ?? []) {
    tokens += part.type === 'text' ? await countText(part.text) : mediaTokens(part.type);
  }
  for (const tc of msg.tool_calls ?? []) {
    tokens += await countText(tc.function.arguments);
  }
  return tokens;
}

/** BPE-count conversational history (text + media stubs). Lazy-loads o200k. */
export async function estimateHistoryTokens(messages: TurnHistoryMessage[]): Promise<number> {
  if (!needsTextEncode(messages)) return sumMediaStubs(messages);

  let encode: EncodeFn | undefined;
  const countText = async (text: string): Promise<number> => {
    if (!text) return 0;
    encode ??= await loadEncode();
    return encode(text).length;
  };

  let tokens = 0;
  for (const msg of messages) {
    tokens += await countMessageTokens(msg, countText);
  }
  return tokens;
}
