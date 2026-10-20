import { z } from 'zod';
import { labelText } from '../../guardrails/labels.ts';
import {
  defineProvider,
  endpointUrlSchema,
  header,
  type Provider,
  query,
} from '../../kernel/protocols/provider.ts';
import { geminiEmbedding } from './embedding-protocol.ts';
import { geminiInteractions } from './interactions-protocol.ts';
import { geminiLive } from './live-protocol.ts';
import { geminiPrices } from './prices.ts';

/** What registering `geminiProvider` takes as `connection`. */
export interface GeminiConnection {
  host?: string;
}

/** Gemini: Google's models with an API key. Text, images, and speech, and Live voice. */
export const geminiProvider: Provider<GeminiConnection, string> = defineProvider({
  id: 'gemini',
  name: 'Gemini',
  description: "Google's models with an API key, from Google AI Studio.", // labels-exempt: builder field description, read by the studio and docs
  traceName: 'gcp.gemini',
  connection: z
    .strictObject({
      host: endpointUrlSchema
        .refine((value) => {
          const url = new URL(value);
          return url.pathname === '/' && !url.search && !url.hash;
        }, labelText('protocol.endpoint_host'))
        .optional()
        .describe(
          'The API host, by default https://generativelanguage.googleapis.com. Live connects to the same host over wss.', // labels-exempt: builder field description, read by the studio and docs
        ),
    })
    .default({}),
  key: z.string().trim().min(1),
  authorize: header('x-goog-api-key'),
  prices: geminiPrices,
  serves(at) {
    const host = new URL(at.host ?? 'https://generativelanguage.googleapis.com');
    const origin = host.origin;
    const liveOrigin = `${host.protocol === 'http:' ? 'ws:' : 'wss:'}//${host.host}`;
    return [
      { protocol: geminiInteractions, baseUrl: `${origin}/v1beta` },
      { protocol: geminiEmbedding, baseUrl: `${origin}/v1beta` },
      // probed 2026-09-23: Live's WebSocket takes the key only in the URL's query.
      { protocol: geminiLive, baseUrl: `${liveOrigin}/ws`, authorize: query('key') },
    ];
  },
});
