import { z } from 'zod';
import { bearer, defineProvider, endpointUrlSchema } from '../../kernel/protocols/provider.ts';
import { JEV_USD_PER_MILLION_INPUT_TOKENS } from '../../presets/typesafe.ts';
import { systemOne } from '../system-one/protocol.ts';

/** TypeSafe: System One decisions, at TypeSafe's own API. */
export const typesafeProvider = defineProvider({
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
  // probed 2026-09-28: Jev input is $0.042 per million tokens; output is free. The API reports no cost.
  prices: {
    checked: '2026-09-28',
    models: { 'jev-*': { input: JEV_USD_PER_MILLION_INPUT_TOKENS, output: 0 } },
  },
  serves: (at) => [{ protocol: systemOne, baseUrl: at.baseUrl ?? 'https://api.typesafe.ai/v1' }],
});
