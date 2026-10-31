import { embeddingModelLimits } from '@theoremjs/agents';
import { DETECTOR_BOUNDARIES, DETECTORS } from '@theoremjs/agents/guardrails';
import {
  COMPACTION_DRAFT_DEFAULTS,
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
  newOwnDetector,
  newPattern,
  newSystemLine,
  type OwnDetectorDraft,
  type SlotDraft,
  type StudioDraft,
  setProfileType,
  type ToolSpecDraft,
} from '../draft.ts';
import type { ModelPicks } from '../lent-keys.ts';
import { firstServed } from '../policy.ts';
import {
  addAgent,
  agentNodeId,
  markAgentStart,
  type StudioWorkspace,
  workspaceFromDraft,
} from '../workspace.ts';
import {
  DEMO_ALLOWED_HOSTS,
  DEMO_ARCHITECT_TOOLS,
  DEMO_CONCIERGE_TOOLS,
  DEMO_CONSOLE_TOOLS,
  DEMO_RESEARCH_STAGE_READ_TOOLS,
  DEMO_RESEARCH_TOOLS,
  demoInputsSpec,
  demoToolSpecs,
  RESEARCH_ALLOWED_HOSTS,
} from './tools.ts';

/**
 * Where each cookbook's models start: Google's Flash models and TypeSafe's Jev, which free keys
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
      case 'transcription':
        return {
          ...firstServed('openrouter', type),
          apiId: 'mistralai/voxtral-mini-transcribe-3-0',
        };
      case 'text':
        return { ...firstServed('gemini', type), apiId: 'gemini-3.1-flash-lite' };
      case 'embedding':
        return { ...firstServed('gemini', type), apiId: 'gemini-embedding-2-preview' };
    }
  },
};

/** Public cognitive block (bonsai.thinker) plus private research standards (`{private: …}`). */
export const DEMO_RESEARCH_SYSTEM = `Role: Advanced reasoning engine for research on how language models keep, retrieve, and recombine context. You solve high-complexity, ambiguous, and multi-variable problems through deep first-principles analysis.

Cognitive Standards:
- First-Principles Decomposition: Reduce problems to foundational mechanics, physical laws, and core causal primitives. Do not rely on surface-level heuristics or rote pattern-matching.
- Adversarial Stress-Testing: Actively challenge initial assumptions. Explore competing hypotheses, edge cases, failure modes, and potential confounds before converging on a solution.
- Systems Dynamics: Model non-linear interactions, feedback loops, dependencies, and second-order consequences across variables.
- Epistemic Precision: Explicitly distinguish established empirical facts from logical deductions, probabilistic estimates, and speculative hypotheses. Calibrate confidence to available evidence.

Execution:
Provide thorough, exhaustive, and intellectually uncompromised reasoning. Prioritize causal clarity, mathematical/scientific validity, and deep insight over artificial brevity.

{private:
Standards:
- The newest work is often not indexed yet; one search is rarely enough.
- A claim rests on a primary source: the paper, the model card, the dataset card, the repository. A blog or a list is a lead to its primary source; DeepWiki answers are leads only.
- Quote exact words from what the tools returned. Say how sure you are, and what you could not check.
}`;

export const DEMO_CONCIERGE_SYSTEM = `Role: Elite, charismatic travel concierge.

Communication Standards:
- Readable Formatting: Use markdown where it helps the reader: short headings, bullet lists, bold for key names, and tables for side-by-side comparisons.
- Adaptive Pacing: Deliver high-signal, concise answers. Avoid overwhelming monologues; provide the immediate insight or recommendation first, then offer a natural next step.

Tool & Fact Grounding:
- Absolute Grounding: Ground all dynamic facts (weather, currency conversions, distances, geography, destination research) using available tools before answering. Never invent live data.
- Silent Execution: Never narrate tool calls, announce function names, or reference underlying APIs. Seamlessly integrate verified findings into your response.
- Complete Resolution: Execute multi-step tool chains silently to completion before delivering the synthesized answer.

Multimodal Understanding:
- Immediately extract actionable constraints (dates, flight times, locations, budgets) from provided images, documents, tickets, or audio, and weave them directly into your response.`;

export const DEMO_ARCHITECT_SYSTEM = `Role: Senior software architect who researches before advising.

Communication Standards:
- Readable Formatting: Use markdown where it helps the reader: short headings, bullet lists, code blocks for code, and tables for side-by-side comparisons.
- Answer First: Lead with the recommendation, then the reasons and the trade-offs. Name what you could not confirm.

Tool & Fact Grounding:
- Absolute Grounding: Ground claims about a library, a repository, a package version, or a cloud service in the tools before answering. Never invent an API, a version, or a default.
- Silent Execution: Never narrate tool calls or announce function names. Work findings into the answer.
- Complete Resolution: Finish multi-step research before you answer.

Audio briefings:
- When asked for a podcast, a briefing, or anything to listen to, write a short spoken script of what you found, in plain sentences with no markdown, and pass it to narrate. Then say in one line what the briefing covers.`;

