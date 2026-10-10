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
  freeName,
  includableFacets,
  type GuardrailsDraft,
  includeFacet,
  type StudioDraft,
  setProfileType,
  type ToolSpecDraft,
} from './draft.ts';
import { addAgent, agentNodeId, markAgentStart, type StudioWorkspace, workspaceFromDraft } from './workspace.ts';
import { GEMINI_STUDIO_DEFAULT_API_ID, OPENROUTER_DECISION_MODELS, OPENROUTER_STUDIO_API_ID } from './policy.ts';

/**
 * A tool-call safety decision on TypeSafe's Jev: the draft a blank agent becomes when its type is
 * set to decision, with every section that type brings, named so it runs as it opens.
 */
export function createDecisionExampleDraft(): StudioDraft {
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
export function createSpanExampleDraft(): StudioDraft {
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

/** A text agent on the studio's models, with the example's inputs and guardrails. */
function exampleTextDraft(
  identity: Pick<StudioDraft['identity'], 'agentId' | 'handle' | 'system'>,
  tools: Pick<StudioDraft, 'tools' | 'toolSpecs'>,
): StudioDraft {
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
        apiId: GEMINI_STUDIO_DEFAULT_API_ID,
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
        apiId: OPENROUTER_STUDIO_API_ID,
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
export function createExampleDraft(): StudioDraft {
  return exampleTextDraft(
    { agentId: 'travel.concierge', handle: 'concierge', system: DEMO_CONCIERGE_SYSTEM },
    { tools: { t2Loader: 'discover_tools' }, toolSpecs: exampleTools(DEMO_CONCIERGE_TOOLS) },
  );
}

/** The travel concierge on a call: the same tools, a live model and an instruction for speech. */
export function createLiveExampleDraft(): StudioDraft {
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
export function createNarratorExampleDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'speech');
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'studio.narrator', handle: 'narrator' },
    speech: { ...draft.speech, style: 'Warm and unhurried, like a podcast host talking to one listener.' },
  };
}

/** A host with no model: a few demo tools, one of each kind of result. */
export function createConsoleExampleDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'host');
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'tools.console' },
    toolSpecs: exampleTools(DEMO_CONSOLE_TOOLS),
  };
}

/** The code architect on its own: the code and docs tools, before the narrator joins it. */
function architectDraft(): StudioDraft {
  return exampleTextDraft(
    { agentId: 'code.architect', handle: 'architect', system: DEMO_ARCHITECT_SYSTEM },
    { tools: { t2Loader: '' }, toolSpecs: exampleTools(DEMO_ARCHITECT_TOOLS) },
  );
}

/**
 * Adds the narrator after the workspace's last agent, the architect, and the `narrate` agent tool
 * that lets the architect call it. The architect is left selected.
 */
function withNarrator(workspace: StudioWorkspace): StudioWorkspace {
  const architect = workspace.agents.at(-1);
  const pair = addAgent(workspace, createNarratorExampleDraft());
  const narrator = pair.agents.at(-1);
  if (!architect || !narrator) return pair;
  const taken = pair.toolSpecs.map((tool) => tool.toolName);
  const narrate = defaultToolSpec({
    toolName: freeName('narrate', taken, (n) => `narrate_${n}`),
    toolType: 'agent',
    agentKey: narrator.key,
    description: 'Has the narrator read a script aloud and returns the audio.',
    activity: 'Recording the briefing',
    activityPast: 'Recorded the briefing',
    category: 'demo',
  });
  // The architect starts with `narrate` allowed, so a reset keeps the two linked.
  return markAgentStart(
    {
      ...pair,
      agents: pair.agents.map((agent) =>
        agent.key === architect.key
          ? { ...agent, tools: { ...agent.tools, allow: [...agent.tools.allow, narrate.key] } }
          : agent,
      ),
      toolSpecs: [...pair.toolSpecs, narrate],
      selected: agentNodeId(architect.key),
    },
    architect.key,
  );
}

/** The code architect and the narrator it calls, added to a workspace that keeps its other agents. */
export function addArchitectExample(workspace: StudioWorkspace): StudioWorkspace {
  return withNarrator(addAgent(workspace, architectDraft()));
}

/** A workspace of the code architect and its narrator, with the architect in the chat. */
export function createArchitectWorkspace(): StudioWorkspace {
  return withNarrator(workspaceFromDraft(architectDraft()));
}
