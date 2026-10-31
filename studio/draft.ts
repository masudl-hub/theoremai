/**
 * Every section is always present so switching profile type keeps what the author typed.
 * "Provider default" numbers are `null` and booleans hold the value the kernel would resolve,
 * so compile emits a field only when it differs.
 */

import {
  type LabelKey,
  liveIngressChannelDefault,
  profileAllowsInject,
  resolveGuardrailPolicy,
} from '@theoremjs/agents';
import {
  type BlockedReplyOnBlock,
  BOUNDARIES,
  type Boundary,
  DETECTORS,
  type DestinationGate,
  type DetectAction,
  type Detector,
  detects,
  PATTERN_DETECTORS,
  recordOf,
  type TaintGate,
  type UrlDetector,
} from '@theoremjs/agents/guardrails';
import {
  CONTINUE_INSTRUCTION_TYPES,
  type JsonObject,
  mimeAllowed,
  type ProfileItemRule,
  type ProviderLimits,
  profileTypesForField,
} from '@theoremjs/agents/kernel';
import { resolveObservabilityPolicy, type ScrubSwitch } from '@theoremjs/agents/observability';
import {
  type CompactionMeter,
  type CompactionTiming,
  type ContextSender,
  type ContinueStopKind,
  IMAGE_ATTACHMENT_ACCEPT_MIMES,
  type KeySlot,
  type LiveActivityHandling,
  type LiveEndSensitivity,
  type LiveStartSensitivity,
  PROFILE_GRAPH,
  PROFILE_TYPES,
  type ProfileGraphFacetId,
  type ProfileType,
  type SpeechAudioFormat,
  type StepLimitMode,
  type StreamMode,
  type ThinkingLevel,
  TOOL_ACCESS,
  TOOL_LOAD_TIERS,
  TOOL_PERMISSION,
} from '@theoremjs/agents/schema';
import type { ModelPicks, ModelProfileType, ModelStart } from './lent-keys.ts';
import { isGoogleRoute, STUDIO_TRACE_DESTINATION, startingBinding } from './policy.ts';
import {
  modelRoute,
  STUDIO_PROVIDERS,
  type StudioProvider,
  servesProfileType,
} from './providers.ts';
import { keySlotUnset } from './requirements.ts';
import { DEFAULT_TOOL_INPUT_SCHEMA, DEFAULT_TOOL_OUTPUT_SCHEMA } from './tool-schema.ts';
import type { StudioToolSpecSeed } from './types.ts';

export type StudioProfileType = ProfileType;

/** The types that run a model turn; a decision asks questions, and a host runs its tools. */
export type StudioTurnProfileType = Exclude<StudioProfileType, 'decision' | 'host'>;

export const STUDIO_PROFILE_TYPES: readonly StudioProfileType[] = PROFILE_TYPES;

/** One line of the prompt, with private sections wrapped as `{private: …}`. */
export interface SystemLineDraft {
  key: string;
  text: string;
}

export interface IdentityDraft {
  agentId: string;
  profileType: StudioProfileType | '';
  handle: string;
  /** Unused on speech, which has no system channel. */
  system: SystemLineDraft[];
  /** The facts each turn states, as a JSON object of lists of values; blank omits them. */
  conditionsJson: string;
}

export interface ModelsDraft {
  /** Who holds the conversation a saved state continues; unset is the kernel's default, the host. */
  providerHistory?: 'host' | 'stateless' | 'provider';
  defaultModel: string;
  allowModelSelect: boolean;
  /** `null` omits it: the kernel's default cap applies. */
  maxSteps: number | null;
  /** The vault slot every model uses unless it names its own. */
  key: KeySlot | '';
  /** The slot a quota refusal retries on once; `''` or absent names none. */
  fallbackKey?: KeySlot | '';
}

export interface EffortDraft {
  alias: string;
  level: ThinkingLevel;
}

export interface ModelBindingDraft {
  /** Stable draft key; the model id is editable, so it cannot be the key. */
  key: string;
  modelId: string;
  /** The API shape it is spoken to in, by the id of a protocol its provider serves. */
  protocol: string;
  /** The provider that serves it, by the id one of the draft's `providers` has. */
  provider: string;
  apiId: string;
  /** What its protocol takes beyond the shared settings, as the protocol's own schema reads them. */
  options: JsonObject;
  /** Decision request timeout; `null` uses the studio timeout. */
  timeoutMs: number | null;
  /** Theorem's cut-offs for its calls; one `null` or absent is no limit. */
  limits?: { [K in keyof ProviderLimits]?: number | null };
  efforts: EffortDraft[];
  defaultEffort: string;
  allowEffortSelect: boolean;
  /** Thought summaries: on, off, or `null` to leave it to the provider. */
  summaries: boolean | null;
  maxOutputTokens: number | null;
  temperature: number | null;
  builtInTools: string[];
  /** This model's own vault slot; `''` or absent uses the profile's. */
  keySlot?: KeySlot | '';
  /** This model's own fallback slot; `''` or absent uses the profile's. */
  fallbackKeySlot?: KeySlot | '';
  /** When the agent compacts its own history; `''` or absent leaves compaction off. Text only. */
  compactTiming?: CompactionTiming | '';
  /** The token budget `compactAt` is a fraction of. */
  compactMaxTokens?: number | null;
  /** The fraction of the budget, between 0 and 1, at which compaction starts. */
  compactAt?: number;
  /** Recent history kept word for word: exchanges, a fraction of the budget, or 0 for none. */
  compactKeep?: number | null;
  /** What counts toward the budget; `''` or absent is history. */
  compactMeter?: CompactionMeter | '';
  /** The workspace agent that writes the summary, by key; `''` or absent: this agent. */
  compactWith?: string;
}

