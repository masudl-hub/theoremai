import { z } from 'zod';
import {
  bearer,
  defineProvider,
  endpointUrlSchema,
  type Provider,
} from '../../kernel/protocols/provider.ts';
import { openRouterDecisions } from './decisions-protocol.ts';
import { openRouterEmbedding } from './embedding-protocol.ts';
import { openRouterImages } from './images-protocol.ts';
import { openRouterOpenAi } from './protocol.ts';

const connection = z.strictObject({
  baseUrl: endpointUrlSchema
    .optional()
    .describe('The API, by default https://openrouter.ai/api/v1.'), // labels-exempt: builder field description, read by the studio and docs
  decisionUrl: endpointUrlSchema
    .optional()
    .describe('The decision API, by default https://openrouter.ai/api/alpha/decisions.'), // labels-exempt: builder field description, read by the studio and docs
  siteUrl: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Sent as HTTP-Referer, for OpenRouter rankings.'), // labels-exempt: builder field description, read by the studio and docs
  siteName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Sent as X-Title, for OpenRouter rankings.'), // labels-exempt: builder field description, read by the studio and docs
});

/** What registering `openRouterProvider` takes as `connection`. */
export interface OpenRouterConnection {
  baseUrl?: string;
  decisionUrl?: string;
  siteUrl?: string;
  siteName?: string;
}

/** OpenRouter: many labs' models behind one key. Chat, speech, images, and decisions. */
export const openRouterProvider: Provider<OpenRouterConnection, string> = defineProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  description: "Many labs' models behind one key.", // labels-exempt: builder field description, read by the studio and docs
  connection: connection.default({}),
  key: z.string().trim().min(1),
  authorize: bearer(),
  serves(at) {
    const baseUrl = at.baseUrl ?? 'https://openrouter.ai/api/v1';
    const headers: Record<string, string> = {};
    if (at.siteUrl) headers['HTTP-Referer'] = at.siteUrl;
    if (at.siteName) headers['X-Title'] = at.siteName;
    const decisionUrl = at.decisionUrl ?? 'https://openrouter.ai/api/alpha/decisions';
    return [
      { protocol: openRouterOpenAi, baseUrl, headers },
      { protocol: openRouterEmbedding, baseUrl, headers },
      { protocol: openRouterImages, baseUrl, headers },
      { protocol: openRouterDecisions, baseUrl: decisionUrl, url: () => decisionUrl, headers },
    ];
  },
});
