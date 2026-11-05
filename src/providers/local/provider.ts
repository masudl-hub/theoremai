import { z } from 'zod';
import {
  bearer,
  defineProvider,
  endpointUrlSchema,
  type Provider,
} from '../../kernel/protocols/provider.ts';
import { openAi } from '../open-ai/protocol.ts';
import { ollamaEmbeddings } from './embeddings-protocol.ts';

/** What registering `localProvider` takes as `connection`. */
export interface LocalConnection {
  baseUrl: string;
}

/** A server on your machine or network that speaks OpenAI's chat API: Ollama, llama.cpp, vLLM, LM Studio. */
export const localProvider: Provider<LocalConnection, string> = defineProvider({
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
  serves: (at) => [
    { protocol: openAi, baseUrl: at.baseUrl },
    {
      protocol: ollamaEmbeddings,
      baseUrl: at.baseUrl,
      url: ({ path }) => {
        const base = new URL(at.baseUrl);
        base.pathname = base.pathname.replace(/\/v1\/?$/, '') || '/';
        return new URL(path.replace(/^\/+/, ''), base).toString();
      },
    },
  ],
});
