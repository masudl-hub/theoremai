import { defineProvider, openAIChat } from '@theoremjs/agents';

function gateway(id: string, baseURL: string) {
  return defineProvider({ id, connection: { baseURL }, adapter: openAIChat() });
}

export const madeA = gateway('made-a', 'https://a.example/v1');
export const madeB = gateway('made-b', 'https://b.example/v1');
