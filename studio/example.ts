import { embeddingModelLimits } from '@theoremjs/agents';
import { DETECTOR_BOUNDARIES, DETECTORS } from '@theoremjs/agents/guardrails';
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
import {
  createBlankDraft,
  type DecisionDraft,
  type DecisionImageDraft,
  defaultModelBinding,
  defaultToolSpec,
  draftKey,
  freeName,
  type GuardrailsDraft,
  includableFacets,
  includeFacet,
  type StudioDraft,
  setProfileType,
  type ToolSpecDraft,
} from './draft.ts';
import type { ModelPicks } from './lent-keys.ts';
import { firstServed } from './policy.ts';
import {
  addAgent,
  agentNodeId,
  markAgentStart,
  type StudioWorkspace,
  workspaceFromDraft,
} from './workspace.ts';

/**
 * Where each example's models start: Google's Flash models and TypeSafe's Jev, which free keys
 * run. The examples list no models, so a type switch keeps whatever the kernel says serves the
 * new type.
 */
const EXAMPLE_PICKS: ModelPicks = {
  models: () => [],
  start: (type) => {
    switch (type) {
      case 'decision':
        return { ...firstServed('typesafe', type), apiId: 'jev-latest' };
      case 'live':
        return { ...firstServed('gemini', type), apiId: 'gemini-3.1-flash-live-preview' };
      case 'speech':
        return { ...firstServed('gemini', type), apiId: 'gemini-3.1-flash-tts-preview' };
      case 'image':
        return { ...firstServed('gemini', type), apiId: 'gemini-3.1-flash-lite-image' };
      case 'text':
        return { ...firstServed('gemini', type), apiId: 'gemini-3.1-flash-lite' };
      case 'embedding':
        return { ...firstServed('gemini', type), apiId: 'gemini-embedding-2-preview' };
    }
  },
};

/** The agent id the decision example opens under; its run starts with the pantry's state and pictures. */
export const DECISION_EXAMPLE_AGENT_ID = 'pantry.jev';

/** What the decision example's questions are asked about: the shelf, and why we ask. */
export const DECISION_EXAMPLE_STATE = JSON.stringify(
  {
    photo: '<pantry_shelf>',
    note: 'Friends are coming round for brunch.',
  },
  null,
  2,
);

/** The example's pictures, which load only when the example is made: they are most of its weight. */
const exampleImages = async () =>
  (await import('./decision-example-images.ts')).DECISION_EXAMPLE_IMAGES;

/** The picture the decision example's state starts with, by the reference it writes: the shelf. */
export async function decisionExampleAssets() {
  const { '<pantry_shelf>': shelf } = await exampleImages();
  return { '<pantry_shelf>': shelf };
}

/** The example's own pictures, sent with every decision: the ginger, the colour chart and the flag its questions name. */
async function decisionImages(): Promise<DecisionImageDraft[]> {
  const { '<pantry_shelf>': _shelf, ...fixed } = await exampleImages();
  return Object.entries(fixed).map(([reference, image]) => ({
    key: draftKey('image'),
    name: reference.slice(1, -1),
    ...image,
  }));
}

type ExampleQuestion = DecisionDraft['questions'][number];

function exampleQuestion(
  id: string,
  type: ExampleQuestion['type'],
  instructions: string,
  options: readonly (readonly [string, string])[] = [],
): ExampleQuestion {
  return {
    key: draftKey('question'),
    id,
    type,
    instructions,
    criteria: options.map(([label, text]) => ({ key: draftKey('criterion'), label, text })),
  };
}

/**
 * A look at a pantry shelf on TypeSafe's Jev 1.14: boxes around what it finds, a colour chart and
 * a flag to match against, and plain questions about what is there. The draft a blank agent becomes
 * when its type is set to decision, with every section that type brings, and the pictures ship with
 * it, so it runs as it opens.
 */