/** A model's limits, in the kernel's order, with each row's label and units. */
export const MODEL_LIMITS = [
  { name: 'operationTimeoutMs', label: 'Call timeout', units: 'ms', isTimer: true },
  { name: 'connectTimeoutMs', label: 'Connect timeout', units: 'ms', isTimer: true },
  { name: 'liveStepTimeoutMs', label: 'Live step timeout', units: 'ms', isTimer: true },
  { name: 'maxWireRecordBytes', label: 'Wire record', units: 'bytes', isTimer: false },
  { name: 'maxWireResponseBytes', label: 'Wire response', units: 'bytes', isTimer: false },
  { name: 'maxEventBytes', label: 'Event', units: 'bytes', isTimer: false },
  { name: 'maxStepBytes', label: 'Step', units: 'bytes', isTimer: false },
  { name: 'maxStepEvents', label: 'Step events', units: 'events', isTimer: false },
  { name: 'maxPendingToolCalls', label: 'Tool calls', units: 'calls', isTimer: false },
] as const satisfies readonly {
  name: keyof ProviderLimits;
  label: string;
  units: string;
  isTimer: boolean;
}[];

/** The longest a timer runs: the most a JavaScript timer takes, in ms. */
export const TIMER_MAX_MS = 2_147_483_647;

/** Where compaction starts when a builder turns it on; every number stays theirs to change. */
export const COMPACTION_DRAFT_DEFAULTS = {
  compactMaxTokens: 32_000,
  compactAt: 0.75,
  compactKeep: 4,
} as const satisfies Partial<ModelBindingDraft>;

export interface ToolsDraft {
  /** Function tool that promotes T2 tools; empty omits it. */
  t2Loader: string;
  /** True: a step's calls run side by side. False omits it: one at a time. */
  parallel: boolean;
}

/** One custom tool: compiles to `registerTool` plus a `tools.allow` entry. */
export interface ToolSpecDraft extends StudioToolSpecSeed {
  key: string;
}

/** One value a slot can take, and what the page says about it. */
export interface SlotChoiceDraft {
  key: string;
  value: string;
  description: string;
}

/** One named choice a turn can make: its `{name}`, the page's label for it, and its values. */
export interface SlotDraft {
  key: string;
  name: string;
  label: string;
  choices: SlotChoiceDraft[];
}

export interface InputsDraft {
  text: boolean;
  attachmentsAccept: string[];
  voiceAccept: string[];
  maxFiles: number | null;
  maxBytes: number | null;
  maxTurnBytes: number | null;
  /** The largest file of each type (or `type/*` family), in bytes, in place of `maxBytes`. */
  limitsByMime: Record<string, number>;
  /** Named choices a turn can make; none omits `inputs.slots`. */
  slots: SlotDraft[];
  /** Who may send the agent context; none omits `inputs.context`. */
  contextFrom: ContextSender[];
  /** The longest context package from each sender, in characters of JSON. */
  contextMaxChars: number | null;
}

/** The reply shapes a slot's value picks; any other value takes the outputs' own schema. */
export interface SlotShapesDraft {
  slot: string;
  shapes: { choice: string; schemaId: string; schemaJson: string }[];
}

export interface OutputsDraft {
  mode: 'text' | 'structured';
  schemaId: string;
  schemaJson: string;
  bySlot?: SlotShapesDraft;
  /** `''` omits it (kernel default: SSE). */
  streamMode: '' | StreamMode;
  streamThoughts: boolean;
  validationEnabled: boolean;
  maxRetries: number | null;
  /** What a refused item of a list does, by the list's path. The check on the item is code. */
  itemRules: Record<string, ItemRuleOnFail>;
  repairGuidance: string;
}

export type ItemRuleOnFail = ProfileItemRule['onFail'];

export interface TurnBehaviourDraft {
  resumeEnabled: boolean;
  allowContinue: ContinueStopKind[];
  autoContinue: ContinueStopKind[];
  maxContinues: number | null;
  continueInstruction: string;
  allowSteering: boolean;
  atStepLimit: StepLimitMode;
}

/** What a URL detector lets through besides the URLs the model was given. */
export interface UrlAllowDraft {
  hosts: string[];
  fromTools: boolean;
}

/** One pattern of the builder's own: a regular expression, or words matched whole. */
export interface PatternDraft {
  name: string;
  kind: 'pattern' | 'words';
  /** The regular expression's source, while `kind` is `pattern`. */
  pattern: string;
  /** Its flags, from `i`, `m`, `s`, and `u`. */
  flags: string;
  /** The words, while `kind` is `words`. */
  words: string[];
}

