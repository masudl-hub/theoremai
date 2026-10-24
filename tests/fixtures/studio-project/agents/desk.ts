import { defineProfile } from '@theoremjs/agents';

export const desk = defineProfile({
  id: 'desk',
  type: 'text',
  identity: { handle: 'Desk' },
  models: {
    primary: { protocol: 'openAi', provider: 'house', apiId: 'house/model-1', efforts: { normal: 'minimal' } },
    second: { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'openrouter/free', efforts: { normal: 'minimal' } },
    third: { protocol: 'openAi', provider: 'left', apiId: 'left/model', efforts: { normal: 'minimal' } },
    fourth: { protocol: 'geminiInteractions', provider: 'odd', apiId: 'gemini-2.5-flash', efforts: { normal: 'minimal' } },
    fifth: { protocol: 'openAi', provider: 'own', apiId: 'own/model', efforts: { normal: 'minimal' } },
  },
  defaultModel: 'primary',
  tools: { allow: ['lookup_city'] },
  inputs: { text: true },
  outputs: {},
  guardrails: {},
  turnBehaviour: {},
  observability: {},
  labels: {},
});