const DEMO_LIVE_RESEARCH_SYSTEM = `Role: A research scout, on a call.

Speaking:
- Speak in short, natural sentences. No lists, no markdown, no reading out of URLs or ids unless asked.
- Give the finding first, then say where it came from.

Tool & Fact Grounding:
- Ground every claim about a paper, model, or dataset in the tools before you answer. Never invent one.
- Never name a tool or say that you are calling one.`;

export const DEMO_LIVE_CONCIERGE_SYSTEM = `Role: Elite, charismatic travel concierge, on a call.

Speaking:
- Speak in short, natural sentences. No lists, no markdown, no reading out of addresses, or codes unless asked.
- Give the recommendation first, then offer one next step.

Tool & Fact Grounding:
- Ground weather, currency, distances, and places in the tools before you answer. Never invent live data.
- Never name a tool or say that you are calling one.`;

/** The structured reply schema for `research.scout`. */
export const RESEARCH_REPLY_SCHEMA_ID = 'research.reply';

export const RESEARCH_REPLY_SCHEMA_JSON = JSON.stringify(
  {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'What the search found and how sure you are, in a few sentences.',
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['model', 'dataset', 'paper', 'repo', 'method'] },
            name: {
              type: 'string',
              description:
                'Its id as published: a Hub id, an arXiv id, owner/repo, or a short name.',
            },
            url: { type: 'string', description: 'Where it is published.' },
            what: {
              type: 'string',
              description:
                'What it is, in one sentence: architecture and size, or contents and size.',
            },
            why: {
              type: 'string',
              description:
                'Why it could help a model keep, retrieve, or recombine context: working memory, episodic memory, or a vector store.',
            },
            basis: {
              type: 'string',
              enum: ['page', 'lead', 'memory'],
              description:
                'page: a source a tool returned this turn; cite it. lead: DeepWiki or a hint not yet confirmed. memory: your own recall.',
            },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  uri: {
                    type: 'string',
                    description: 'URL of a page or paper a tool returned this turn.',
                  },
                  quote: {
                    type: 'string',
                    description:
                      'The exact words in what the tool returned that this candidate rests on.',
                  },
                },
                required: ['uri', 'quote'],
              },
            },
          },
          required: ['kind', 'name', 'url', 'what', 'why', 'basis', 'evidence'],
        },
      },
      searched: {
        type: 'array',
        items: { type: 'string' },
        description: 'The queries and sources you tried, including the empty ones.',
      },
      open: {
        type: 'array',
        items: { type: 'string' },
        description: 'Leads you could not follow, and what would settle them.',
      },
    },
    required: ['summary', 'candidates', 'searched', 'open'],
  },
  null,
  2,
);

const RESEARCH_MODELS_SCHEMA_ID = 'research.models';

/** `research.reply` when the focus is the Hub: its `candidates` hold one entry per model. */
function researchModelsSchemaJson(): string {
  const reply = JSON.parse(RESEARCH_REPLY_SCHEMA_JSON) as {
    properties: { candidates: { items: { properties: object; required: string[] } } };
  };
  const { candidates } = reply.properties;
  const model = {
    ...candidates.items,
    properties: {
      ...candidates.items.properties,
      kind: { type: 'string', enum: ['model'] },
      task: { type: 'string', description: 'The pipeline task the Hub lists for it.' },
      license: { type: 'string', description: 'Its license as the Hub lists it.' },
    },
    required: [...candidates.items.required, 'task', 'license'],
  };
  const properties = { ...reply.properties, candidates: { ...candidates, items: model } };
  return JSON.stringify({ ...reply, properties }, null, 2);
}

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
  (await import('../decision-example-images.ts')).DECISION_EXAMPLE_IMAGES;

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
 * a flag to match against, and plain questions about what is there.
 */
export async function createDecisionExampleDraft(): Promise<StudioDraft> {
  return decisionExampleDraft(await decisionImages());
}

