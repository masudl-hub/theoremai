import { defineProvider, openAIChat, type ProviderAdapter } from '@theoremjs/agents';
import { z } from 'zod';

/** The project's own adapter: the chat adapter under its own name, with a region of its own. */
const chat = openAIChat();
const ownAdapter = {
  ...chat,
  id: 'own-chat',
  connectionSchema: z.object({ baseURL: z.string(), region: z.string() }).strict(),
} as unknown as ProviderAdapter<{ baseURL: string; region: string }>;

export const own = defineProvider({
  id: 'own',
  connection: { baseURL: 'https://own.example/v1', region: 'eu' },
  keySlot: 'own_key',
  adapter: ownAdapter,
});