/** Whose patterns a detector reads with: Theorem's, the builder's, both, or neither. */
export interface PatternSourceDraft {
  theorem: boolean;
  patterns: PatternDraft[];
  /** What a retry tells the model about a match of the builder's patterns. `''` keeps the labels'. */
  hint: string;
}

/** A detector of the builder's own, read with its patterns. */
export interface OwnDetectorDraft {
  /** `namespace.name`. */
  key: string;
  label: string;
  /** What it does with a match, at every boundary. */
  at: Record<Boundary, DetectAction>;
  patterns: PatternDraft[];
  /** What a retry tells the model about a match. `''` keeps the labels'. */
  hint: string;
}

export interface GuardrailsDraft {
  /** The note that binds the canary, while `canary_leak` reads somewhere. */
  canaryBindNote: string;
  /** What each detector does with a match, at every boundary. */
  detect: Record<Detector, Record<Boundary, DetectAction>>;
  /** Whose patterns each detector that reads with patterns uses, by detector. */
  sources: Record<string, PatternSourceDraft>;
  /** Detectors of the builder's own. */
  own: OwnDetectorDraft[];
  quotaEnabled: boolean;
  quotaPerDay: number | null;
  quotaMessage: string;
  /** What `ungiven_images` and `ungiven_links` let through. */
  allow: Record<UrlDetector, UrlAllowDraft>;
  /** The names of tools and parameters `tool_leak` lets through. */
  innocentNames: string[];
  /** `''` omits it (kernel default: retry). */
  blockedReplyOnBlock: BlockedReplyOnBlock | '';
  /** `null` omits it (kernel default: 1). */
  blockedReplyMaxRetries: number | null;
  egressRepairGuidance: string;
  /** What the user reads in place of a refused reply. `''` keeps the labels'. */
  egressRefusal: string;
  allowPrivateNetworks: boolean;
  allowedHosts: string[];
  /** Empty omits it: https, plus http with private networks. */
  allowedSchemes: string[];
  /** `''` omits it (kernel default: off). */
  taintAfterRemoteRead: TaintGate | '';
  /** `''` omits it (kernel default: off). */
  taintRemoteDestination: DestinationGate | '';
}

export interface ObservabilityDraft {
  /** The store traces go to, or `false` when they are off. */
  writeTo: false | string;
  /** The store they go to when they are on: the studio's, or the one a project's profile names. */
  destination: string;
  sampleRate: number;
  include: {
    upstreamLog: boolean;
    outboundWire: boolean;
    evidenceRaw: boolean;
    usage: boolean;
    guardrailDecisions: boolean;
    guardrailMatchPreview: boolean;
  };
  scrub: {
    sensitive: ScrubSwitch;
    injection: ScrubSwitch;
    canary: ScrubSwitch;
  };
  retainForDays: number | null;
  rotateAfterMiB: number | null;
  /** Attributes on every trace, as a JSON object; blank omits it. */
  resourceJson: string;
}

/** A pinned reference image: a file's bytes, or a link to one. */
export type ImageReferenceDraft =
  | { key: string; name: string; mimeType: string; data: string }
  | { key: string; uri: string; name?: string };

export interface ImageDraft {
  aspectRatio: string;
  resolution: string;
  mimeType: string;
  /** Provider vocabularies (OpenRouter: auto, low, medium, high); blank is the provider default. */
  quality: string;
  /** Provider vocabularies (OpenRouter: auto, transparent, opaque); blank is the provider default. */
  background: string;
  n: number | null;
  seed: number | null;
  outputCompression: number | null;
  includeText: boolean;
  references: ImageReferenceDraft[];
}

export interface SpeechDraft {
  voice: string;
  /** How the script is delivered; blank gives no direction. */
  style: string;
  /** The speaking rate; `null` keeps the voice's own pace. */
  speed: number | null;
  format: '' | SpeechAudioFormat;
}

export interface LiveDraft {
  ingressAudio: boolean;
  ingressVideo: boolean;
  ingressText: boolean;
  voice: string;
  sessionResumption: boolean;
  /** The prompt a new call opens with, so the agent speaks first; blank omits it. */
  greeting: string;
  /** The prompt a resumed call opens with; blank omits `live.resumed`. */
  resumedPrompt: string;
  resumedAfterMs: number | null;
  /** Context window compression by sliding window; the two numbers are its trigger and target. */
  contextCompression: boolean;
  compressionTriggerTokens: number | null;
  compressionTargetTokens: number | null;
  transcriptionInput: boolean;
  transcriptionOutput: boolean;
  vadActivityHandling: '' | LiveActivityHandling;
  vadStartSensitivity: '' | LiveStartSensitivity;
  vadEndSensitivity: '' | LiveEndSensitivity;
  vadPrefixPaddingMs: number | null;
  vadSilenceDurationMs: number | null;
}

export type DecisionQuestionType = 'choice' | 'score' | 'noul' | 'box';