/** The decision example with the pictures given: none for a page that only shows its shape. */
export function decisionExampleDraft(images: DecisionImageDraft[] = []): StudioDraft {
  const blank = createBlankDraft();
  const had = new Set(includableFacets(blank));
  const decision = setProfileType(blank, 'decision', EXAMPLE_PICKS);
  const draft = includableFacets(decision)
    .filter((facet) => !had.has(facet))
    .reduce(includeFacet, decision);
  const binding = draft.modelBindings[0];
  return {
    ...draft,
    identity: { ...draft.identity, agentId: DECISION_EXAMPLE_AGENT_ID, handle: 'pantry' },
    modelBindings: binding ? [{ ...binding, apiId: 'jev-1.14.0', options: { images: true } }] : [],
    decision: {
      ...draft.decision,
      contract: 'pantry.v1',
      questions: [
        { ...exampleQuestion('Ginger', 'box', 'Where is <ginger> in `photo`?'), image: 'photo' },
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
        {
          ...exampleQuestion('Union Jack', 'box', 'Which jar in `photo` matches <union_jack>?'),
          image: 'photo',
        },
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
 * reply repeats one the visitor asks about. Leak and address detectors keep the kernel defaults.
 */
const EXAMPLE_REPLY_BLOCK = [
  'ids',
  'financial',
  'credentials',
  'injection',
  'tool_instructions',
] as const;

function exampleDetect(detect: GuardrailsDraft['detect']): GuardrailsDraft['detect'] {
  const next = structuredClone(detect);
  for (const detector of EXAMPLE_REPLY_BLOCK) {
    for (const boundary of ['reply', 'reply_structured', 'live_reply'] as const) {
      if (DETECTOR_BOUNDARIES[detector].includes(boundary)) next[detector][boundary] = 'block';
    }
  }
  return next;
}

/** Every detector at every boundary it reads at set to `flag`, for an agent that reads untrusted pages. */
function flagAllDetect(detect: GuardrailsDraft['detect']): GuardrailsDraft['detect'] {
  const next = structuredClone(detect);
  for (const detector of DETECTORS) {
    for (const boundary of DETECTOR_BOUNDARIES[detector]) {
      if (next[detector][boundary] !== 'ignore') next[detector][boundary] = 'flag';
    }
  }
  return next;
}

/** The demo tools named, in the library's order. */
export function exampleTools(names: readonly string[]): ToolSpecDraft[] {
  const wanted = new Set(names);
  return demoToolSpecs()
    .filter((seed) => wanted.has(seed.data.toolName ?? ''))
    .map((seed) => defaultToolSpec(seed.data));
}

function defaultTextModelBindings(): StudioDraft['modelBindings'] {
  return [
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
  ];
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
    identity: { ...identity, profileType: 'text', conditionsJson: '', systemByRoleJson: '' },
    included: ['outputs', 'turnBehaviour', 'guardrails', 'observability', 'labels'],
    models: { defaultModel: 'open', allowModelSelect: true, maxSteps: 12, key: 'gemini' },
    modelBindings: defaultTextModelBindings(),
    ...tools,
    inputs: {
      text: inputs.text,
      attachmentsAccept: [...inputs.attachmentsAccept],
      voiceAccept: [...inputs.voiceAccept],
      maxFiles: inputs.maxFiles,
      maxBytes: inputs.maxBytes,
      maxTurnBytes: inputs.maxTurnBytes,
      limitsByMime: {},
      slots: [],
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

/** The agent id the research page-reader opens under. */
export const RESEARCH_PAGE_READER_AGENT_ID = 'research.pagereader';

/**
 * What the page-reader's questions are asked about: a research `question` and a
 * `passage` cut from a tool result — not the blank decision's tool-call stub.
 */
export const RESEARCH_PAGE_READER_STATE = JSON.stringify(
  {
    question:
      'What write path do recent systems use to store episodic memory for language-model agents?',
    passage:
      'MemGPT (Packer et al.) pages conversational history into an external store and reloads ' +
      'relevant spans on later turns, treating context as a virtual memory hierarchy rather than a single prompt window.',
  },
  null,
  2,
);

/** A research agent on Jev, which answers on the state it is given. */
function researchDecisionDraft(
  identity: Pick<StudioDraft['identity'], 'agentId' | 'handle'>,
  contract: string,
  questions: DecisionDraft['questions'],
): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'decision', EXAMPLE_PICKS);
  const binding = draft.modelBindings[0];
  return {
    ...draft,
    identity: { ...draft.identity, ...identity },
    models: { ...draft.models, key: 'typesafe' },
    modelBindings: binding
      ? [{ ...binding, apiId: 'jev-1.14.0', keySlot: 'typesafe', options: { images: true } }]
      : [],
    decision: { ...draft.decision, contract, questions },
  };
}

/** The decision page-reader (`research.pagereader`) that filters passages for `research.scout` at `post_tool`. */
export function createPageReaderExampleDraft(): StudioDraft {
  return researchDecisionDraft(
    { agentId: RESEARCH_PAGE_READER_AGENT_ID, handle: 'pagereader' },
    'research.page-passages.v1',
    [
      exampleQuestion(
        'passage',
        'choice',
        'Does `passage` state a fact a careful researcher would want when answering `question`, including facts that do not settle it and anything contradictory?',
        [
          ['relevant', 'The passage states such a fact.'],
          [
            'not_relevant',
            'The passage does not: it is about something else, or is only a heading, navigation, a reference or a list of links.',
          ],
        ],
      ),
    ],
  );
}

/** A standalone check: does a quote back the claim made from it. */
function createResearchJudgeDraft(): StudioDraft {
  return researchDecisionDraft(
    { agentId: 'research.judge', handle: 'judge' },
    'research.quote-check.v1',
    [
      exampleQuestion('backing', 'choice', 'Does `quote` back `claim`?', [
        ['backed', 'The quote states the claim, or something that plainly entails it.'],
        ['not_backed', 'The quote is about something else, or says less than the claim.'],
      ]),
    ],
  );
}

/** The agent `research.scout` compacts its history with. */
function createResearchCompactorDraft(): StudioDraft {
  return exampleTextDraft(
    {
      agentId: 'research.compactor',
      handle: 'compactor',
      system: [
        newSystemLine(
          'Summarise the research so far. Keep every source URL, every exact quote, and every open lead.',
        ),
      ],
    },
    { tools: { t2Loader: '', parallel: false }, toolSpecs: [] },
  );
}

/** The speech agent that reads `research.scout`'s findings as a podcast. */
function createResearchPodcastDraft(): StudioDraft {
  const draft = createNarratorExampleDraft();
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'research.podcast', handle: 'podcast' },
  };
}

/** The image agent that draws a paper's method. */
function createResearchIllustratorDraft(): StudioDraft {
  const draft = setProfileType(createBlankDraft(), 'image', EXAMPLE_PICKS);
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'research.illustrator', handle: 'illustrator' },
  };
}

