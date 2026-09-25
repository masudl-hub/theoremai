/**
 * THEOREM's one token estimator — used when a count is needed and no provider
 * reported one (compaction metering, the usage fallback, host prompt budgets).
 *
 * **Text** — tiktoken `o200k_base` via `gpt-tokenizer`. The ranks load once,
 * asynchronously, on `loadTokenEstimator()`; text counting is synchronous after
 * that. Hosts that never estimate never pay for the import. o200k is not every
 * model's tokenizer, so text counts are an estimate for all families. Media
 * counting is asynchronous: reading a PDF page tree can mean inflating
 * compressed object streams.
 *
 * **Media** — counted only by a rule the model family's billed usage was
 * measured to follow. A family without one reports media as unknown
 * (`unknownMedia`), never a borrowed rate.
 *
 * Gemini 3 (`gemini-3*` flash / pro text models, direct or via OpenRouter).
 * Measured 22/09/2026 against the usage Gemini bills — Interactions `usage`
 * and `generateContent` `usageMetadata` agree exactly — on gemini-3.8-flash
 * at the default media resolution (THEOREM never sets `media_resolution`).
 * `countTokens` is not the oracle: it reports 560 per PDF page and 32 tokens
 * per audio second, and neither is what is billed.
 * - image: a patch grid inside a 1120-token budget that keeps the aspect
 *   ratio — `⌊√(1120·w/h)⌋ × ⌊√(1120·h/w)⌋` (1024×1024 → 1089, 1920×1080 →
 *   1100, 4032×3024 HEIC → 1064). Needs the pixel size from the image header.
 * - audio: `⌈seconds × 25⌉`, seconds being decoded samples ÷ rate
 *   (`audioSeconds`): 2.2 s → 56, 0.5 s → 13. Sample rate, channels and
 *   silence do not matter. Raw PCM: bare `audio/pcm` is 16 kHz mono 16-bit;
 *   `audio/L16` needs both `rate` and `channels`. `audio/pcm` with parameters,
 *   `audio/alaw`, and `audio/mulaw` are refused by Interactions — unknown.
 *   Mono `audio/L16` is unknown: Gemini converts it first and adds text tokens
 *   no rule reproduces (about 31–33, plus 2 per second, plus 1 audio token
 *   away from 16 kHz).
 * - video: `frames × ⌊√(70·w/h)⌋ × ⌊√(70·h/w)⌋ + ⌈min(audio, frames) × 25⌉`,
 *   `frames` = the video track's seconds rounded half up (66 per frame at
 *   16:9, 63 at 4:3; fps, codec and container do not matter). Under half a
 *   second rounds to no frames, which Gemini refuses — unknown. MP4 / MOV /
 *   3GP and WebM only (`videoInfo`); other containers are unknown.
 * - PDF: 520 tokens per page. Text on the page adds nothing.
 * - text documents (plain, Markdown, CSV, JSON, HTML, CSS, XML, RTF,
 *   JavaScript, Python) as their UTF-8 text. `text/md` and
 *   `application/x-python` are unknown: Gemini converts them first, adding
 *   about 30 text tokens no rule reproduces.
 * - Provider file references (`uri`): unknown — the bytes are not here.
 *
 * Known gap: ADTS AAC. Gemini estimates its length from the bitrate; the
 * decoded length here runs 2–3 tokens over at 10 s.
 *
 * Not yet checked against billed usage: video in WebM / MOV / 3GP, anamorphic
 * video, and Gemini 3 models other than gemini-3.8-flash. The full probe and
 * open decisions: https://github.com/masudl-hub/theoremai/issues/18
 *
 * @module
 */

import { historyMessageParts } from '../interaction-parts.ts';
import { MEDIA_INPUT_KINDS, type Provider } from '../schema.ts';
import type { InteractionPart, TurnHistoryMessage } from '../types.ts';
import { base64ToBytes } from '../util/base64.ts';
import { mimeEssence } from '../util/mime.ts';
import { audioSeconds } from './media-probe/audio.ts';
import { imageSize } from './media-probe/image.ts';
import { pdfPageCount } from './media-probe/pdf.ts';
import { videoInfo } from './media-probe/video.ts';

/** Tiktoken encoding used for text. */
export const TOKEN_TEXT_ENCODING = 'o200k_base';

/** Model families with a verified media rule. */
export type MediaTokenFamily = 'gemini-3';

/** Inline or referenced media payload. */
export type MediaPayload = { mimeType: string; data: string } | { mimeType: string; uri: string };

/** Estimated count plus the media parts that could not be counted. */
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
  /** Text and media across provider input parts. */
  parts: (parts: InteractionPart[], family: MediaTokenFamily | undefined) => Promise<TokenCount>;
  /** Content, parts, and tool-call arguments across history messages. */
  messages: (
    messages: TurnHistoryMessage[],
    family: MediaTokenFamily | undefined,
  ) => Promise<TokenCount>;
}

const GEMINI_3_TEXT_MODEL = /^gemini-3(?:\.\d+)?-(?:flash|pro)(?:-lite)?(?:-preview)?$/;
const OPENROUTER_GOOGLE_PREFIX = 'google/';
const GEMINI_3_IMAGE_BUDGET = 1120;
const GEMINI_3_VIDEO_FRAME_BUDGET = 70;
const GEMINI_3_AUDIO_PER_SECOND = 25;
const GEMINI_3_PDF_PER_PAGE = 520;
/** Bare `audio/pcm`: 16-bit mono at 16 kHz. */
const PCM_DEFAULT_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
/** Document types Gemini reads as their own text. */
const GEMINI_3_TEXT_DOCUMENTS = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'text/css',
  'text/xml',
  'text/rtf',
  'text/javascript',
  'application/x-javascript',
  'text/x-python',
  'application/json',
]);