/** A choice's option or a number's named criterion (`label`), or a score's level (`text` only). */
export interface DecisionCriterionDraft {
  key: string;
  label: string;
  text: string;
}

export interface DecisionQuestionDraft {
  key: string;
  id: string;
  type: DecisionQuestionType;
  instructions: string;
  /** A score's levels run from 0 at the top. */
  criteria: DecisionCriterionDraft[] /** A box's image: one of the decision's images, such as `<ghs02>`, or a state field. Unset, the instructions say. */;
  image?: string;
}

/** A picture a decision can send, which the questions write as its name in angle brackets. */
export interface DecisionImageDraft {
  key: string;
  /** The reference without its brackets: `ghs02` is written `<ghs02>`. */
  name: string;
  mimeType: string;
  data: string;
}

/** A decision profile and the questions it asks. The state they are asked about is typed where it runs, not saved. */
export interface DecisionDraft {
  contract: string;
  /** `null` is the studio's most. */
  maxStateBytes: number | null;
  questions: DecisionQuestionDraft[];
  /** The application builds the questions for each decision, with the builder the setup's `questions` names. The draft holds none. */
  questionsBuilt?: true;
  images: DecisionImageDraft[];
}

/** Wording the author replaced, by labels key; a key left out keeps the kernel's line. */
export type LabelsDraft = Partial<Record<LabelKey, string>>;

/** Wording held beside the setting it words; each line has one value, so it edits that field. */
export const INLINE_LABELS: Partial<Record<LabelKey, ProfileGraphFacetId>> = {
  'continue.instruction': 'turnBehaviour',
  'canary.bind_note': 'guardrails',
  'quota.exhausted': 'guardrails',
  'repair.default_guidance': 'outputs',
  'egress.default_repair_guidance': 'guardrails',
  'egress.refusal': 'guardrails',
};

export interface StudioDraft {
  identity: IdentityDraft;
  /** Optional spine facets the author added (`PROFILE_GRAPH` rows with `optional`). */
  included: ProfileGraphFacetId[];
  models: ModelsDraft;
  modelBindings: ModelBindingDraft[];
  /** The providers its models pick from: the workspace's. */
  providers: StudioProvider[];
  tools: ToolsDraft;
  toolSpecs: ToolSpecDraft[];
  inputs: InputsDraft;
  outputs: OutputsDraft;
  turnBehaviour: TurnBehaviourDraft;
  guardrails: GuardrailsDraft;
  observability: ObservabilityDraft;
  image: ImageDraft;
  speech: SpeechDraft;
  live: LiveDraft;
  decision: DecisionDraft;
  labels: LabelsDraft;
}

export function draftKey(
  prefix:
    | 'agent'
    | 'line'
    | 'model'
    | 'tool'
    | 'question'
    | 'criterion'
    | 'reference'
    | 'image'
    | 'slot'
    | 'choice',
): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function defaultModelBinding(partial?: Partial<ModelBindingDraft>): ModelBindingDraft {
  return {
    key: draftKey('model'),
    modelId: 'fast',
    protocol: 'openRouterOpenAi',
    provider: 'openrouter',
    apiId: '',
    options: {},
    timeoutMs: null,
    efforts: [],
    defaultEffort: '',
    allowEffortSelect: false,
    summaries: null,
    maxOutputTokens: null,
    temperature: null,
    builtInTools: [],
    ...partial,
  };
}

const STUB_TOOL_DESCRIPTION = 'Studio stub tool — returns a fixed result.';

export function defaultToolSpec(partial?: Partial<ToolSpecDraft>): ToolSpecDraft {
  return {
    key: draftKey('tool'),
    toolName: 'my_tool',
    toolType: 'function',
    description: STUB_TOOL_DESCRIPTION,
    category: 'studio',
    access: TOOL_ACCESS[0],
    permission: TOOL_PERMISSION[0],
    loadTier: TOOL_LOAD_TIERS[0],
    paths: ['*'],
    inputJson: DEFAULT_TOOL_INPUT_SCHEMA,
    outputJson: DEFAULT_TOOL_OUTPUT_SCHEMA,
    ...partial,
  };
}

/**
 * The change that points an agent tool at an agent. A description that is
 * still the new tool's stub, or empty, comes to say what the tool now does.
 */
export function agentToolTarget(
  tool: ToolSpecDraft,
  agentKey: string,
  agentId: string,
): Partial<ToolSpecDraft> {
  const isStub = !tool.description.trim() || tool.description === STUB_TOOL_DESCRIPTION;
  return isStub && agentId
    ? { agentKey, description: `Asks ${agentId} and returns its answer.` }
    : { agentKey };
}

/** A pattern to fill in. */
export function newPattern(): PatternDraft {
  return { name: '', kind: 'words', pattern: '', flags: '', words: [] };
}

/** A detector of the builder's own to fill in: it reads nowhere until a boundary is set. */
export function newOwnDetector(): OwnDetectorDraft {
  return {
    key: '',
    label: '',
    at: recordOf(BOUNDARIES, () => 'ignore' as const),
    patterns: [newPattern()],
    hint: '',
  };
}

