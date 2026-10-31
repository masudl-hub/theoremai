import { defineProfile } from '@theoremjs/agents';

export const concierge = defineProfile({
  id: 'concierge',
  type: 'text',
  // why: worked out in code, so the studio shows the handle read-only and offers its line.
  identity: {
    handle: `Con${Deno.env.get('NO_SUCH_NAME') ?? 'cierge'}`,
    system: 'Answer in one line.',
  },
  models: {
    full: {
      protocol: 'openRouterOpenAi',
      provider: 'router',
      apiId: 'fake/full',
      efforts: { normal: 'minimal' },
    },
  },
  defaultModel: 'full',
  tools: { allow: ['lookup_city'] },
  inputs: { text: true },
});

export const triage = defineProfile({
  type: 'decision',
  id: 'triage',
  identity: { handle: 'triage' },
  models: { main: { protocol: 'openRouterDecisions', provider: 'router', apiId: 'fake/decide' } },
  inputs: { state: 'json', maxStateBytes: 2000 },
  decision: { contract: 'triage.v1' },
});

export const index = defineProfile({
  type: 'embedding',
  id: 'index',
  identity: { handle: 'index' },
  inputs: { text: true },
  models: { main: { protocol: 'openRouterEmbeddings', provider: 'router', apiId: 'fake/embed' } },
});

export const picture = defineProfile({
  type: 'image',
  id: 'picture',
  identity: { handle: 'Picture' },
  models: { main: { protocol: 'openRouterImages', provider: 'router', apiId: 'fake/image' } },
  defaultModel: 'main',
  tools: { allow: [] },
  inputs: {},
  image: { mimeType: 'image/png' },
});

export const reader = defineProfile({
  type: 'speech',
  id: 'reader',
  identity: { handle: 'Reader' },
  models: { main: { protocol: 'openRouterOpenAi', provider: 'router', apiId: 'fake/speech' } },
  defaultModel: 'main',
  speech: { voice: 'alloy', format: 'mp3' },
});

export const line = defineProfile({
  type: 'live',
  id: 'line',
  identity: { handle: 'Line' },
  models: { main: { protocol: 'geminiLive', provider: 'google', apiId: 'fake-live' } },
  defaultModel: 'main',
  tools: { allow: ['file_note'] },
  live: { voice: 'Aoede', ingress: { text: true, audio: true, video: false } },
});

export const gatekeeper = defineProfile({
  type: 'host',
  id: 'gatekeeper',
  tools: { allow: ['lookup_city', 'wipe_desk'] },
});
