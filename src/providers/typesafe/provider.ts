import { z } from 'zod';
import {
  bearer,
  defineProvider,
  endpointUrlSchema,
  type Provider,
} from '../../kernel/protocols/provider.ts';
import { systemOne } from '../system-one/protocol.ts';

/** What registering `typesafeProvider` takes as `connection`. */
export interface TypesafeConnection {
  baseUrl?: string;
}

/** TypeSafe: System One decisions, at TypeSafe's own API. */
export const typesafeProvider: Provider<TypesafeConnection, string> = defineProvider({
  id: 'typesafe',
  name: 'TypeSafe',
  description: "System One decisions, at TypeSafe's own API.", // labels-exempt: builder field description, read by the studio and docs
  connection: z
    .strictObject({
      baseUrl: endpointUrlSchema
        .optional()
        .describe('The API, by default https://api.typesafe.ai/v1.'), // labels-exempt: builder field description, read by the studio and docs
    })
    .default({}),
  key: z.string().trim().min(1),
  authorize: bearer(),
  // why: docs.typesafe.ai/models, read 2026-10-19, prices Jev 1.13 and 1.14 alike at $0.042 per million input tokens, output free. The API reports no cost.
  prices: {
    checked: '2026-10-19',
    models: { 'jev-*': { input: 0.042, output: 0 } },
  },
  // probed 2026-10-27: a working key answers 200; a wrong one 401, none 403.
  check: { protocol: systemOne, path: '/models' },
  serves: (at) => [{ protocol: systemOne, baseUrl: at.baseUrl ?? 'https://api.typesafe.ai/v1' }],
});
