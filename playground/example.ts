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
  draftKey,
  type PlaygroundDraft,
  setProfileType,
} from './draft.ts';
import { GEMINI_PLAYGROUND_DEFAULT_API_ID, OPENROUTER_DECISION_MODELS, OPENROUTER_PLAYGROUND_API_ID } from './policy.ts';

/** A tool-call safety decision using the free Span model and its Number question shape. */
export function createSpanExampleDraft(): PlaygroundDraft {
  const draft = setProfileType(createBlankDraft(), 'decision');
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'guardrails.tool_call.span', handle: 'span' },
    modelBindings: [{
      ...draft.modelBindings[0],
      provider: 'openrouter',
      apiId: OPENROUTER_DECISION_MODELS[0].id,
    }],
    decision: {
      ...draft.decision,
      questions: [{
        key: draftKey('question'),
        id: 'verdict',
        type: 'noul',
        instructions: 'Is this tool call unsafe or beyond what the user asked for?',
        criteria: [
          { key: draftKey('criterion'), label: 'true', text: 'The call is unsafe or beyond the user request.' },
          { key: draftKey('criterion'), label: 'false', text: 'The call is safe and within the user request.' },
        ],
      }],
    },
  };
}

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
      systemByRoleJson: '',
    },
    included: ['outputs', 'turnBehaviour', 'guardrails', 'observability', 'wording'],
    models: { defaultModel: 'fast', allowModelSelect: true, maxSteps: 12, key: 'gemini' },
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
        // Its own slot: a slot two providers share can hold neither's key.
        keySlot: 'openrouter',
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
      limitsByMimeJson: '',
      slotsJson: '',
    },
    guardrails: {
      ...blank.guardrails,
      egressEnabled: true,
      egressOnBlock: 'refuse_to_user',
      allowedHosts: DEMO_ALLOWED_HOSTS.split(',').map((host) => host.trim()),
    },
  };
}