/** Embeddings to rank abstracts by a question. It keeps no store. */
function createResearchEmbedderDraft(): StudioDraft {
  const draft = createGeminiEmbeddingExampleDraft();
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'research.embedder', handle: 'embedder' },
  };
}

/** The research scout on a call: the same tools, a live model, and an instruction for speech. */
function createResearchLiveDraft(): StudioDraft {
  const draft = setProfileType(createResearchScoutDraft(), 'live', EXAMPLE_PICKS);
  return {
    ...draft,
    identity: {
      ...draft.identity,
      agentId: 'research.scout.live',
      system: [newSystemLine(DEMO_LIVE_RESEARCH_SYSTEM)],
    },
  };
}

/** The scout's tools with no model, `read_pages` first, to call by hand. */
function createResearchConsoleDraft(): StudioDraft {
  const draft = createConsoleExampleDraft();
  const tools = exampleTools(DEMO_RESEARCH_TOOLS);
  return {
    ...draft,
    identity: { ...draft.identity, agentId: 'research.console' },
    toolSpecs: [
      ...tools.filter((tool) => tool.toolName === 'read_pages'),
      ...tools.filter((tool) => tool.toolName !== 'read_pages'),
    ],
  };
}

/** The research scout on its own: searches papers, models, datasets, repos, and docs. */
export function createResearchScoutDraft(): StudioDraft {
  const blank = createBlankDraft();
  const base = exampleTextDraft(
    {
      agentId: 'research.scout',
      handle: 'scout',
      system: [DEMO_RESEARCH_SYSTEM, ...RESEARCH_READER_LINES].map((line) => newSystemLine(line)),
    },
    { tools: { t2Loader: '', parallel: true }, toolSpecs: exampleTools(DEMO_RESEARCH_TOOLS) },
  );
  return {
    ...base,
    // Goals starts here: leave attachments and effort select off so examples earn them.
    inputs: {
      ...base.inputs,
      attachmentsAccept: [],
      voiceAccept: [],
      maxFiles: null,
      maxBytes: null,
      maxTurnBytes: null,
      slots: [researchFocusSlot(), researchReaderSlot()],
    },
    models: {
      defaultModel: 'open',
      allowModelSelect: true,
      maxSteps: 32,
      key: 'openrouter',
    },
    modelBindings: [
      defaultModelBinding({
        modelId: 'open',
        ...firstServed('openrouter', 'text'),
        apiId: 'openrouter/free',
        keySlot: 'openrouter',
        efforts: [
          { alias: 'normal', level: 'medium' },
          { alias: 'deep', level: 'high' },
        ],
        defaultEffort: 'normal',
        allowEffortSelect: false,
        summaries: true,
      }),
      defaultModelBinding({
        modelId: 'gemini',
        ...firstServed('gemini', 'text'),
        apiId: 'gemini-3.8-flash',
        keySlot: 'gemini',
        efforts: [
          { alias: 'normal', level: 'medium' },
          { alias: 'deep', level: 'high' },
        ],
        defaultEffort: 'normal',
        allowEffortSelect: false,
        summaries: true,
        builtInTools: ['googleSearch'],
      }),
    ],
    turnBehaviour: {
      ...base.turnBehaviour,
      resumeEnabled: true,
      allowContinue: [],
      autoContinue: ['length', 'stream_incomplete', 'provider_error'],
      maxContinues: 3,
      continueInstruction:
        'Your last reply was cut off before it finished. Continue from exactly where it stopped.',
      allowSteering: true,
      atStepLimit: 'answer',
    },
    outputs: {
      ...base.outputs,
      mode: 'structured',
      schemaId: RESEARCH_REPLY_SCHEMA_ID,
      schemaJson: RESEARCH_REPLY_SCHEMA_JSON,
      bySlot: {
        slot: 'focus',
        shapes: [
          {
            choice: RESEARCH_MODELS_FOCUS,
            schemaId: RESEARCH_MODELS_SCHEMA_ID,
            schemaJson: researchModelsSchemaJson(),
          },
        ],
      },
      streamMode: 'sse',
      streamThoughts: true,
      validationEnabled: true,
      maxRetries: 2,
      itemRules: { candidates: 'fix' },
    },
    guardrails: {
      ...blank.guardrails,
      detect: flagAllDetect(blank.guardrails.detect),
      allowedHosts: RESEARCH_ALLOWED_HOSTS.split(',').map((host) => host.trim()),
      // why: export_report writes, so a page the scout read can't steer what it saves.
      taintAfterRemoteRead: 'write',
      own: [researchRetractionDetector()],
    },
  };
}

