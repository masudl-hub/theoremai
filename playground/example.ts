import {
  DEMO_ALLOWED_HOSTS,
  DEMO_ARCHITECT_SYSTEM,
  DEMO_ARCHITECT_TOOLS,
  DEMO_CONCIERGE_SYSTEM,
  DEMO_CONCIERGE_TOOLS,
  DEMO_CONSOLE_TOOLS,
  DEMO_LIVE_CONCIERGE_SYSTEM,
  demoInputsSpec,
  demoToolSpecs,
} from './concierge-demo.ts';
import { DETECTOR_BOUNDARIES, DETECTORS } from '../src/guardrails/detectors.ts';
import {
  createBlankDraft,
  defaultModelBinding,
  defaultToolSpec,
  draftKey,
  includableFacets,
  type GuardrailsDraft,
  includeFacet,
  type PlaygroundDraft,
  setProfileType,
  type ToolSpecDraft,
} from './draft.ts';
import { addAgent, agentNodeId, type PlaygroundWorkspace, workspaceFromDraft } from './workspace.ts';
import { GEMINI_PLAYGROUND_DEFAULT_API_ID, OPENROUTER_DECISION_MODELS, OPENROUTER_PLAYGROUND_API_ID } from './policy.ts';

/**
 * A tool-call safety decision on TypeSafe's Jev: the draft a blank agent becomes when its type is
 * set to decision, with every section that type brings, named so it runs as it opens.
 */
export function createDecisionExampleDraft(): PlaygroundDraft {
  const blank = createBlankDraft();
  const had = new Set(includableFacets(blank));
  const decision = setProfileType(blank, 'decision');
  const draft = includableFacets(decision)
    .filter((facet) => !had.has(facet))
    .reduce(includeFacet, decision);
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'guardrails.tool_call.jev', handle: 'jev' },
  };
}

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

/**
 * The example's `detect`: a reply that carries sensitive data or injection phrasing is blocked.
 * Network addresses are left alone, since a reply cites them, and so are tool names, since a
 * reply repeats one the visitor asks about.
 */
function exampleDetect(detect: GuardrailsDraft['detect']): GuardrailsDraft['detect'] {
  const next = structuredClone(detect);
  for (const detector of DETECTORS) {
    if (detector === 'network' || detector === 'tool_leak') continue;
    for (const boundary of ['reply', 'reply_structured', 'live_reply'] as const) {
      if (DETECTOR_BOUNDARIES[detector].includes(boundary)) next[detector][boundary] = 'block';
    }
  }
  return next;
}

/** The demo tools named, in the library's order. */
function exampleTools(names: readonly string[]): ToolSpecDraft[] {
  const wanted = new Set(names);
  return demoToolSpecs()
    .filter((seed) => wanted.has(seed.data.toolName ?? ''))
    .map((seed) => defaultToolSpec(seed.data));
}

/** A text agent on the playground's models, with the example's inputs and guardrails. */
function exampleTextDraft(
  identity: Pick<PlaygroundDraft['identity'], 'agentId' | 'handle' | 'system'>,
  tools: Pick<PlaygroundDraft, 'tools' | 'toolSpecs'>,
): PlaygroundDraft {
  const blank = createBlankDraft();
  const inputs = demoInputsSpec();
  return {
    ...blank,
    identity: { ...identity, profileType: 'text', systemByRoleJson: '' },
    included: ['outputs', 'turnBehaviour', 'guardrails', 'observability', 'wording'],
    models: { defaultModel: 'smart', allowModelSelect: true, maxSteps: 12, key: 'gemini' },
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
    ...tools,
    inputs: {
      text: inputs.text,
      attachmentsAccept: [...inputs.attachmentsAccept],
      voiceAccept: [...inputs.voiceAccept],
      maxFiles: inputs.maxFiles,
      maxBytes: inputs.maxBytes,
      maxTurnBytes: inputs.maxTurnBytes,
      limitsByMimeJson: '',
      slotsJson: '',
      contextFrom: [],
      contextMaxChars: null,
    },
    guardrails: {
      ...blank.guardrails,
      detect: exampleDetect(blank.guardrails.detect),
      blockedReplyOnBlock: 'refuse',
      allowedHosts: DEMO_ALLOWED_HOSTS.split(',').map((host) => host.trim()),
    },
  };
}

/** A fresh copy of the travel concierge draft: a text agent with the tools a trip needs. */
export function createExampleDraft(): PlaygroundDraft {
  return exampleTextDraft(
    { agentId: 'travel.concierge', handle: 'concierge', system: DEMO_CONCIERGE_SYSTEM },
    { tools: { t2Loader: 'discover_tools' }, toolSpecs: exampleTools(DEMO_CONCIERGE_TOOLS) },
  );
}

/** The travel concierge on a call: the same tools, a live model and an instruction for speech. */
export function createLiveExampleDraft(): PlaygroundDraft {
  const draft = setProfileType(createExampleDraft(), 'live');
  return {
    ...draft,
    identity: {
      ...draft.identity,
      agentId: 'travel.concierge.live',
      system: DEMO_LIVE_CONCIERGE_SYSTEM,
    },
  };
}

/** A speech agent that reads a script aloud. */
export function createNarratorExampleDraft(): PlaygroundDraft {
  const draft = setProfileType(createBlankDraft(), 'speech');
  return { ...draft, identity: { ...draft.identity, agentId: 'studio.narrator', handle: 'narrator' } };
}

/** A host with no model: a few demo tools, one of each kind of result. */
export function createConsoleExampleDraft(): PlaygroundDraft {
  const draft = setProfileType(createBlankDraft(), 'host');
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'tools.console' },
    toolSpecs: exampleTools(DEMO_CONSOLE_TOOLS),
  };
}

/**
 * The code architect and the narrator it calls: a text agent that researches docs, repositories
 * and packages, with an agent tool that has the narrator read a briefing aloud.
 */
export function createArchitectWorkspace(): PlaygroundWorkspace {
  const architectDraft = exampleTextDraft(
    { agentId: 'code.architect', handle: 'architect', system: DEMO_ARCHITECT_SYSTEM },
    { tools: { t2Loader: '' }, toolSpecs: exampleTools(DEMO_ARCHITECT_TOOLS) },
  );
  const pair = addAgent(workspaceFromDraft(architectDraft), createNarratorExampleDraft());
  const [architect, narrator] = pair.agents;
  if (!architect || !narrator) return pair;
  const narrate = defaultToolSpec({
    toolName: 'narrate',
    toolType: 'agent',
    agentKey: narrator.key,
    description: 'Has the narrator read a script aloud and returns the audio.',
    activity: 'Recording the briefing',
    activityPast: 'Recorded the briefing',
    category: 'demo',
  });
  return {
    ...pair,
    agents: [
      { ...architect, tools: { ...architect.tools, allow: [...architect.tools.allow, narrate.key] } },
      narrator,
    ],
    toolSpecs: [...pair.toolSpecs, narrate],
    selected: agentNodeId(architect.key),
    chatWith: architect.key,
  };
}
