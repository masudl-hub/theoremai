import type { PriceTable } from '../../kernel/protocols/prices.ts';

/* probed 2026-10-15: https://ai.google.dev/gemini-api/docs/pricing, paid tier, US dollars per
 * million tokens. The Gemini API reports no cost. gemini-3.8-flash rises to $1.50 input and $7.50
 * output on 2027-01-01. Cached input is one rate here, so gemini-3.1-flash-lite's cached audio
 * ($0.05) is billed at its cached text rate. Gemma, gemini-3.7-flash and gemini-3.5-flash list no paid price;
 * gemini-2.5-flash-image's output is all image, $30 per million tokens.
 */

const live = {
  input: 0.75,
  output: 4.5,
  byModality: { input: { audio: 3, image: 1, video: 1 }, output: { audio: 12 } },
};

/** What the Gemini API charges per model. */
export const geminiPrices: PriceTable = {
  checked: '2026-10-15',
  models: {
    'gemini-3.8-flash': { input: 0.75, output: 3.75, cachedInput: 0.075 },
    'gemini-3.6-flash': { input: 0.75, output: 3.75, cachedInput: 0.075 },
    'gemini-3.8-live': live,
    'gemini-3.8-live-extended-thinking': live,
    'gemini-3.1-flash-live-preview': live,
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cachedInput: 0.03 },
    'gemini-3.1-flash-lite': {
      input: 0.25,
      output: 1.5,
      cachedInput: 0.025,
      byModality: { input: { audio: 0.5 } },
    },
    'gemini-3.1-pro-preview': {
      input: 2,
      output: 12,
      cachedInput: 0.2,
      longContext: { above: 200_000, input: 4, output: 18, cachedInput: 0.4 },
    },
    'gemini-3.1-flash-lite-image': {
      input: 0.25,
      output: 1.5,
      byModality: { output: { image: 30 } },
    },
    'gemini-3.8-flash-tts': { input: 0.5, output: 9 },
    'gemini-3.8-flash-lite-tts': { input: 0.5, output: 6 },
    'gemini-3.1-flash-tts-preview': { input: 1, output: 20 },
    'gemini-3-flash-preview': {
      input: 0.5,
      output: 3,
      cachedInput: 0.05,
      byModality: { input: { audio: 1 } },
    },
    'gemini-2.5-flash': {
      input: 0.3,
      output: 2.5,
      cachedInput: 0.03,
      byModality: { input: { audio: 1 } },
    },
    'gemini-2.5-flash-lite': {
      input: 0.1,
      output: 0.4,
      cachedInput: 0.01,
      byModality: { input: { audio: 0.3 } },
    },
    'gemini-2.5-flash-preview-tts': { input: 0.5, output: 10 },
    'gemini-2.5-flash-image': { input: 0.3, output: 30 },
  },
};