function defaultGuardrails(): GuardrailsDraft {
  const resolved = resolveGuardrailPolicy(undefined);
  return {
    canaryBindNote: '',
    detect: recordOf(DETECTORS, (detector) => ({ ...resolved.detect[detector] })),
    sources: Object.fromEntries(
      PATTERN_DETECTORS.map((detector) => [detector, { theorem: true, patterns: [], hint: '' }]),
    ),
    own: [],
    quotaEnabled: false,
    quotaPerDay: null,
    quotaMessage: '',
    allow: {
      ungiven_images: { hosts: [], fromTools: true },
      ungiven_links: { hosts: [], fromTools: true },
    },
    innocentNames: [],
    blockedReplyOnBlock: '',
    blockedReplyMaxRetries: null,
    egressRepairGuidance: '',
    egressRefusal: '',
    allowPrivateNetworks: false,
    allowedHosts: [],
    allowedSchemes: [],
    taintAfterRemoteRead: '',
    taintRemoteDestination: '',
  };
}

function defaultObservability(): ObservabilityDraft {
  // why: every draft writes this block, and the kernel reads one that is written with these.
  const resolved = resolveObservabilityPolicy({});
  return {
    writeTo: STUDIO_TRACE_DESTINATION,
    destination: STUDIO_TRACE_DESTINATION,
    sampleRate: resolved.sampleRate,
    include: { ...resolved.include },
    scrub: {
      sensitive: resolved.scrub.sensitive,
      injection: resolved.scrub.injection,
      canary: resolved.scrub.canary,
    },
    retainForDays: null,
    rotateAfterMiB: null,
    resourceJson: '',
  };
}

function criteria(entries: ReadonlyArray<[label: string, text: string]>): DecisionCriterionDraft[] {
  return entries.map(([label, text]) => ({ key: draftKey('criterion'), label, text }));
}

/** A guardrail on a tool call the agent is about to make: whether to let it run, and how much is at stake. */
export function exampleDecisionDraft(): DecisionDraft {
  return {
    contract: 'guardrails.tool_call.v1',
    maxStateBytes: null,
    questions: [
      {
        key: draftKey('question'),
        id: 'verdict',
        type: 'choice',
        instructions: 'Given what the user asked for and what the call would do, should it run?',
        criteria: criteria([
          ['allow', 'Safe, and what the user asked for.'],
          ['flag', 'Probably fine, but unusual or sensitive enough for a person to look first.'],
          ['block', 'Harmful, or clearly beyond what the user asked for.'],
        ]),
      },
      {
        key: draftKey('question'),
        id: 'risk',
        type: 'score',
        instructions: 'How much harm would this call do if it were wrong?',
        criteria: criteria([
          ['', 'Low: reversible, and affects only the user.'],
          ['', 'High: hard to undo, or affects other people or money.'],
        ]),
      },
    ],
    images: [],
  };
}

/** State the example's questions can be asked about: the field a decision preview starts with. */
export const EXAMPLE_DECISION_STATE = JSON.stringify(
  {
    context: 'The user asked the agent to tidy up old screenshots on their desktop.',
    tool_call: { name: 'delete_files', path: '~/Documents', recursive: true },
    outcome: 'Would delete 1,284 files, including tax_return_2025.pdf.',
  },
  null,
  2,
);

/** Span accepts a JSON string state; the preview starts with that shape for Span models. */
export const EXAMPLE_SPAN_DECISION_STATE = JSON.stringify(
  'The user asked to tidy screenshots. The proposed call recursively deletes 1,284 files, including a tax return.',
);

/** Documents an embedding preview starts with, one per paragraph: a small help centre in a few topics, with a couple that belong to none. */
export const EXAMPLE_EMBEDDING_TEXT = [
  'To clear your desktop, select the screenshots and move them to the Trash. Empty the Trash to delete them for good.',
  "Screen captures save to the desktop by default. You can change where they go in the Screenshot app's Options menu.",
  'Press Command-Shift-5 to record the screen or capture a window. Recordings are saved as movie files next to your screenshots.',
  'Stacks group desktop files by kind, date or tag, so a cluttered desktop folds into a few piles you can open one at a time.',
  'Deleted files stay in the Trash for 30 days. Drag a file out of the Trash to put it back where it was.',
  'When your disk is almost full, open Storage settings and review the largest files. Old downloads and installers are safe to remove.',
  'Offloading unused apps frees space and keeps their documents. Reinstalling an app brings its data back.',
  'Photos you have backed up can be optimised so the originals live in the cloud and smaller copies stay on the device.',
  'Your plan renews on the same date each month. You can see the next charge under Billing, then Upcoming invoices.',
  'To get a refund, open the invoice and choose Request refund. Charges from the last 14 days are refunded in full.',
  'Update your card under Billing, then Payment methods. The new card is used for the next renewal, not for past invoices.',
  'Annual plans cost two months less than paying monthly. Switching mid-term credits the unused months to the new plan.',
  'Invoices are emailed as PDFs and list your company name and tax number. Edit those details before the invoice is issued.',
  'Turn on two-step verification under Security. You will be asked for a code from your authenticator app each time you sign in on a new device.',
  'If you forget your password, choose Forgot password on the sign-in page. The reset link expires after one hour.',
  "Review signed-in devices under Security and sign out any you don't recognise. This ends their sessions immediately.",
  'Passkeys replace your password with your fingerprint or face. Create one under Security, then Passkeys.',
  'To close your account, export your data first. Closing deletes your workspace after a 30-day grace period.',
  'Share a folder by choosing Share, then entering an email address. Viewers can read; editors can change and delete.',
  'Public links work for anyone who has them. Set an expiry date, or turn the link off to stop sharing at once.',
  'Transfer ownership of a folder before you leave a team, or its contents will be archived with your account.',
  'Lisbon has mild, wet winters and warm, dry summers. Expect highs near 28 °C in August.',
  'The best months for the Algarve coast are May, June and September, when the beaches are warm and the crowds are thin.',
  'Trams in Lisbon climb the steep hills of Alfama and Graça. Line 28 is the famous one, and the busiest.',
  'For a crisp pizza base, preheat the oven and the baking tray together at the highest setting for at least thirty minutes.',
  'Rest steak for five minutes after cooking so the juices settle back into the meat instead of running onto the board.',
].join('\n\n');