/** What the scout adds to its system prompt for a reviewer or a student. */
const RESEARCH_READER_LINES = [
  'when reader is reviewer: The reader reviews papers. Lead with weak evidence and what would refute a claim.',
  'when reader is student: The reader is learning the field. Define each term the first time you use it.',
];

/** The focus that answers in `research.models`. */
const RESEARCH_MODELS_FOCUS = 'Hugging Face Open Research';

/** Where a turn looks first. */
function researchFocusSlot(): SlotDraft {
  return {
    key: draftKey('slot'),
    name: 'focus',
    label: 'Focus',
    choices: [RESEARCH_MODELS_FOCUS, 'arXiv', 'GitHub', 'Anywhere'].map((value) => ({
      key: draftKey('choice'),
      value,
      description: '',
    })),
  };
}

/** Who the scout writes for, which picks its lines in `RESEARCH_READER_LINES`. */
function researchReaderSlot(): SlotDraft {
  return {
    key: draftKey('slot'),
    name: 'reader',
    label: 'Reader',
    choices: ['anyone', 'reviewer', 'student'].map((value) => ({
      key: draftKey('choice'),
      value,
      description: '',
    })),
  };
}

/** Flags a page that says its paper was taken back. */
function researchRetractionDetector(): OwnDetectorDraft {
  const blank = newOwnDetector();
  return {
    ...blank,
    key: 'research.retraction',
    label: 'Retracted paper',
    at: { ...blank.at, tool_output_http: 'flag', tool_output_mcp: 'flag' },
    patterns: [
      {
        ...newPattern(),
        name: 'retraction',
        words: ['retracted', 'retraction notice', 'withdrawn by the authors'],
      },
    ],
  };
}

/**
 * Adds `research.pagereader` after `research.scout` and links the scout's page-reading tools
 * (`read_pages`, `read_model_card`, `read_dataset_card`, `read_readme`, `read_library_docs`) to it via `stageAgentKey`.
 */
function withPageReader(workspace: StudioWorkspace): StudioWorkspace {
  const scout = workspace.agents.at(-1);
  const pair = addAgent(workspace, createPageReaderExampleDraft());
  const reader = pair.agents.at(-1);
  if (!scout || !reader) return pair;
  const stageReadNames = new Set(DEMO_RESEARCH_STAGE_READ_TOOLS);
  const scoutAllowed = new Set(scout.tools.allow);
  return markAgentStart(
    {
      ...pair,
      toolSpecs: pair.toolSpecs.map((tool) =>
        scoutAllowed.has(tool.key) && stageReadNames.has(tool.toolName)
          ? { ...tool, stageAgentKey: reader.key }
          : tool,
      ),
      selected: agentNodeId(scout.key),
    },
    scout.key,
  );
}

/** Has `caller` compact its history with the agent last added. */
function withCompactor(workspace: StudioWorkspace, caller: string): StudioWorkspace {
  const compactWith = workspace.agents.at(-1)?.key;
  return {
    ...workspace,
    agents: workspace.agents.map((agent) =>
      agent.key === caller
        ? {
            ...agent,
            modelBindings: agent.modelBindings.map((binding) => ({
              ...binding,
              ...COMPACTION_DRAFT_DEFAULTS,
              compactTiming: 'before' as const,
              compactWith,
            })),
          }
        : agent,
    ),
  };
}