/**
 * Media family for a model binding — `undefined` when no verified rule covers
 * it. OpenRouter uses the routed model's family (`google/gemini-3…`).
 */
export function mediaTokenFamily(binding: {
  provider: Provider;
  apiId: string;
}): MediaTokenFamily | undefined {
  const modelId =
    binding.provider === 'google'
      ? binding.apiId
      : binding.provider === 'openrouter' && binding.apiId.startsWith(OPENROUTER_GOOGLE_PREFIX)
        ? binding.apiId.slice(OPENROUTER_GOOGLE_PREFIX.length)
        : undefined;
  if (modelId === undefined) return undefined;
  return GEMINI_3_TEXT_MODEL.test(modelId) ? 'gemini-3' : undefined;
}

function mimeParam(mimeType: string, name: string): number | undefined {
  for (const piece of mimeType.split(';').slice(1)) {
    const [key, value] = piece.split('=').map((s) => s.trim().toLowerCase());
    if (key === name) {
      const n = Number(value);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}

function hasParams(mimeType: string): boolean {
  return mimeType.includes(';');
}

/** Seconds of raw 16-bit PCM, or `undefined` when Gemini refuses how it is declared. */
function pcmSeconds(mimeType: string, bytes: Uint8Array): number | undefined {
  const essence = mimeEssence(mimeType);
  let rate: number | undefined;
  let channels: number | undefined;
  if (essence === 'audio/pcm') {
    if (hasParams(mimeType)) return undefined;
    rate = PCM_DEFAULT_RATE;
    channels = 1;
  } else {
    rate = mimeParam(mimeType, 'rate');
    channels = mimeParam(mimeType, 'channels');
    // Mono L16 is converted before it is counted; see the module doc.
    if (channels === 1) return undefined;
  }
  if (!rate || !channels) return undefined;
  return Math.floor(bytes.length / (PCM_BYTES_PER_SAMPLE * channels)) / rate;
}

function gemini3Audio(mimeType: string, bytes: Uint8Array): number | undefined {
  const essence = mimeEssence(mimeType);
  const seconds =
    essence === 'audio/pcm' || essence === 'audio/l16'
      ? pcmSeconds(mimeType, bytes)
      : essence === 'audio/alaw' || essence === 'audio/mulaw'
        ? undefined
        : audioSeconds(bytes);
  return seconds === undefined ? undefined : Math.ceil(seconds * GEMINI_3_AUDIO_PER_SECOND);
}

/** Patches of a `budget`-token grid that keeps the `w`×`h` aspect ratio. */
function patchGrid(budget: number, w: number, h: number): number {
  return Math.floor(Math.sqrt((budget * w) / h)) * Math.floor(Math.sqrt((budget * h) / w));
}

function gemini3Video(bytes: Uint8Array): number | undefined {
  const info = videoInfo(bytes);
  if (!info || info.audioSeconds === undefined) return undefined;
  const frames = Math.floor(info.seconds + 0.5);
  if (frames === 0) return undefined;
  return (
    frames * patchGrid(GEMINI_3_VIDEO_FRAME_BUDGET, info.width, info.height) +
    Math.ceil(Math.min(info.audioSeconds, frames) * GEMINI_3_AUDIO_PER_SECOND)
  );
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: what Gemini reads from it is unknown.
    return undefined;
  }
}

async function gemini3Media(
  payload: MediaPayload,
  text: (value: string) => number,
): Promise<number | undefined> {
  if (!('data' in payload)) return undefined;
  const essence = mimeEssence(payload.mimeType);
  const bytes = base64ToBytes(payload.data);
  switch (MEDIA_INPUT_KINDS[essence]) {
    case 'image': {
      const size = imageSize(bytes);
      return size ? patchGrid(GEMINI_3_IMAGE_BUDGET, size.width, size.height) : undefined;
    }
    case 'audio':
      return gemini3Audio(payload.mimeType, bytes);
    case 'video':
      return gemini3Video(bytes);
    case 'document': {
      if (essence === 'application/pdf') {
        const pages = await pdfPageCount(bytes);
        return pages === undefined ? undefined : pages * GEMINI_3_PDF_PER_PAGE;
      }
      if (!GEMINI_3_TEXT_DOCUMENTS.has(essence)) return undefined;
      const decoded = utf8(bytes);
      return decoded === undefined ? undefined : text(decoded);
    }
  }
  return undefined;
}

type EncodeFn = (text: string) => number[];

let encodePromise: Promise<EncodeFn> | null = null;

function buildEstimator(encode: EncodeFn): TokenEstimator {
  const text = (value: string): number => (value ? encode(value).length : 0);
  const media: TokenEstimator['media'] = async (payload, family) =>
    family === 'gemini-3' ? await gemini3Media(payload, text) : undefined;
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

/** Load the o200k ranks once and return the synchronous estimator. */
export async function loadTokenEstimator(): Promise<TokenEstimator> {
  encodePromise ??= import('gpt-tokenizer/encoding/o200k_base').then((m) => m.encode);
  return buildEstimator(await encodePromise);
}
