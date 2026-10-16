import { z } from 'zod';
import { bearer, defineProvider, endpointUrlSchema } from '../../kernel/protocols/provider.ts';
import { openAi } from '../open-ai/protocol.ts';

/** A server on your machine or network that speaks OpenAI's chat API: Ollama, llama.cpp, vLLM, LM Studio. */
export const localProvider = defineProvider({
  id: 'local',
  name: 'Local',
  description: "A server that speaks OpenAI's chat API: Ollama, llama.cpp, vLLM, LM Studio.", // labels-exempt: builder field description, read by the studio and docs
  traceName: 'openai',
  connection: z.strictObject({
    baseUrl: endpointUrlSchema.describe(
      'Where the server listens, up to and including /v1, e.g. http://localhost:11434/v1.', // labels-exempt: builder field description, read by the studio and docs
    ),
  }),
  key: z.string().trim().min(1).optional(),
  authorize: bearer(),
  serves: (at) => [{ protocol: openAi, baseUrl: at.baseUrl }],
});