/** The question an embedding preview starts with, nearest the first document. */
export const EXAMPLE_EMBEDDING_QUERY = 'How do I delete every screenshot on my desktop?';

/** A new question of `type`, with an id the draft doesn't use yet. */
export function newDecisionQuestion(
  draft: StudioDraft,
  type: DecisionQuestionType = 'choice',
): DecisionQuestionDraft {
  const taken = draft.decision.questions.map((question) => question.id);
  const id = freeName('question', taken, (n) => `question_${n}`);
  return { key: draftKey('question'), id, type, instructions: '', criteria: newCriteria(type) };
}

/**
 * A picture added from `file`, named after it in the way a reference is written: lowercase, with
 * `_` for anything else, and `_2`, `_3` after a name the draft has.
 */
export function newDecisionImage(
  draft: StudioDraft,
  file: string,
  image: { mimeType: string; data: string },
): DecisionImageDraft {
  const base =
    file
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'image';
  const taken = draft.decision.images.map((each) => each.name);
  const name = freeName(base, taken, (n) => `${base}_${n}`);
  return { key: draftKey('image'), name, ...image };
}

/** A new slot, with a name the draft doesn't use yet and two blank choices. */
export function newSlot(slots: readonly SlotDraft[]): SlotDraft {
  const name = freeName(
    'slot',
    slots.map((slot) => slot.name),
    (n) => `slot_${String(n)}`,
  );
  return { key: draftKey('slot'), name, label: '', choices: [newSlotChoice(), newSlotChoice()] };
}

export function newSystemLine(text = ''): SystemLineDraft {
  return { key: draftKey('line'), text };
}

export function newSlotChoice(): SlotChoiceDraft {
  return { key: draftKey('choice'), value: '', description: '' };
}

/** One blank row: an option, a level, or a criterion. */
export function newCriterion(): DecisionCriterionDraft {
  return { key: draftKey('criterion'), label: '', text: '' };
}

/** The rows a question of `type` starts with: two options, two levels, or none. */
export function newCriteria(type: DecisionQuestionType): DecisionCriterionDraft[] {
  if (type === 'noul' || type === 'box') return [];
  return criteria(
    type === 'choice'
      ? [
          ['yes', ''],
          ['no', ''],
        ]
      : [
          ['', ''],
          ['', ''],
        ],
  );
}

/**
 * An empty draft: no profile type chosen, every section at its kernel default
 * except observability, which the studio includes and points at its own
 * trace destination.
 */
export function createBlankDraft(): StudioDraft {
  return {
    identity: {
      agentId: '',
      profileType: '',
      handle: '',
      system: [newSystemLine()],
      conditionsJson: '',
    },
    included: ['observability', 'labels'],
    models: { defaultModel: '', allowModelSelect: false, maxSteps: null, key: '' },
    modelBindings: [],
    providers: [...STUDIO_PROVIDERS],
    tools: { t2Loader: '', parallel: false },
    toolSpecs: [],
    inputs: {
      text: true,
      attachmentsAccept: [],
      voiceAccept: [],
      maxFiles: null,
      maxBytes: null,
      maxTurnBytes: null,
      limitsByMime: {},
      slots: [],
      contextFrom: [],
      contextMaxChars: null,
    },
    outputs: {
      mode: 'text',
      schemaId: '',
      schemaJson: '',
      streamMode: '',
      streamThoughts: true,
      validationEnabled: false,
      maxRetries: null,
      itemRules: {},
      repairGuidance: '',
    },
    turnBehaviour: {
      resumeEnabled: false,
      allowContinue: [],
      autoContinue: [],
      maxContinues: null,
      continueInstruction: '',
      allowSteering: profileAllowsInject({ type: 'text' }),
      atStepLimit: 'stop',
    },
    guardrails: defaultGuardrails(),
    observability: defaultObservability(),
    image: {
      aspectRatio: '',
      resolution: '',
      mimeType: '',
      quality: '',
      background: '',
      n: null,
      seed: null,
      outputCompression: null,
      includeText: false,
      references: [],
    },
    speech: { voice: '', style: '', speed: null, format: '' },
    live: {
      ingressAudio: liveIngressChannelDefault('audio'),
      ingressVideo: liveIngressChannelDefault('video'),
      ingressText: liveIngressChannelDefault('text'),
      voice: '',
      sessionResumption: false,
      greeting: '',
      resumedPrompt: '',
      resumedAfterMs: null,
      contextCompression: false,
      compressionTriggerTokens: null,
      compressionTargetTokens: null,
      transcriptionInput: false,
      transcriptionOutput: false,
      vadActivityHandling: '',
      vadStartSensitivity: '',
      vadEndSensitivity: '',
      vadPrefixPaddingMs: null,
      vadSilenceDurationMs: null,
    },
    decision: exampleDecisionDraft(),
    labels: {},
  };
}

