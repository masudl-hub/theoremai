import { defineProfile } from '@theoremjs/agents';

export const desk = defineProfile({
  id: 'desk',
  type: 'text',
  identity: { handle: 'Desk', system: 'Answer in one line.' },
  models: {
    full: {
      protocol: 'openRouterOpenAi',
      provider: 'router',
      apiId: 'fake/full',
      efforts: { normal: 'minimal' },
    },
    free: {
      protocol: 'openRouterOpenAi',
      provider: 'router',
      apiId: 'fake/free',
      efforts: { normal: 'minimal' },
    },
  },
  defaultModel: 'full',
  allowModelSelect: true,
  tools: { allow: ['lookup_city', 'draw_city', 'file_note', 'wipe_desk'] },
  inputs: {
    text: true,
    attachments: { accept: ['image/*', 'application/pdf'] },
    maxFiles: 3,
    maxBytes: 1_000_000,
    maxTurnBytes: 2_000_000,
  },
  outputs: {},
  guardrails: {},
  turnBehaviour: {},
  observability: {},
  labels: {},
});