/** The page reader and the rest of the scout's team, added after the scout, which stays selected. */
function withResearchTeam(workspace: StudioWorkspace): StudioWorkspace {
  const scout = workspace.agents.at(-1);
  if (!scout) return workspace;
  const read = withPageReader(workspace);
  const summarised = withCompactor(addAgent(read, createResearchCompactorDraft()), scout.key);
  const voiced = withAgentTool(summarised, scout.key, createResearchPodcastDraft(), {
    toolName: 'record_podcast',
    description: 'Has the podcast agent read a script of the findings aloud and returns the audio.',
    activity: 'Recording the podcast',
    activityPast: 'Recorded the podcast',
  });
  const drawn = withAgentTool(voiced, scout.key, createResearchIllustratorDraft(), {
    toolName: 'draw_method',
    description: "Has the illustrator draw a paper's method and returns the image.",
    activity: 'Drawing the method',
    activityPast: 'Drew the method',
  });
  const team = [
    createResearchEmbedderDraft(),
    createResearchLiveDraft(),
    createResearchConsoleDraft(),
    createResearchJudgeDraft(),
  ].reduce(addAgent, drawn);
  return markAgentStart({ ...team, selected: agentNodeId(scout.key) }, scout.key);
}

/** The research scout and its team, added to a workspace. */
export function addResearchExample(workspace: StudioWorkspace): StudioWorkspace {
  return withResearchTeam(addAgent(workspace, createResearchScoutDraft()));
}

/** A workspace of the research scout and its team, with the scout in the chat. */
export function createResearchWorkspace(): StudioWorkspace {
  return withResearchTeam(workspaceFromDraft(createResearchScoutDraft()));
}

/** A fresh copy of the travel concierge draft: a text agent with the tools a trip needs. */
export function createExampleDraft(): StudioDraft {
  return exampleTextDraft(
    {
      agentId: 'travel.concierge',
      handle: 'concierge',
      system: [newSystemLine(DEMO_CONCIERGE_SYSTEM)],
    },
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
      system: [newSystemLine(DEMO_LIVE_CONCIERGE_SYSTEM)],
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
    {
      agentId: 'code.architect',
      handle: 'architect',
      system: [newSystemLine(DEMO_ARCHITECT_SYSTEM)],
    },
    { tools: { t2Loader: '', parallel: false }, toolSpecs: exampleTools(DEMO_ARCHITECT_TOOLS) },
  );
}

/** Adds `draft` as an agent, and an agent tool that lets `caller` run it, leaving `caller` selected. */
function withAgentTool(
  workspace: StudioWorkspace,
  caller: string,
  draft: StudioDraft,
  tool: Pick<ToolSpecDraft, 'toolName' | 'description' | 'activity' | 'activityPast'>,
): StudioWorkspace {
  const pair = addAgent(workspace, draft);
  const called = pair.agents.at(-1);
  if (!called) return pair;
  const taken = pair.toolSpecs.map((spec) => spec.toolName);
  const spec = defaultToolSpec({
    ...tool,
    toolName: freeName(tool.toolName, taken, (n) => `${tool.toolName}_${n}`),
    toolType: 'agent',
    agentKey: called.key,
    category: 'demo',
  });
  return {
    ...pair,
    agents: pair.agents.map((agent) =>
      agent.key === caller
        ? { ...agent, tools: { ...agent.tools, allow: [...agent.tools.allow, spec.key] } }
        : agent,
    ),
    toolSpecs: [...pair.toolSpecs, spec],
    selected: agentNodeId(caller),
  };
}

/**
 * Adds the narrator after the workspace's last agent, the architect, and the `narrate` agent tool
 * that lets the architect call it. The architect is left selected.
 */