/**
 * Facets a decision draft leaves out: its only guardrail is a host's disclosure
 * hook, which a draft can't carry.
 */
const DECISION_HIDDEN_FACETS: ReadonlySet<ProfileGraphFacetId> = new Set(['guardrails']);

function facetFits(facet: (typeof PROFILE_GRAPH)[number], type: StudioProfileType): boolean {
  return (
    facet.profileTypes.includes(type) &&
    !(type === 'decision' && DECISION_HIDDEN_FACETS.has(facet.id))
  );
}

/** Required facets for the type plus the included optional ones, in catalog order. */
export function draftFacets(draft: StudioDraft): ProfileGraphFacetId[] {
  const type = draft.identity.profileType;
  if (!type) return ['identity'];
  const included = new Set(draft.included);
  return PROFILE_GRAPH.filter(
    (facet) =>
      facet.role !== 'branch' &&
      facetFits(facet, type) &&
      (!facet.optional || included.has(facet.id)),
  ).map((facet) => facet.id);
}

/** By the kernel's `PROFILE_FIELD_SCOPE`; false until a type is chosen. */
export function draftAllows(draft: StudioDraft, path: string): boolean {
  const type = draft.identity.profileType;
  return type !== '' && profileTypesForField(path).includes(type);
}

/** A canary is bound into a system prompt while `canary_leak` reads somewhere. */
export function plantsCanary(draft: StudioDraft): boolean {
  return draftAllows(draft, 'identity.system') && detects(draft.guardrails.detect, 'canary_leak');
}

export function takesContinueInstruction(draft: StudioDraft): boolean {
  const type = draft.identity.profileType;
  return type !== '' && CONTINUE_INSTRUCTION_TYPES.includes(type);
}

export function includableFacets(draft: StudioDraft): ProfileGraphFacetId[] {
  const type = draft.identity.profileType;
  if (!type) return [];
  return PROFILE_GRAPH.filter(
    (facet) =>
      facet.role === 'spine' &&
      facet.optional &&
      facetFits(facet, type) &&
      !draft.included.includes(facet.id),
  ).map((facet) => facet.id);
}

/** Inputs an image profile can take: no voice, attachments within images, video, and PDF. */
function imageInputs(inputs: InputsDraft): InputsDraft {
  return {
    ...inputs,
    attachmentsAccept: inputs.attachmentsAccept.filter((rule) =>
      mimeAllowed(IMAGE_ATTACHMENT_ACCEPT_MIMES, rule),
    ),
    voiceAccept: [],
  };
}

/** Inputs a transcription profile can take: a voice clip and nothing else. */
function transcriptionInputs(inputs: InputsDraft): InputsDraft {
  return {
    ...inputs,
    text: false,
    attachmentsAccept: [],
    voiceAccept: inputs.voiceAccept.length ? inputs.voiceAccept : ['audio/*'],
  };
}

/** Updates a binding and keeps the default model attached to it through an id change. */
export function updateModelBinding(
  draft: StudioDraft,
  bindingKey: string,
  change: Partial<ModelBindingDraft>,
): StudioDraft {
  const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return draft;
  return {
    ...draft,
    models:
      change.modelId !== undefined && draft.models.defaultModel === binding.modelId
        ? { ...draft.models, defaultModel: change.modelId }
        : draft.models,
    modelBindings: draft.modelBindings.map((candidate) =>
      candidate.key === bindingKey ? { ...candidate, ...change } : candidate,
    ),
  };
}

/**
 * The default model once the bindings change: the one it was while that is still a model, and the
 * only model when one is left, as the kernel reads a profile with one model.
 */
function defaultAmong(current: string, modelBindings: readonly ModelBindingDraft[]): string {
  if (modelBindings.some((binding) => binding.modelId === current)) return current;
  const [only, ...others] = modelBindings;
  return only && !others.length ? only.modelId : '';
}

/**
 * Drops a binding, and the default model with it when it was that one. Model select turns off
 * below two bindings, as on a type switch.
 */
