import { defineProvider, openAIChat } from '@theoremjs/agents';

const shared = openAIChat({
  capabilities: {
    profileTypes: ['text'],
    inputKinds: ['text'],
    outputKinds: ['text'],
    builtins: [],
    features: {
      streaming: 'supported',
      clientTools: 'supported',
      parallelTools: 'unknown',
      structuredOutput: 'unknown',
      thinking: 'supported',
      summaries: 'unknown',
      storedContinuation: 'unsupported',
    },
  },
});

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