export async function createDecisionExampleDraft(): Promise<StudioDraft> {
  const images = await decisionImages();
  const blank = createBlankDraft();
  const had = new Set(includableFacets(blank));
  const decision = setProfileType(blank, 'decision', EXAMPLE_PICKS);
  const draft = includableFacets(decision)
    .filter((facet) => !had.has(facet))
    .reduce(includeFacet, decision);
  const binding = draft.modelBindings[0];
  return {
    ...draft,
    identity: { ...draft.identity, agentId: DECISION_EXAMPLE_AGENT_ID, handle: 'jev' },
    modelBindings: binding ? [{ ...binding, apiId: 'jev-1.14.0', options: { images: true } }] : [],
    decision: {
      ...draft.decision,
      contract: 'pantry.v1',
      questions: [
        exampleQuestion('Ginger', 'box', 'Where is <ginger> in `photo`?'),
        exampleQuestion('Something to drink', 'noul', "There's something to drink in `photo`."),
        exampleQuestion('Fruit salad', 'noul', 'Do we have what we need for a fruit salad?'),
        {
          ...exampleQuestion(
            'Where the green apple lands on the chart',
            'box',
            'Where on <apple_ripeness> would the green apple in `photo` sit?',
          ),
          image: '<apple_ripeness>',
        },
        exampleQuestion('Bread on the shelf', 'noul', 'Does the shelf have bread?'),
        exampleQuestion('Union Jack', 'box', 'Which jar in `photo` matches <union_jack>?'),
        exampleQuestion('Brunch', 'choice', 'What can we make for brunch from `photo`?', [
          ['toast', 'Toast with a spread.'],
          ['fruit', 'A bowl of fruit.'],
          ['shop', 'Nothing yet. Someone goes to the shop.'],
        ]),
      ],
      images,
    },
  };
}

/** A tool-call safety decision using the free Span model and its Number question shape. */
export function createSpanExampleDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'decision', EXAMPLE_PICKS);
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'guardrails.tool_call.span', handle: 'span' },
    modelBindings: [
      {
        ...draft.modelBindings[0],
        ...firstServed('openrouter', 'decision'),
        apiId: 'respan/span-01-lite:free',
      },
    ],
    decision: {
      ...draft.decision,
      questions: [
        {
          key: draftKey('question'),
          id: 'verdict',
          type: 'noul',
          instructions: 'Is this tool call unsafe or beyond what the user asked for?',
          criteria: [
            {
              key: draftKey('criterion'),
              label: 'true',
              text: 'The call is unsafe or beyond the user request.',
            },
            {
              key: draftKey('criterion'),
              label: 'false',
              text: 'The call is safe and within the user request.',
            },
          ],
        },
      ],
    },
  };
}

const GEMINI_EMBEDDING = {
  protocol: firstServed('gemini', 'embedding').protocol,
  apiId: 'gemini-embedding-2-preview',
};

/** A multimodal embedding profile using Gemini Embeddings 2's free preview model, taking every file type it does. */
export function createGeminiEmbeddingExampleDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'embedding', EXAMPLE_PICKS);
  const binding = draft.modelBindings[0];
  return {
    ...draft,
    identity: {
      ...draft.identity,
      agentId: 'studio.gemini-embeddings-2',
      handle: 'embeddings',
    },
    models: {
      ...draft.models,
      defaultModel: binding?.modelId ?? '',
      key: 'gemini',
    },
    modelBindings: binding
      ? [
          {
            ...binding,
            provider: 'gemini',
            protocol: GEMINI_EMBEDDING.protocol,
            apiId: GEMINI_EMBEDDING.apiId,
            options: { outputDimensionality: 768 },
          },
        ]
      : [],
    inputs: {
      ...draft.inputs,
      text: true,
      attachmentsAccept: (embeddingModelLimits(GEMINI_EMBEDDING)?.media ?? []).flatMap((kind) => [
        ...kind.accept,
      ]),
      // why: the most media Gemini Embedding 2 takes in one input is 6 images.
      maxFiles: 6,
      maxBytes: 10_000_000,
      maxTurnBytes: 10_000_000,
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
    included: ['outputs', 'turnBehaviour', 'guardrails', 'observability', 'labels'],
    models: { defaultModel: 'smart', allowModelSelect: true, maxSteps: 12, key: 'gemini' },
    modelBindings: [
      defaultModelBinding({
        modelId: 'fast',
        ...firstServed('gemini', 'text'),
        apiId: 'gemini-3.1-flash-lite',
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
        ...firstServed('gemini', 'text'),
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
        ...firstServed('openrouter', 'text'),
        apiId: 'openrouter/free',
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
    {
      tools: { t2Loader: 'discover_tools', parallel: false },
      toolSpecs: exampleTools(DEMO_CONCIERGE_TOOLS),
    },
  );
}

/** The travel concierge on a call: the same tools, a live model, and an instruction for speech. */
export function createLiveExampleDraft(): StudioDraft {
  const draft = setProfileType(createExampleDraft(), 'live', EXAMPLE_PICKS);
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
  const draft = includeFacet(
    setProfileType(createBlankDraft(), 'speech', EXAMPLE_PICKS),
    'guardrails',
  );
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'studio.narrator', handle: 'narrator' },
    speech: {
      ...draft.speech,
      style: 'Warm and unhurried, like a podcast host talking to one listener.',
    },
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
    { tools: { t2Loader: '', parallel: false }, toolSpecs: exampleTools(DEMO_ARCHITECT_TOOLS) },
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