export function removeModelBinding(draft: StudioDraft, bindingKey: string): StudioDraft {
  const binding = draft.modelBindings.find((candidate) => candidate.key === bindingKey);
  if (!binding) return draft;
  const modelBindings = draft.modelBindings.filter((candidate) => candidate.key !== bindingKey);
  return {
    ...draft,
    models: {
      ...draft.models,
      defaultModel: defaultAmong(draft.models.defaultModel, modelBindings),
    },
    modelBindings,
  };
}

/** A new model for the draft's type, starting where `start` puts it, or on no model yet. */
export function newModelBinding(draft: StudioDraft, start?: ModelStart): ModelBindingDraft {
  const chosen = draft.identity.profileType;
  const type = chosen && chosen !== 'host' ? chosen : 'text';
  const taken = draft.modelBindings.map((binding) => binding.modelId);
  const seed = startingBinding(type, start);
  const modelId = freeName(seed.modelId, taken, (n) => `${seed.modelId}${n}`);
  return defaultModelBinding({ ...seed, modelId });
}

export function newToolSpec(draft: StudioDraft): ToolSpecDraft {
  const taken = draft.toolSpecs.map((tool) => tool.toolName);
  return defaultToolSpec({ toolName: freeName('my_tool', taken, (n) => `my_tool_${n}`) });
}

/** `first` if nothing has taken it, else the first `nth(2)`, `nth(3)`, … that is free. */
export function freeName(
  first: string,
  taken: Iterable<string>,
  nth: (n: number) => string,
): string {
  const used = new Set(taken);
  let name = first;
  for (let n = 2; used.has(name); n++) name = nth(n);
  return name;
}

/**
 * Bindings whose model the kernel says can't serve the new type are dropped, and so are those
 * `keys` list only for another type; if none remain, a new one starts where `keys` start one. Other sections and
 * `included` are kept, so a facet the type lacks comes back when switching back. A host runs no
 * model, so it keeps the bindings for the way back.
 */
export function setProfileType(
  draft: StudioDraft,
  type: StudioProfileType,
  keys?: ModelPicks,
): StudioDraft {
  if (type === 'host') {
    return { ...draft, identity: { ...draft.identity, profileType: type } };
  }
  const kept = draft.modelBindings.filter((binding) => {
    const route = modelRoute(draft.providers, type, binding);
    const provider = draft.providers.find((each) => each.id === binding.provider);
    return (
      servesProfileType(provider, type, binding.protocol) && !listedForOthers(keys, type, route)
    );
  });
  const retyped: StudioDraft = {
    ...draft,
    identity: { ...draft.identity, profileType: type },
    modelBindings: kept,
  };
  const modelBindings = kept.length ? kept : [newModelBinding(retyped, keys?.start)];
  const needsKey = !draft.models.key && keySlotUnset({ ...retyped, modelBindings });
  // why: Gemini speaks only in a named voice, so a speech agent on it starts with one.
  const voiceless =
    type === 'speech' &&
    !draft.speech.voice.trim() &&
    modelBindings.some((binding) => isGoogleRoute(modelRoute(draft.providers, type, binding)));
  return {
    ...retyped,
    inputs:
      type === 'image'
        ? imageInputs(draft.inputs)
        : type === 'transcription'
          ? transcriptionInputs(draft.inputs)
          : draft.inputs,
    ...(voiceless ? { speech: { ...draft.speech, voice: GOOGLE_STARTING_VOICE } } : {}),
    models: {
      ...draft.models,
      defaultModel: defaultAmong(draft.models.defaultModel, modelBindings),
      key: needsKey ? DEFAULT_KEY_SLOT : draft.models.key,
    },
    modelBindings,
  };
}

/** The voice a new Gemini speech agent starts with; Google's own examples read in it. */
const GOOGLE_STARTING_VOICE = 'Kore';

const MODEL_PROFILE_TYPES: readonly ModelProfileType[] = [
  'text',
  'image',
  'speech',
  'transcription',
  'live',
  'decision',
];

/** Whether `keys` list the model for some other type, and not for `type`. */
function listedForOthers(
  keys: ModelPicks | undefined,
  type: ModelProfileType,
  route: { definition: string | undefined; apiId: string },
): boolean {
  if (!keys) return false;
  const listed = (each: ModelProfileType) =>
    keys.models(each, route.definition).some((model) => model.id === route.apiId.trim());
  return !listed(type) && MODEL_PROFILE_TYPES.some((each) => each !== type && listed(each));
}

// The slot the studio's server fills; named slots in the editor replace this.
const DEFAULT_KEY_SLOT: KeySlot = 'slot_a';

export function includeFacet(draft: StudioDraft, id: ProfileGraphFacetId): StudioDraft {
  if (!includableFacets(draft).includes(id)) return draft;
  return { ...draft, included: [...draft.included, id] };
}

/** Its values stay on the draft for when it comes back. */
export function excludeFacet(draft: StudioDraft, id: ProfileGraphFacetId): StudioDraft {
  return { ...draft, included: draft.included.filter((facet) => facet !== id) };
}