function withNarrator(workspace: StudioWorkspace): StudioWorkspace {
  const architect = workspace.agents.at(-1);
  if (!architect) return workspace;
  // The architect starts with `narrate` allowed, so a reset keeps the two linked.
  return markAgentStart(
    withAgentTool(workspace, architect.key, createNarratorExampleDraft(), {
      toolName: 'narrate',
      description: 'Has the narrator read a script aloud and returns the audio.',
      activity: 'Recording the briefing',
      activityPast: 'Recorded the briefing',
    }),
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

export type CookbookId =
  | 'research'
  | 'concierge'
  | 'architect'
  | 'live-concierge'
  | 'decision'
  | 'gemini-embedding-2'
  | 'narrator'
  | 'console';

/**
 * Searchable pieces a cookbook recipe includes. Closed for chips and search.
 * The cookbook screen shows the build kind (`system` → multi-agent, `agent` →
 * agent) plus a short slice of these, with the rest collapsed as `+N`.
 */
export type CookbookIncludeTag =
  | 'text'
  | 'decision'
  | 'live'
  | 'speech'
  | 'embedding'
  | 'host'
  | 'http-tools'
  | 'mcp-tools'
  | 'agent-tools'
  | 'function-tools'
  | 'guardrails'
  | 'post-tool';

/** Tags the cookbook screen and search project; do not invent chips in the UI. */
export interface CookbookTags {
  includes: readonly CookbookIncludeTag[];
}

export interface CookbookEntry {
  id: CookbookId;
  kind: 'agent' | 'system';
  /** Short phrase that grounds the recipe on the cookbook screen (e.g. verified research). */
  verb: string;
  label: string;
  description: string;
  tags: CookbookTags;
  /**
   * What this recipe actually demonstrates in its workspace — for MCP paste briefs.
   * Only patterns present in the draft; do not invent.
   */
  teaches: readonly string[];
  question?: string;
  createWorkspace: () => StudioWorkspace | Promise<StudioWorkspace>;
  addToWorkspace: (workspace: StudioWorkspace) => StudioWorkspace | Promise<StudioWorkspace>;
}

const addsDraft =
  (draft: () => StudioDraft | Promise<StudioDraft>) =>
  async (workspace: StudioWorkspace): Promise<StudioWorkspace> =>
    addAgent(workspace, await draft());

const workspaceOf =
  (draft: () => StudioDraft | Promise<StudioDraft>) => async (): Promise<StudioWorkspace> =>
    workspaceFromDraft(await draft());

export const RESEARCH_FIRST_TURN_PROMPT =
  'Find recent papers, models, or datasets on episodic memory, vector-space memory stores, and context recombination for language models, and quote the exact claims from their cards or abstracts.';

/** The canonical cookbook catalog, ordered with `research` first, `concierge` second, `architect` third. */
export const COOKBOOKS: Readonly<Record<CookbookId, CookbookEntry>> = {
  research: {
    id: 'research',
    kind: 'system',
    verb: 'every quote checked',
    label: 'Research scout',
    description:
      'Ask a hard question about models, papers, or memory. It searches the Hub, arXiv, and GitHub, cuts each page to the passages that bear on the question, and will not let a quote through unchecked.',
    tags: {
      includes: [
        'text',
        'decision',
        'embedding',
        'speech',
        'live',
        'host',
        'http-tools',
        'mcp-tools',
        'agent-tools',
        'function-tools',
        'guardrails',
        'post-tool',
      ],
    },
    teaches: [
      'A multi-agent system: text agent `research.scout` plus decision agent `research.pagereader` (Jev).',
      'One agent of each type around it: `research.compactor` (text), `research.podcast` (speech), `research.illustrator` (image), `research.embedder` (embedding), `research.scout.live` (live), `research.console` (host), and `research.judge` (decision).',
      'A reply shaped by what the turn states: `focus` picks `research.models` or `research.reply` through `outputs.structured.by`.',
      'Call order the model chooses: a tool with `after` runs once the tools it names in the same step have settled.',
      'A write tool (`export_report`) that `taintAfterRemoteRead` refuses once a page has been read, and a tool the page answers (`check_device`).',
      'One custom detector, `research.retraction`, and a prompt line for each `reader` through a `when` line.',
      'Staging page-read tools at `post_tool` via `stageAgentKey`: `read_pages`, `read_model_card`, `read_dataset_card`, `read_readme`, and `read_library_docs` are filtered by the page-reader before the scout sees them.',
      'Parallel tool calls (`tools.parallel: true`) across HTTP tools (arXiv, GitHub, Hub cards) and MCP tools (Exa `search_web` / `read_pages`, Context7 library docs, DeepWiki `ask_repo_docs`).',
      'Guardrails that flag every detector on untrusted page text, with `allowedHosts` limited to the research hosts.',
      'Turn behaviour with resume, auto-continue on length / stream_incomplete / provider_error, and steering.',
    ],
    question: RESEARCH_FIRST_TURN_PROMPT,
    createWorkspace: createResearchWorkspace,
    addToWorkspace: addResearchExample,
  },
  concierge: {
    id: 'concierge',
    kind: 'agent',
    verb: 'travel from the facts',
    label: 'Travel concierge',
    description:
      'Hand it a destination, a ticket, or a photo of your boarding pass. It checks weather, places, and currency before it plans — and never invents a forecast.',
    tags: {
      includes: ['text', 'http-tools', 'mcp-tools', 'function-tools', 'guardrails'],
    },
    teaches: [
      'A text agent that takes attachments (images, PDF, text) and optional voice, then grounds weather, places, and currency in tools before it answers.',
      'A turn-time tool loader (`t2Loader: discover_tools`) that can pull in extra demo tools during the turn.',
      'Mixing HTTP tools (geocode, weather, currency, Wikipedia), MCP (`search_web`), and local function tools (distances, day plan, packing, budget).',
      'Silent tool use in the system prompt: no narrating tool names; findings land in the reply.',
      'Reply-side detect set to block sensitive and injection phrasing, with `allowedHosts` for the travel hosts.',
    ],
    createWorkspace: workspaceOf(createExampleDraft),
    addToWorkspace: addsDraft(createExampleDraft),
  },
  architect: {
    id: 'architect',
    kind: 'system',
    verb: 'advise from the repo',
    label: 'Code architect',
    description:
      'Point it at a repository or a library. It reads the docs and the code before it advises, then can send a Narrator to record a short spoken briefing of what it found.',
    tags: {
      includes: ['text', 'speech', 'http-tools', 'mcp-tools', 'agent-tools', 'guardrails'],
    },
    teaches: [
      'A multi-agent system: text agent `code.architect` plus speech agent `studio.narrator`.',
      'An agent tool (`narrate`) that lets the architect call the narrator and get audio back.',
      'Grounding advice in repo and package tools before answering (`ask_repo_docs`, `read_repo_file`, `lookup_package`, Context7 `find_library` / `read_library_docs`).',
      'Vendor docs over MCP (Microsoft, Cloudflare, AWS, Hugging Face, Astro) alongside web search.',
      'A speech profile with a fixed spoken style for briefings.',
    ],
    createWorkspace: createArchitectWorkspace,
    addToWorkspace: addArchitectExample,
  },
  'live-concierge': {
    id: 'live-concierge',
    kind: 'agent',
    verb: 'travel on the call',
    label: 'Live concierge',
    description:
      'The same concierge, on a voice call. It still grounds weather, places, and money in the tools — it just answers out loud, in short sentences.',
    tags: {
      includes: ['live', 'http-tools', 'mcp-tools', 'function-tools', 'guardrails'],
    },
    teaches: [
      'The travel concierge tools on a `live` profile instead of text.',
      'Spoken replies: short sentences, no markdown lists, still grounded in the same weather / places / currency tools.',
    ],
    createWorkspace: workspaceOf(createLiveExampleDraft),
    addToWorkspace: addsDraft(createLiveExampleDraft),
  },
  decision: {
    id: 'decision',
    kind: 'agent',
    verb: 'ask the photograph',
    label: 'Pantry',
    description:
      'Show Jev a pantry shelf. It draws boxes around what it finds and answers brunch questions from what is actually there — not from what it remembers.',
    tags: {
      includes: ['decision', 'guardrails'],
    },
    teaches: [
      'A `decision` profile on TypeSafe Jev 1.14 with `images: true`.',
      'Question kinds in one contract (`pantry.v1`): `box`, `noul`, and `choice`.',
      'State image `photo` (the shelf) plus decision-owned reference images (`<ginger>`, `<apple_ripeness>`, `<union_jack>`) named from questions.',
      'Box questions that locate things in `photo` or on a reference chart; choice for brunch from what is on the shelf.',
    ],
    createWorkspace: workspaceOf(createDecisionExampleDraft),
    addToWorkspace: addsDraft(createDecisionExampleDraft),
  },
  'gemini-embedding-2': {
    id: 'gemini-embedding-2',
    kind: 'agent',
    verb: 'embed what you see',
    label: 'Gemini Embeddings 2',
    description:
      'Drop in text, images, or files. Gemini Embeddings 2 turns them into vectors you can search and compare — multimodal, on the free preview.',
    tags: {
      includes: ['embedding'],
    },
    teaches: [
      'An `embedding` profile on Gemini Embeddings 2 preview.',
      'Multimodal inputs: every media kind that model accepts, capped at six files.',
      'Output dimensionality set on the binding (`outputDimensionality: 768`).',
    ],
    createWorkspace: workspaceOf(createGeminiEmbeddingExampleDraft),
    addToWorkspace: addsDraft(createGeminiEmbeddingExampleDraft),
  },
  narrator: {
    id: 'narrator',
    kind: 'agent',
    verb: 'hear the briefing',
    label: 'Narrator',
    description:
      'Give it a short script in plain sentences. It reads the briefing aloud — warm, unhurried, as if it were speaking to one listener.',
    tags: {
      includes: ['speech', 'guardrails'],
    },
    teaches: [
      'A standalone `speech` profile with guardrails included.',
      'A fixed speech style string for how the briefing should sound.',
    ],
    createWorkspace: workspaceOf(createNarratorExampleDraft),
    addToWorkspace: addsDraft(createNarratorExampleDraft),
  },
  console: {
    id: 'console',
    kind: 'agent',
    verb: 'tools, no model',
    label: 'Tool console',
    description:
      'No language model in the loop. Press a tool, watch the result — HTTP, MCP, and functions side by side, for when you want the wiring without the chat.',
    tags: {
      includes: ['host', 'http-tools', 'mcp-tools', 'function-tools'],
    },
    teaches: [
      'A `host` profile with no model — tools only.',
      'A small set of demo tools spanning HTTP and other result shapes, run by hand from the console.',
    ],
    createWorkspace: workspaceOf(createConsoleExampleDraft),
    addToWorkspace: addsDraft(createConsoleExampleDraft),
  },
};

export const COOKBOOK_IDS = Object.keys(COOKBOOKS) as readonly CookbookId[];
