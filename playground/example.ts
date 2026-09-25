/**
 * The playground's example draft: the travel concierge, a text profile with
 * three models, live HTTP tools, T2 tool discovery, and egress limited to the
 * demo's hosts.
 *
 * @module
 */

import {
  DEMO_ALLOWED_HOSTS,
  DEMO_CONCIERGE_SYSTEM,
  demoInputsSpec,
  demoToolSpecs,
} from './concierge-demo.ts';
import {
  createBlankDraft,
  defaultModelBinding,
  defaultToolSpec,
  type PlaygroundDraft,
} from './draft.ts';
import { GEMINI_PLAYGROUND_DEFAULT_API_ID, OPENROUTER_PLAYGROUND_API_ID } from './policy.ts';

/** A fresh copy of the travel concierge draft. */
export function createExampleDraft(): PlaygroundDraft {
  const blank = createBlankDraft();
  const inputs = demoInputsSpec();
  return {
    ...blank,
    identity: {
      agentId: 'travel.concierge',
      profileType: 'text',
      handle: 'concierge',
      system: DEMO_CONCIERGE_SYSTEM,
    },
    included: ['outputs', 'turnBehaviour', 'guardrails', 'observability'],
    models: { defaultModel: 'fast', allowModelSelect: true, maxSteps: 12, key: 'slotA' },
    modelBindings: [
      defaultModelBinding({
        modelId: 'fast',
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: GEMINI_PLAYGROUND_DEFAULT_API_ID,
        efforts: [
          { alias: 'fast', level: 'minimal' },
          { alias: 'deep', level: 'high' },
        ],
        defaultEffort: 'fast',
        allowEffortSelect: true,
        summaries: true,
      }),
      defaultModelBinding({
        modelId: 'smart',
        protocol: 'geminiInteractions',
        provider: 'google',
        apiId: 'gemini-3.5-flash-lite',
        efforts: [
          { alias: 'normal', level: 'low' },
          { alias: 'deep', level: 'high' },
        ],
        defaultEffort: 'normal',
        allowEffortSelect: true,
        summaries: true,
      }),
      defaultModelBinding({
        modelId: 'open',
        protocol: 'openAi',
        provider: 'openrouter',
        apiId: OPENROUTER_PLAYGROUND_API_ID,
        efforts: [{ alias: 'default', level: 'minimal' }],
        defaultEffort: 'default',
      }),
    ],
    tools: { t2Loader: 'discover_tools' },
    toolSpecs: demoToolSpecs().map((seed) => defaultToolSpec(seed.data)),
    inputs: {
      text: inputs.text,
      attachmentsAccept: [...inputs.attachmentsAccept],
      voiceAccept: [...inputs.voiceAccept],
      maxFiles: inputs.maxFiles,
      maxBytes: inputs.maxBytes,
      maxTurnBytes: inputs.maxTurnBytes,
    },
    guardrails: {
      ...blank.guardrails,
      egressEnabled: true,
      egressOnBlock: 'refuse_to_user',
      allowedHosts: DEMO_ALLOWED_HOSTS.split(',').map((host) => host.trim()),
    },
  };
}
