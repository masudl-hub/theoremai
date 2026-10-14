import { defineProvider, openAIChat } from '@theoremjs/agents';

const shared = openAIChat();

export const left = defineProvider({
  id: 'left',
  connection: { baseURL: 'https://left.example/v1' },
  keySlot: 'pair_key',
  adapter: shared,
});

export const right = defineProvider({
  id: 'right',
  connection: { baseURL: 'https://right.example/v1' },
  keySlot: 'pair_key',
  adapter: shared,
});
